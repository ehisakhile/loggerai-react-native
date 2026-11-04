'use strict'
// Network calls, from fetch and XMLHttpRequest (which axios uses). Both need hooking: plain React
// Native builds fetch on XMLHttpRequest, but Expo swaps in a native fetch that doesn't touch it. Calls
// to your own API (traceHosts) carry traceparent and x-loggerai-session, so LoggerAI links each tap
// to the server request it caused.

const { hex } = require('./client')
const { redact } = require('./redact')

const hostOf = (url) => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i.exec(String(url))
  return m ? m[1].toLowerCase() : ''
}
// While developing, the packager's own traffic: bundles, logs and stack symbolication.
const isPackager = (url) => /:8081\//.test(String(url))

function body(value, limit, keys) {
  if (typeof value !== 'string' || !value) return undefined
  const text = value.length > limit ? `${value.slice(0, limit)}…` : value
  try {
    return redact(JSON.parse(value), keys)
  } catch (e) {
    return redact(text, keys)
  }
}

function headers(raw) {
  const out = {}
  for (const line of String(raw || '').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return out
}

/** Headers in any form fetch takes them, as a plain object with lower-case names. */
function readHeaders(h) {
  const out = {}
  if (!h) return out
  if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { out[String(k).toLowerCase()] = v })
  else if (Array.isArray(h)) h.forEach(([k, v]) => { out[String(k).toLowerCase()] = v })
  else Object.keys(h).forEach((k) => { out[k.toLowerCase()] = h[k] })
  return out
}

/** Hooks fetch and XHR on root for client. Returns a function that undoes it. */
function captureNetwork(client, root) {
  const hosts = client.options.traceHosts.map((h) => String(h).toLowerCase())
  const { networkDetails, maxBodyBytes } = client.options
  const skip = (url) => client.isEndpoint(url) || (client.platform.dev && isPackager(url))
  const traced = (url) => hosts.includes(hostOf(url))
  const traceHeaders = (traceId) => ({ traceparent: `00-${traceId}-${hex(8)}-01`, 'x-loggerai-session': client.sessionId })
  const detailed = (status) => networkDetails === 'all' || (networkDetails === 'failures' && (!status || status >= 400))
  const record = (call, status, error, details) => {
    try {
      const p = { method: call.method, url: call.url, status: status || null, duration_ms: Date.now() - call.started, screen: client.screen }
      if (call.traceId) p.trace_id = call.traceId
      if (error) p.error = error
      if (details) {
        p.request_headers = call.headers
        const sent = body(call.body, maxBodyBytes, client.maskKeys)
        if (sent !== undefined) p.request_payload = sent
        p.response_headers = details.headers
        const got = body(details.text, maxBodyBytes, client.maskKeys)
        if (got !== undefined) p.response_data = got
      }
      client.event('network_request', p)
    } catch (e) { /* recording a call must never break it */ }
  }

  // While a fetch is starting: plain React Native's opens an XHR right then, which isn't a second call.
  let inFetch = false
  const undo = []

  const originalFetch = root.fetch
  if (originalFetch) {
    const wrapped = function (input, init) {
      const url = typeof input === 'string' ? input : String((input && input.url) || input)
      if (skip(url)) return originalFetch.call(root, input, init)
      const call = {
        method: String((init && init.method) || (input && input.method) || 'GET').toUpperCase(), url, started: Date.now(), traceId: null,
        headers: readHeaders((init && init.headers) || (input && input.headers)), body: init && init.body,
      }
      let args = init
      if (traced(url)) {
        call.traceId = hex(16)
        args = { ...init, headers: { ...call.headers, ...traceHeaders(call.traceId) } }
      }
      let started
      inFetch = true
      try {
        started = originalFetch.call(root, input, args)
      } finally {
        inFetch = false
      }
      return started.then(async (res) => {
        let details = null
        if (detailed(res.status)) {
          details = { headers: readHeaders(res.headers) }
          try {
            details.text = await res.clone().text()
          } catch (e) { /* no body to read back */ }
        }
        record(call, res.status, null, details)
        return res
      }, (e) => {
        record(call, 0, String((e && e.message) || e), detailed(0) ? { headers: {} } : null)
        throw e
      })
    }
    root.fetch = wrapped
    undo.push(() => { if (root.fetch === wrapped) root.fetch = originalFetch })
  }

  const XHR = root.XMLHttpRequest
  if (XHR && XHR.prototype) {
    const proto = XHR.prototype
    const { open, send, setRequestHeader } = proto
    proto.open = function (method, url, ...rest) {
      this.__loggerai = inFetch ? null : { method: String(method).toUpperCase(), url: String(url), headers: {} }
      return open.call(this, method, url, ...rest)
    }
    proto.setRequestHeader = function (name, value) {
      if (this.__loggerai) this.__loggerai.headers[String(name).toLowerCase()] = value
      return setRequestHeader.call(this, name, value)
    }
    proto.send = function (data) {
      const call = this.__loggerai
      if (!call || skip(call.url)) return send.call(this, data)
      call.started = Date.now()
      call.body = data
      call.traceId = null
      if (traced(call.url)) {
        call.traceId = hex(16)
        const extra = traceHeaders(call.traceId)
        Object.keys(extra).forEach((k) => setRequestHeader.call(this, k, extra[k]))
      }
      let done = false
      const finish = (error) => {
        if (done) return
        done = true
        const status = this.status
        // fetch asks for a blob; only plain text can be read back without changing the call.
        const text = !this.responseType || this.responseType === 'text' ? this.responseText : undefined
        record(call, status, error, detailed(status) ? { headers: headers(this.getAllResponseHeaders && this.getAllResponseHeaders()), text } : null)
      }
      this.addEventListener('load', () => finish())
      this.addEventListener('error', () => finish('The call failed'))
      this.addEventListener('timeout', () => finish('The call timed out'))
      this.addEventListener('abort', () => finish('The call was cancelled'))
      return send.call(this, data)
    }
    undo.push(() => {
      proto.open = open
      proto.send = send
      proto.setRequestHeader = setRequestHeader
    })
  }
  return () => undo.forEach((f) => f())
}

module.exports = { captureNetwork, hostOf }
