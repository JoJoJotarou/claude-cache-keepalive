// Keeps the main thread's 1h prompt cache warm while the session waits on a
// long tool call or sits idle. Every main-thread model request is timestamped;
// a once-a-minute check started at session.start pings when INTERVAL has
// passed since the last request or ping. A ping is $.model.fork: the main
// thread's last request re-sent with a one-line prompt, which reads the cached
// prefix and so renews its TTL. Forks stay out of the transcript and the
// host's output stream. Once MAX_PINGS run out the conversation is compacted
// while the cache is still warm. A status line under the prompt shows the
// idle-time state; each load (event "start"), ping and compaction is logged
// to <config dir>/cache-keepalive.log ($CLAUDE_CONFIG_DIR or ~/.claude).
//
// Env (settings.json `env` or the process environment):
//   CACHE_KEEPALIVE_INTERVAL_SEC  wait after the last request or ping (default 3240 = 54 min)
//   CACHE_KEEPALIVE_MAX_PINGS     pings in a row without a real request before giving up (default 6)

const LOG_KEEP_LINES = 500
const TICK_MS = 60 * 1000
const TTL_MS = 60 * 60 * 1000
const PROMPT = 'Automated prompt-cache keep-alive ping, not a user request. Reply with exactly: ok'

const state = {
  intervalMs: 3240 * 1000,
  maxPings: 6,
  lastMainAt: undefined, // last main-thread model request
  lastWarmAt: undefined, // last main request or successful ping
  pings: 0,
  stopped: true, // until the first main request
  busy: false,
  compacting: false, // the summarizer's request is not a real request
  logPath: undefined,
}

async function configure($) {
  const sec = Number(await $.env.get('CACHE_KEEPALIVE_INTERVAL_SEC'))
  const max = Number(await $.env.get('CACHE_KEEPALIVE_MAX_PINGS'))
  if (Number.isFinite(sec) && sec >= 30) state.intervalMs = sec * 1000
  if (Number.isInteger(max) && max >= 0) state.maxPings = max
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || (await $.env.get('HOME')) + '/.claude'
  state.logPath = dir.replace(/\/+$/, '') + '/cache-keepalive.log'
}

function clock(ms) {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function kTokens(n) {
  return n === undefined ? '?' : Math.round(n / 1000) + 'K'
}

async function log($, entry) {
  try {
    const LOG = state.logPath
    const line = JSON.stringify({ at: new Date().toISOString(), session: await $.session.id(), ...entry })
    const old = (await $.fs.exists(LOG)) ? await $.fs.read(LOG) : ''
    const lines = old.split('\n').filter(Boolean)
    lines.push(line)
    await $.fs.write(LOG, lines.slice(-LOG_KEEP_LINES).join('\n') + '\n')
  } catch {}
}

async function tick($) {
  if (state.stopped || state.busy || state.lastWarmAt === undefined) return
  const now = Date.now()
  if (now - state.lastWarmAt < state.intervalMs) return
  state.busy = true
  try {
    if (now - state.lastWarmAt >= TTL_MS - 2 * TICK_MS) {
      // Too late (the machine slept, say): the entry has lapsed and a ping
      // would only pay for a fresh cache write.
      state.stopped = true
      $.ui.status('stopped, cache lapsed (machine asleep?)')
      await log($, { event: 'stop', reason: 'lapsed', idleMin: Math.round((now - state.lastWarmAt) / 60000) })
      return
    }
    if (state.pings >= state.maxPings) {
      // Out of pings while the cache is still warm: compacting now reads the
      // cached prefix, far cheaper than letting it lapse and compacting cold.
      state.stopped = true
      state.compacting = true
      try {
        const r = await $.session.compact()
        $.ui.status(r.skip
          ? `compaction skipped (${r.skip})`
          : `compacted ${kTokens(r.tokensBefore)} → ${kTokens(r.tokensAfter)} at ${clock(Date.now())}`)
        await log($, {
          event: 'compact', pings: state.pings, ms: Date.now() - now, skip: r.skip,
          tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter,
          cache_read: r.usage?.cache_read_input_tokens, cache_write: r.usage?.cache_creation_input_tokens,
        })
      } catch (err) {
        // Rejects while a turn runs (a long tool call): leave it to the next request.
        $.ui.status(`stopped after ${state.pings} pings, could not compact`)
        await log($, { event: 'stop', reason: 'max-pings', pings: state.pings, compactError: String(err) })
      } finally {
        state.compacting = false
      }
      return
    }
    state.pings += 1
    const mainAt = state.lastMainAt
    const r = await $.model.fork({ prompt: PROMPT })
    const u = r.usage ?? {}
    await log($, {
      event: 'ping', pings: state.pings, ms: Date.now() - now,
      ok: r.isAnswered, reason: r.reason, status: r.status,
      cache_read: u.cache_read_input_tokens, cache_write: u.cache_creation_input_tokens,
      input: u.input_tokens, output: u.output_tokens,
    })
    if (state.lastMainAt !== mainAt) return // a real request came in meanwhile
    if ((u.cache_creation_input_tokens ?? 0) > (u.cache_read_input_tokens ?? 0)) {
      // Mostly rewritten, not read: the cache had already gone (a 5-minute TTL,
      // or a gateway that does not keep it), so pings only pay for fresh writes.
      state.stopped = true
      $.ui.status('stopped, ping missed the cache (1h TTL off?)')
      await log($, { event: 'stop', reason: 'cache-miss' })
      return
    }
    if (r.isAnswered || r.reason === 'empty-reply') {
      state.lastWarmAt = now
      const next = state.pings < state.maxPings ? 'next ping' : 'compact'
      $.ui.status(`warm, ping ${state.pings}/${state.maxPings} · ${next} ${clock(now + state.intervalMs)}`)
    } else {
      state.stopped = true // api-error, nothing-to-fork, aborted: wait for the next real request
      $.ui.status(`ping failed (${r.reason}), stopped`)
    }
  } finally {
    state.busy = false
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await configure($)
      $.clock.every(TICK_MS, () => { tick($).catch(() => {}) })
      await log($, { event: 'start', intervalSec: state.intervalMs / 1000, maxPings: state.maxPings })
    } catch {}
    return next(e)
  })

  // Any other compaction of the main conversation (/compact, the threshold):
  // the cache it leaves behind is for the old transcript, so stop until the
  // next real request.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    state.compacting = true
    try {
      return await next(e)
    } finally {
      state.compacting = false
      state.stopped = true
    }
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && !state.compacting) {
      state.lastMainAt = state.lastWarmAt = Date.now()
      state.pings = 0
      state.stopped = false
      $.ui.status(undefined)
    }
    return yield* next(e)
  })
}
