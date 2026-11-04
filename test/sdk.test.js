'use strict'
const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

// React Native, as far as the SDK uses it.
let appState
const RN = {
  AppState: { addEventListener: (_, fn) => { appState = fn; return { remove() { appState = null } } } },
  Dimensions: { get: () => ({ width: 390, height: 844 }) },
  Platform: { OS: 'ios', Version: '18.1' },
  StyleSheet: { create: (x) => x },
}
for (const n of ['ActivityIndicator', 'FlatList', 'Image', 'KeyboardAvoidingView', 'Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View']) RN[n] = n
const load = Module._load
Module._load = function (request, ...rest) {
  if (request === 'react-native') return RN
  if (request === 'react') return { Component: class {}, createElement() {}, useEffect() {} }
  return load.call(this, request, ...rest)
}

// React Native's XMLHttpRequest and the calls it makes.
class XHR {
  constructor() { this.listeners = {}; this.sentHeaders = {}; this.status = 0; this.responseType = ''; this.responseText = '' }
  open(method, url) { this.url = url }
  setRequestHeader(k, v) { this.sentHeaders[k] = v }
  addEventListener(t, f) { this.listeners[t] = f }
  getAllResponseHeaders() { return 'content-type: application/json\r\nset-cookie: a=b\r\n' }
  send() { XHR.last = this }
  respond(status, text) { this.status = status; this.responseText = text; this.listeners.load() }
  fail() { this.listeners.error() }
}

let sent, answer, handler
globalThis.fetch = async (url, init) => {
  sent.push({ url, init })
  const res = { status: answer, headers: {}, clone: () => ({ text: async () => '' }), json: async () => ({ id: 42, reports: [{ id: 1, title: 'x', status: 'open', created_at: 't' }] }) }
  return res
}
globalThis.FormData = class { constructor() { this.parts = [] } append(k, v) { this.parts.push([k, v]) } }
globalThis.XMLHttpRequest = XHR
globalThis.ErrorUtils = { getGlobalHandler: () => handler, setGlobalHandler: (h) => { handler = h } }
globalThis.__DEV__ = false

const L = require('../src/index')
const batches = () => sent.filter((s) => String(s.url).endsWith('/ingest/batch')).map((s) => JSON.parse(s.init.body))
const start = (o) => L.init({ publicKey: 'pk_test_1', flushInterval: 1e6, ...o })
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn() } finally { console.warn = w } }

beforeEach(() => { sent = []; answer = 202; handler = () => {} })
afterEach(() => L.close())

test('does nothing without a public key, or with a secret key', () => {
  assert.equal(quiet(() => L.init({})), false)
  assert.equal(quiet(() => L.init({ publicKey: 'sk_live_x' })), false)
  assert.equal(L.init({ publicKey: 'pk_x', enabled: false }), false)
  assert.equal(L.isStarted(), false)
})

test('sends the session, screens and events in the format the server reads', async () => {
  start({ release: '1.2.0', service: 'mobile' })
  L.setUser(7)
  L.setScreen('Cart')
  L.setScreen('Cart') // the same screen again is no new step
  L.setScreen('Checkout')
  L.track('coupon_applied', { coupon: 'SAVE10', email: 'a@b.co' })
  await L.flush()
  const [b] = batches()
  assert.deepEqual(b.sdk, { name: 'loggerai-react-native', version: '0.1.0' })
  assert.equal(b.service, 'mobile')
  assert.equal(b.release, '1.2.0')
  assert.equal(b.environment, 'production')
  assert.equal(sent[0].init.headers['X-LoggerAI-Key'], 'pk_test_1')
  assert.deepEqual({ ...b.sessions[0], started_at: 0 }, { id: L.sessionId(), started_at: 0, ended_at: null, page: 'Checkout', browser: 'React Native app 1.2.0', os: 'ios 18.1', device: 'mobile', screen: [390, 844], user: '7' })
  assert.deepEqual(b.events.map((e) => e.type), ['page_view', 'page_view', 'custom_event'])
  assert.equal(b.events[1].payload.from, 'Cart')
  assert.equal(b.events[2].payload.email, '[REDACTED]')
  await L.flush()
  assert.equal(batches().length, 1) // nothing new, nothing sent
  L.track('again')
  await L.flush()
  assert.equal(batches()[1].sessions, undefined) // the session goes once
})

