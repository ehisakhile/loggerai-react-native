'use strict'
// Errors nothing else caught: React Native's global handler, and promises nobody handled.

/** Hooks both for client. Returns a function that undoes it. */
function captureErrors(client, { ErrorUtils, hermes, dev }) {
  const undo = []
  if (ErrorUtils && ErrorUtils.setGlobalHandler) {
    const previous = ErrorUtils.getGlobalHandler && ErrorUtils.getGlobalHandler()
    const handler = (error, isFatal) => {
      client.error(error, { source: isFatal ? 'fatal' : 'global' })
      if (!isFatal || dev) {
        client.flush()
        if (previous) previous(error, isFatal)
        return
      }
      // The default handler ends the app, so give the crash a moment to leave first.
      client.crash().then(() => previous && previous(error, isFatal), () => previous && previous(error, isFatal))
    }
    ErrorUtils.setGlobalHandler(handler)
    undo.push(() => { if (ErrorUtils.getGlobalHandler && ErrorUtils.getGlobalHandler() === handler) ErrorUtils.setGlobalHandler(previous) })
  }
  if (hermes && hermes.enablePromiseRejectionTracker) {
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (id, error) => {
        client.error(error, { source: 'promise' })
        // This replaces React Native's own tracker, so keep its warning while developing.
        if (dev) console.warn('Possible unhandled promise rejection:', error)
      },
      onHandled: () => {},
    })
  }
  return () => undo.forEach((f) => f())
}

module.exports = { captureErrors }
