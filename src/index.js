'use strict'
// LoggerAI for React Native.
//
//   import * as LoggerAI from '@loggerai/react-native'
//   LoggerAI.init({ publicKey: 'pk_live_...', release: '1.4.2', traceHosts: ['api.shop.com'] })

const { AppState, Dimensions, Platform } = require('react-native')
const { Client, LoggerAIReportError } = require('./client')
const { captureErrors } = require('./errors')
const { captureNetwork } = require('./network')
const { ErrorBoundary, ReportSheet, MyReportsSheet, useScreen, bind } = require('./ui')

let client = null
// Kept on the global: a hot reload runs this file again, and the old hooks must still come off.
const STOP = '__loggeraiStop'

const platform = {
  dev: typeof __DEV__ !== 'undefined' && __DEV__,
  os: () => `${Platform.OS} ${Platform.Version}`,
  size: () => Dimensions.get('window'),
  fetch: (...args) => globalThis.fetch(...args),
  get FormData() { return globalThis.FormData },
}

/** Starts LoggerAI. Call it once, as early as you can (index.js or the top of App). */
function init(options) {
  close()
  client = new Client(options || {}, platform)
  if (!client.enabled) return false
  client.start()
  const stop = [captureErrors(client, { ErrorUtils: globalThis.ErrorUtils, hermes: globalThis.HermesInternal, dev: platform.dev })]
  if (client.options.captureNetwork) stop.push(captureNetwork(client, globalThis))
  const sub = AppState.addEventListener('change', (state) => client && client.lifecycle(state))
  stop.push(() => sub.remove())
  const started = client
  stop.push(() => started.close())
  globalThis[STOP] = stop
  return true
}

function close() {
  ;(globalThis[STOP] || []).forEach((f) => f())
  globalThis[STOP] = null
  if (client) client.close()
  client = null
}

const isStarted = () => !!client && client.enabled
const sessionId = () => (client ? client.sessionId : null)

/** Report an error you caught but still want to see. */
function captureException(error, context) {
  if (client) client.error(error, { handled: true, context })
}

/** Something worth having in the session's timeline. */
function track(name, data) {
  if (client) client.event('custom_event', { name, ...data })
}

/**
 * Count the session against a user: pass an opaque id, never an email or a name. hash is the
 * signature of the id from your server: with it the user sees their reports on any device.
 */
function setUser(id, { hash } = {}) {
  if (!client) return
  client.user = id === null || id === undefined ? null : String(id)
  client.userHash = client.user ? hash || null : null
}

/** The screen the user is on, when you don't use trackNavigation. */
function setScreen(name) {
  if (!client || !name || client.screen === name) return
  const from = client.screen
  client.screen = name
  client.event('page_view', { url: name, title: name, ...(from ? { from } : {}) })
}

/** Records each screen from a React Navigation ref. Returns a function that stops it. */
function trackNavigation(ref) {
  const read = () => {
    const route = ref.getCurrentRoute && ref.getCurrentRoute()
    if (route) setScreen(route.name)
  }
  read()
  return ref.addListener('state', read)
}

const flush = () => (client ? client.flush() : Promise.resolve())

function report(note, options) {
  return client ? client.report(note, options) : Promise.reject(new LoggerAIReportError("LoggerAI isn't started."))
}

function myReports() {
  return client ? client.myReports() : Promise.reject(new LoggerAIReportError("LoggerAI isn't started."))
}

bind({ captureException, setScreen, report, myReports, captureScreen: () => client && client.options.captureScreen })

module.exports = {
  init, close, isStarted, sessionId, captureException, track, setUser, setScreen, trackNavigation, flush, report, myReports,
  ErrorBoundary, ReportSheet, MyReportsSheet, useScreen, LoggerAIReportError,
}