test('keeps what is waiting when LoggerAI cannot be reached, and stops on a refused key', async () => {
  start()
  L.track('one')
  answer = 503
  await L.flush()
  answer = 202
  await L.flush()
  assert.equal(batches()[1].events.length, 1)
  assert.ok(batches()[1].sessions)
  L.track('two')
  answer = 401
  await quiet(() => L.flush())
  assert.equal(sent.length, 3)
  L.track('three')
  await L.flush()
  assert.equal(sent.length, 3)
})

test('uncaught errors go out with their frames and reach the previous handler', async () => {
  const seen = []
  handler = (e, fatal) => seen.push([e.message, fatal])
  start()
  L.setScreen('Checkout')
  const e = new TypeError('no client_secret for ada@shop.co')
  e.stack = 'TypeError: x\n    at pay (http://10.0.0.2:8081/index.bundle?platform=ios:120:8)\n    at apply (node_modules/react-native/Libraries/Core/x.js:3:1)'
  globalThis.ErrorUtils.getGlobalHandler()(e, false)
  await L.flush()
  const [b] = batches()
  assert.deepEqual(seen, [['no client_secret for ada@shop.co', false]])
  const err = b.errors[0]
  assert.equal(err.type, 'TypeError')
  assert.equal(err.message, 'no client_secret for [REDACTED_EMAIL]')
  assert.equal(err.method, 'MOBILE')
  assert.equal(err.route, 'Checkout')
  assert.equal(err.handled, false)
  assert.deepEqual(err.frames[0], { file: 'http://10.0.0.2:8081/index.bundle', line: 120, function: 'pay', class: null, in_app: true })
  assert.equal(err.frames[1].in_app, false)
  assert.equal(err.context.session_id, L.sessionId())
  assert.equal(b.events.find((x) => x.type === 'app_error').payload.source, 'http://10.0.0.2:8081/index.bundle:120')
})

test('a fatal error is sent before the app is allowed to die', async () => {
  const order = []
  handler = () => order.push('died')
  const f = globalThis.fetch
  globalThis.fetch = async (...a) => { order.push('sent'); return f(...a) }
  start()
  globalThis.ErrorUtils.getGlobalHandler()(new Error('boom'), true)
  await new Promise((r) => setTimeout(r, 20))
  globalThis.fetch = f
  assert.deepEqual(order, ['sent', 'died'])
})

test('a crash that could not be sent goes out on the next launch', async () => {
  const data = new Map()
  const storage = { getItem: async (k) => data.get(k) ?? null, setItem: async (k, v) => { data.set(k, v) }, removeItem: async (k) => { data.delete(k) } }
  answer = 503
  handler = () => {}
  start({ storage })
  globalThis.ErrorUtils.getGlobalHandler()(new Error('boom'), true)
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(data.get('loggerai.pending'))
  L.close()
  sent = []
  answer = 202
  start({ storage })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(batches()[0].errors[0].message, 'boom')
  assert.equal(data.has('loggerai.pending'), false)
})

test('promises nobody handled are caught through Hermes', async () => {
  let tracker
  globalThis.HermesInternal = { enablePromiseRejectionTracker: (t) => { tracker = t } }
  start()
  assert.equal(tracker.allRejections, true)
  tracker.onUnhandled(1, new RangeError('late'))
  tracker.onUnhandled(2, 'just a string')
  await L.flush()
  delete globalThis.HermesInternal
  const [b] = batches()
  assert.equal(b.errors[0].type, 'RangeError')
  assert.equal(b.errors[0].context.source, 'promise')
  assert.equal(b.errors[1].message, 'just a string')
})

test('anything thrown is reported: objects from an API too', async () => {
  start()
  L.captureException({ message: 'Bad gateway', code: 502 }, { basket: 12 })
  L.captureException({ code: 502 })
  L.captureException(null)
  await L.flush()
  const e = batches()[0].errors
  assert.equal(e[0].message, 'Bad gateway')
  assert.equal(e[0].handled, true)
  assert.equal(e[0].context.basket, 12)
  assert.equal(e[1].message, '{"code":502}')
  assert.equal(e[2].message, 'null')
})

