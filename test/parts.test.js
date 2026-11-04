'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { frames } = require('../src/frames')
const { redact, redactString, redactUrl } = require('../src/redact')
const { hostOf } = require('../src/network')

test('reads Hermes, release and JavaScriptCore stacks', () => {
  const f = frames(`Error: x
    at Cart.checkout (http://localhost:8081/index.bundle//&platform=ios:42:7)
    at anonymous (native)
    at pay (address at index.android.bundle:1:123456)
    at async run (/app/src/run.js:9:2)
    at ?anon_0_ (InternalBytecode.js:1:1)`)
  assert.deepEqual(f[0], { file: 'http://localhost:8081/index.bundle', line: 42, function: 'checkout', class: 'Cart', in_app: true })
  assert.equal(f[1].in_app, false)
  assert.deepEqual(f[2], { file: 'index.android.bundle', line: 1, function: 'pay', class: null, in_app: true })
  assert.equal(f[3].function, 'run')
  assert.equal(f[4].in_app, false)
  const j = frames('checkout@main.jsbundle:1:500\n[native code]')
  assert.deepEqual(j, [{ file: 'main.jsbundle', line: 1, function: 'checkout', class: null, in_app: true }])
  assert.deepEqual(frames(null), [])
})

test("a message with an @ in it isn't a frame", () => {
  assert.deepEqual(frames('TypeError: render failed for ada@shop.co\n    at Bomb (App.js:7:38)').map((f) => f.file), ['App.js'])
})

test('appPaths narrows what counts as your code', () => {
  const f = frames('Error\n at a (/app/src/a.js:1:1)\n at b (/app/vendor/b.js:1:1)', ['/app/src'])
  assert.deepEqual(f.map((x) => x.in_app), [true, false])
})

test('masks by shape and by key, as the other SDKs do', () => {
  assert.equal(redactString('mail ada@shop.co now'), 'mail [REDACTED_EMAIL] now')
  assert.equal(redactString('call 0803 123 4567'), 'call [REDACTED_PHONE]')
  assert.equal(redactString('at 6.524379,3.379206'), 'at [REDACTED_LOCATION]')
  assert.equal(redactString('Bearer abcdefghijklmnopq'), 'Bearer [REDACTED]')
  assert.match(redactString('eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeK'), /REDACTED_JWT/)
  assert.deepEqual(redact({ userLat: 1, first_name: 'Ada', send_email: true, qty: 2, nested: [{ apiKey: 'k' }], note: '' }),
    { userLat: '[REDACTED]', first_name: '[REDACTED]', send_email: true, qty: 2, nested: [{ apiKey: '[REDACTED]' }], note: '' })
  assert.equal(redactUrl('https://a.co/x?ll=6.5,3.3&page=2#top'), 'https://a.co/x?ll=[REDACTED]&page=2#top')
})

test('finds a host without URL, which React Native does not fully have', () => {
  assert.equal(hostOf('https://u:p@API.Shop.com:8443/x?y=1'), 'api.shop.com')
  assert.equal(hostOf('/relative'), '')
})
