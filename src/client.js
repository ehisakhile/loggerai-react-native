'use strict'
// The buffer, the session, and the timer that sends batches. Nothing here throws into the app; when
// LoggerAI can't be reached, what's waiting is kept for the next try, within the buffer's limits.

const { frames } = require('./frames')
const { normalizeKey, redact, redactString } = require('./redact')
const VERSION = require('./version')

const DEFAULT_ENDPOINT = 'https://loggerapp.ehigiator.com/api/v1/ingest/batch'
const MAX_EVENTS = 1000
const MAX_ERRORS = 100
const REPORTER_KEY = 'loggerai.reporter'
const PENDING_KEY = 'loggerai.pending'

/** A report couldn't be sent: message says why, in words for the user. */
class LoggerAIReportError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LoggerAIReportError'
  }
}

// Ids to tell things apart, not secrets. Plain React Native has no crypto, so Math.random stands in.
function bytes(n) {
  const out = new Uint8Array(n)
  const c = globalThis.crypto
  if (c && c.getRandomValues) return c.getRandomValues(out)
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256)
  return out
}
const hex = (n) => Array.from(bytes(n), (b) => b.toString(16).padStart(2, '0')).join('')
function uuid() {
  const b = bytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const now = () => Date.now() / 1000
const cut = (s, n) => (s.length > n ? s.slice(0, n) : s)

class Client {
  constructor(options, platform) {
    this.options = {
      endpoint: DEFAULT_ENDPOINT, service: 'app', environment: platform.dev ? 'development' : 'production', release: null, traceHosts: [],
      appPaths: [], captureNetwork: true, flushInterval: 10000, sessionTimeout: 30 * 60 * 1000, enabled: true, networkDetails: 'failures',
      maxBodyBytes: 4096, maskKeys: [], storage: null, captureScreen: null, ...options,
    }
    this.platform = platform
    const key = this.options.publicKey || ''
    this.enabled = this.options.enabled !== false && key.startsWith('pk_')
    if (this.options.enabled !== false && !key.startsWith('pk_')) {
      console.warn('LoggerAI: apps use the public key (pk_live_...), never the secret one. Not sending.')
    }
    this.reportEndpoint = this.options.reportEndpoint || this.options.endpoint.replace(/\/batch\/?$/, '/report')
    this.maskKeys = new Set(this.options.maskKeys.map(normalizeKey))
    this.events = []
    this.errors = []
    this.screen = null
    this.user = null
    this.userHash = null
    this.lastError = null
    this.timer = null
    this.sending = null
    this.backgroundSince = null
    this.newSession()
  }

  /** A call to LoggerAI itself, which is never recorded. */
  isEndpoint(url) {
    const u = String(url).split('?')[0]
    return u === this.options.endpoint || u === this.reportEndpoint || u === this.reportEndpoint.replace(/\/report$/, '/my-reports')
  }

  start() {
    if (!this.enabled || this.timer) return
    this.timer = setInterval(() => this.flush(), this.options.flushInterval)
    this.resend()
  }

  newSession() {
    this.sessionId = uuid()
    this.sessionStart = now()
    this.sessionSent = false
  }

  // ---- recording ---------------------------------------------------------------------------

  event(type, payload) {
    if (!this.enabled) return
    this.events.push({ session_id: this.sessionId, ts: now(), type, payload: redact(payload, this.maskKeys) })
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
  }

  error(error, { handled = false, context, source } = {}) {
    if (!this.enabled) return
    // Anything can be thrown: an Error, a string, or an object from an API.
    const e = error && typeof error === 'object' && 'message' in error ? error : { name: 'Error', message: typeof error === 'string' ? error : safeJson(error), stack: null }
    const type = e.name || (e.constructor && e.constructor.name) || 'Error'
    const message = cut(redactString(e.message || ''), 1000)
    const fr = frames(e.stack, this.options.appPaths)
    this.errors.push({
      ts: now(), type, message, handled, route: this.screen, method: 'MOBILE', status: null, frames: fr,
      context: { ...redact({ ...context, ...(source ? { source } : {}) }, this.maskKeys), session_id: this.sessionId },
    })
    if (this.errors.length > MAX_ERRORS) this.errors.shift()
    const top = fr.find((f) => f.in_app) || fr[0]
    this.event('app_error', { message: `${type}: ${cut(message, 500)}`, source: top ? `${top.file}:${top.line}` : source, handled })
  }

  // ---- the session -------------------------------------------------------------------------------

  sessionInfo() {
    const { width, height } = this.platform.size()
    const shortest = Math.min(width, height)
    return {
      id: this.sessionId, started_at: this.sessionStart, ended_at: null, page: this.screen,
      browser: `React Native app${this.options.release ? ` ${this.options.release}` : ''}`,
      os: this.platform.os(), device: shortest >= 600 ? 'tablet' : 'mobile',
      screen: width ? [Math.round(width), Math.round(height)] : null, user: this.user,
    }
  }

  /** The app moved to the background or came back: the same names the Flutter SDK uses. */
  lifecycle(state) {
    const away = state === 'background'
    if (away && this.backgroundSince === null) this.backgroundSince = Date.now()
    if (state === 'active' && this.backgroundSince !== null) {
      if (Date.now() - this.backgroundSince > this.options.sessionTimeout) this.newSession()
      this.backgroundSince = null
    }
    if (state === 'active' || away) this.event('app_lifecycle', { state: away ? 'paused' : 'resumed' })
    if (away) this.flush()
  }

  // ---- sending ------------------------------------------------------------------------------------

  /** Sends what's waiting. Safe to call any time. */
  flush() {
    if (!this.enabled) return Promise.resolve()
    if (!this.sending) this.sending = this.send().finally(() => { this.sending = null })
    return this.sending
  }

  body(events, errors, withSession) {
    return {
      sdk: { name: 'loggerai-react-native', version: VERSION }, service: this.options.service, environment: this.options.environment,
      release: this.options.release, host: this.platform.os(), ...(withSession ? { sessions: [this.sessionInfo()] } : {}), events, errors,
    }
  }

  post(body) {
    return this.platform.fetch(this.options.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LoggerAI-Key': this.options.publicKey }, body: JSON.stringify(body),
    })
  }

  async send() {
    if (!this.events.length && !this.errors.length) return
    const events = this.events.slice()
    const errors = this.errors.slice()
    const withSession = !this.sessionSent
    try {
      const r = await this.post(this.body(events, errors, withSession))
      if (r.status === 401 || r.status === 403) {
        this.enabled = false // a wrong key won't start working by retrying
        console.warn(`LoggerAI: the key was refused (${r.status}). Check the public key; sending stopped.`)
      }
      this.lastError = r.status < 300 ? null : `LoggerAI answered ${r.status}`
      if (r.status < 500 && r.status !== 429) {
        this.events.splice(0, events.length)
        this.errors.splice(0, errors.length)
        if (withSession && r.status < 300) this.sessionSent = true
      }
    } catch (e) {
      this.lastError = `couldn't reach LoggerAI: ${e}`
    }
  }

  /**
   * The app is about to die. Saves what's waiting, if there's storage, then tries to send it, so a
   * crash that beats the network still arrives on the next launch.
   */
  async crash(wait = 2000) {
    if (!this.enabled) return
    const store = this.options.storage
    const saved = store ? safe(() => store.setItem(PENDING_KEY, JSON.stringify(this.body(this.events.slice(-100), this.errors, true)))) : null
    await Promise.race([Promise.resolve(saved).then(() => this.flush()), new Promise((done) => setTimeout(done, wait))])
    if (store && !this.errors.length) await safe(() => store.removeItem(PENDING_KEY))
  }

  /** What a crash left behind on the last run. */
  async resend() {
    const store = this.options.storage
    if (!store) return
    try {
      const pending = await store.getItem(PENDING_KEY)
      if (!pending) return
      const r = await this.post(JSON.parse(pending))
      if (r.status < 500 && r.status !== 429) await store.removeItem(PENDING_KEY)
    } catch (e) { /* the next launch tries again */ }
  }

  // ---- reports ------------------------------------------------------------------------------------

  /** A random id kept on this device: the user's reports here, when they aren't signed in. */
  async reporterId() {
    if (this.reporter) return this.reporter
    const store = this.options.storage
    try {
      this.reporter = store ? await store.getItem(REPORTER_KEY) : null
      if (!this.reporter) {
        this.reporter = uuid()
        if (store) await store.setItem(REPORTER_KEY, this.reporter)
      }
    } catch (e) {
      this.reporter = this.reporter || uuid() // no storage here: this run only
    }
    return this.reporter
  }

  /** Sends a problem the user reported, with what they did before it. Returns the issue's id. */
  async report(note, { screenshots = [], contact, extra } = {}) {
    if (!this.enabled) throw new LoggerAIReportError('Reporting is switched off in this app.')
    this.event('custom_event', { name: 'issue_reported', note, screen: this.screen })
    await this.flush() // the session and its steps first, so the issue links to them
    const s = this.sessionInfo()
    const form = new this.platform.FormData()
    form.append('report', JSON.stringify({
      session_id: this.sessionId, note: redactString(note), screen: this.screen, user: this.user,
      ...(this.userHash ? { user_hash: this.userHash } : {}), reporter: await this.reporterId(),
      ...(contact && contact.trim() ? { contact: contact.trim() } : {}), platform: 'react-native', device: `${s.device} · ${s.os}`,
      release: this.options.release, environment: this.options.environment, service: this.options.service,
      ...(extra ? { extra: redact(extra, this.maskKeys) } : {}),
    }))
    screenshots.slice(0, 5).forEach((uri, i) => form.append('screenshot', { uri, name: `screenshot-${i + 1}.png`, type: 'image/png' }))
    let r
    try {
      r = await this.platform.fetch(this.reportEndpoint, { method: 'POST', headers: { 'X-LoggerAI-Key': this.options.publicKey }, body: form })
    } catch (e) {
      throw new LoggerAIReportError("Couldn't send the report. Check your connection and try again.")
    }
    if (r.status === 201) {
      try {
        return (await r.json()).id
      } catch (e) {
        return 0
      }
    }
    if (r.status === 429) throw new LoggerAIReportError('Too many reports right now. Try again in a little while.')
    if (r.status === 413) throw new LoggerAIReportError('The screenshots are too big to send. Remove one and try again.')
    throw new LoggerAIReportError(`Couldn't send the report (${r.status}).`)
  }

  /** The reports this user sent: all of theirs with a user hash, otherwise the ones from this device. */
  async myReports() {
    if (!this.enabled) throw new LoggerAIReportError('Reporting is switched off in this app.')
    const url = this.reportEndpoint.replace(/\/report\/?$/, '/my-reports')
    let r
    try {
      r = await this.platform.fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LoggerAI-Key': this.options.publicKey },
        body: JSON.stringify({ reporter: await this.reporterId(), ...(this.user ? { user: this.user } : {}), ...(this.userHash ? { user_hash: this.userHash } : {}) }),
      })
    } catch (e) {
      throw new LoggerAIReportError("Couldn't load your reports. Check your connection and try again.")
    }
    if (r.status !== 200) throw new LoggerAIReportError(`Couldn't load your reports (${r.status}).`)
    return ((await r.json()).reports || []).map((x) => ({
      id: x.id, title: x.title || '', status: x.status || 'open', createdAt: x.created_at, updatedAt: x.updated_at || null, resolvedAt: x.resolved_at || null,
    }))
  }

  close() {
    clearInterval(this.timer)
    this.timer = null
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v) || String(v)
  } catch (e) {
    return String(v)
  }
}

function safe(fn) {
  try {
    return Promise.resolve(fn()).catch(() => null)
  } catch (e) {
    return null
  }
}

module.exports = { Client, LoggerAIReportError, DEFAULT_ENDPOINT, hex, uuid }