test('records calls once, adds trace headers only for your own API, and masks them', async () => {
  start({ traceHosts: ['api.shop.com'], maskKeys: ['safety_id'] })
  L.setScreen('Cart')
  const own = new XMLHttpRequest()
  own.open('post', 'https://user:pw@api.shop.com:443/v1/pay?token=abc&page=2')
  own.setRequestHeader('Authorization', 'Bearer abcdefghijklmnop')
  own.send(JSON.stringify({ password: 'x', safety_id: 'q', qty: 2 }))
  assert.match(own.sentHeaders.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  assert.equal(own.sentHeaders['x-loggerai-session'], L.sessionId())
  own.respond(500, '{"error":"no","email":"a@b.co"}')

  const other = new XMLHttpRequest()
  other.open('GET', 'https://cdn.example.com/a.png')
  other.send()
  assert.equal(other.sentHeaders.traceparent, undefined)
  other.respond(200, 'ok')

  const failed = new XMLHttpRequest()
  failed.open('GET', 'https://cdn.example.com/b.png')
  failed.send()
  failed.fail()

  await L.flush()
  const calls = batches()[0].events.filter((e) => e.type === 'network_request').map((e) => e.payload)
  assert.equal(calls.length, 3)
  const [a, b, c] = calls
  assert.equal(a.method, 'POST')
  assert.equal(a.url, 'https://[REDACTED]@api.shop.com:443/v1/pay?token=[REDACTED]&page=2')
  assert.equal(a.status, 500)
  assert.equal(a.screen, 'Cart')
  assert.equal(a.trace_id, own.sentHeaders.traceparent.split('-')[1])
  assert.equal(a.request_headers.authorization, '[REDACTED]')
  assert.deepEqual(a.request_payload, { password: '[REDACTED]', safety_id: '[REDACTED]', qty: 2 })
  assert.deepEqual(a.response_data, { error: 'no', email: '[REDACTED]' })
  assert.equal(a.response_headers['set-cookie'], '[REDACTED]')
  assert.equal(b.request_headers, undefined) // a call that worked keeps no details
  assert.equal(c.status, null)
  assert.equal(c.error, 'The call failed')
})

test('fetch that does not use XHR, as in Expo, is recorded with its trace headers', async () => {
  start({ traceHosts: ['api.shop.com'] })
  answer = 500
  const res = await fetch('https://api.shop.com/v1/pay?token=abc', { method: 'POST', headers: { Authorization: 'Bearer abcdefghijklmnop' }, body: '{"qty":2}' })
  assert.equal(res.status, 500) // the app gets the answer untouched
  const traced = sent[sent.length - 1].init.headers
  assert.match(traced.traceparent, /^00-/)
  assert.equal(traced['x-loggerai-session'], L.sessionId())
  assert.equal(traced.authorization, 'Bearer abcdefghijklmnop') // the app's own headers still go
  answer = 202
  await L.flush()
  const calls = batches()[0].events.filter((e) => e.type === 'network_request').map((e) => e.payload)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url, 'https://api.shop.com/v1/pay?token=[REDACTED]')
  assert.equal(calls[0].status, 500)
  assert.equal(calls[0].trace_id, traced.traceparent.split('-')[1])
  assert.deepEqual(calls[0].request_payload, { qty: 2 })
  assert.equal(calls[0].request_headers.authorization, '[REDACTED]')
})

test('a failed fetch is recorded and still rejects', async () => {
  const f = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('down.example')) throw new TypeError('Network request failed')
    return f(url, init)
  }
  start()
  await assert.rejects(fetch('https://down.example.com/x'), /Network request failed/)
  await L.flush()
  L.close()
  globalThis.fetch = f
  const [c] = batches()[0].events.filter((e) => e.type === 'network_request').map((e) => e.payload)
  assert.equal(c.status, null)
  assert.equal(c.error, 'Network request failed')
})

test('a hot reload runs the file again without stacking the hooks', async () => {
  start()
  const fresh = require.resolve('../src/index')
  delete require.cache[fresh]
  const again = require('../src/index')
  again.init({ publicKey: 'pk_test_1', flushInterval: 1e6, traceHosts: ['api.shop.com'] })
  const x = new XMLHttpRequest()
  x.open('GET', 'https://api.shop.com/a')
  x.send()
  x.respond(200, '')
  await again.flush()
  again.close()
  assert.equal(x.sentHeaders.traceparent.split(',').length, 1)
  assert.equal(batches()[0].events.filter((e) => e.type === 'network_request').length, 1)
  assert.equal(XMLHttpRequest.prototype.open, XHR.prototype.open)
})

test('plain React Native: a fetch built on XHR is recorded once', async () => {
  const f = globalThis.fetch
  globalThis.fetch = (url, init) => { // what whatwg-fetch does: opens an XHR while starting
    const x = new XMLHttpRequest()
    x.open((init && init.method) || 'GET', url)
    x.send()
    return f(url, init)
  }
  start()
  await fetch('https://api.shop.com/a')
  await L.flush()
  L.close()
  globalThis.fetch = f
  assert.equal(batches()[0].events.filter((e) => e.type === 'network_request').length, 1)
})

test('LoggerAI calls are not recorded, and close puts XHR back', async () => {
  const open = XMLHttpRequest.prototype.open
  start({ endpoint: 'https://logs.test/ingest/batch' })
  assert.notEqual(XMLHttpRequest.prototype.open, open)
  const x = new XMLHttpRequest()
  x.open('POST', 'https://logs.test/ingest/batch')
  x.send('{}')
  x.status = 200
  assert.equal(x.listeners.load, undefined)
  L.close()
  assert.equal(XMLHttpRequest.prototype.open, XHR.prototype.open)
})

test('a real API path that sounds like tooling is recorded', async () => {
  start()
  const x = new XMLHttpRequest()
  x.open('GET', 'https://api.shop.com/logs/status')
  x.send()
  x.respond(200, '')
  await L.flush()
  assert.equal(batches()[0].events.length, 1)
})

test('the background: flushes, and a long absence starts a new session', async () => {
  start({ sessionTimeout: 0 })
  const first = L.sessionId()
  appState('inactive') // iOS, on the way somewhere: not recorded
  appState('background')
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(batches()[0].events[0].payload.state, 'paused')
  appState('active')
  assert.notEqual(L.sessionId(), first)
})

test('trackNavigation follows a React Navigation ref', () => {
  let listener
  const route = { name: 'Home' }
  const ref = { getCurrentRoute: () => route, addListener: (_, fn) => { listener = fn; return () => { listener = null } } }
  start()
  const stop = L.trackNavigation(ref)
  route.name = 'Cart'
  listener()
  stop()
  assert.equal(listener, null)
  return L.flush().then(() => {
    assert.deepEqual(batches()[0].events.map((e) => e.payload.url), ['Home', 'Cart'])
  })
})

test('reports go after the session, with the screenshot files', async () => {
  answer = 201
  start({ release: '1.2.0' })
  L.setScreen('Checkout')
  assert.equal(await L.report('It broke, call +234 803 123 4567', { screenshots: ['file:///a.png'], contact: ' a@b.co ' }), 42)
  const post = sent[sent.length - 1]
  assert.equal(post.url, 'https://loggerapp.ehigiator.com/api/v1/ingest/report')
  assert.equal(post.init.headers['Content-Type'], undefined) // fetch sets the multipart boundary
  const parts = post.init.body.parts
  const r = JSON.parse(parts[0][1])
  assert.equal(r.note, 'It broke, call [REDACTED_PHONE]')
  assert.equal(r.platform, 'react-native')
  assert.equal(r.device, 'mobile · ios 18.1')
  assert.equal(r.contact, 'a@b.co')
  assert.equal(r.session_id, L.sessionId())
  assert.deepEqual(parts[1], ['screenshot', { uri: 'file:///a.png', name: 'screenshot-1.png', type: 'image/png' }])
  assert.ok(batches()[0].events.some((e) => e.payload.name === 'issue_reported'))
})

test('reports say what went wrong in words for the user', async () => {
  start()
  answer = 429
  await assert.rejects(L.report('x'), (e) => e instanceof L.LoggerAIReportError && /Too many/.test(e.message))
  L.close()
  await assert.rejects(L.report('x'), /isn't started/)
})

test('myReports asks for this device\'s reports', async () => {
  const data = new Map([['loggerai.reporter', 'device-1']])
  answer = 200
  start({ storage: { getItem: async (k) => data.get(k) ?? null, setItem: async () => {}, removeItem: async () => {} } })
  const [r] = await L.myReports()
  assert.deepEqual(r, { id: 1, title: 'x', status: 'open', createdAt: 't', updatedAt: null, resolvedAt: null })
  const post = sent[sent.length - 1]
  assert.equal(post.url, 'https://loggerapp.ehigiator.com/api/v1/ingest/my-reports')
  assert.equal(JSON.parse(post.init.body).reporter, 'device-1')
})
