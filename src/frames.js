'use strict'
// Stack frames for an error, innermost first, with the app's own code marked (in_app) so LoggerAI
// groups errors by where they happened in your code.
//
//   at checkout (http://localhost:8081/index.bundle?platform=ios:1234:56)   Hermes or V8, debug
//   at checkout (address at index.android.bundle:1:123456)                  Hermes, release
//   at anonymous (native)
//   checkout@main.jsbundle:1:123456                                         JavaScriptCore

const V8 = /^\s*at (?:(.*?) \()?(?:address at )?(.+?)(?::(\d+))?(?::(\d+))?\)?\s*$/
// No spaces: an error's own message can hold an @ ("failed for ada@shop.co") and isn't a frame.
const JSC = /^([^\s@]*)@(\S+?)(?::(\d+))?(?::(\d+))?$/
const LIBRARY = /node_modules\/|\/Libraries\/|\/react-native\/|InternalBytecode|^native$|\[native code\]/

function inApp(file, appPaths) {
  if (!file || LIBRARY.test(file)) return false
  return !appPaths || !appPaths.length || !/\//.test(file) || appPaths.some((p) => file.includes(p))
}

function frames(stack, appPaths, limit = 50) {
  if (!stack) return []
  const out = []
  for (const raw of String(stack).split('\n')) {
    const line = raw.trim()
    if (!line || (!line.startsWith('at ') && !line.includes('@'))) continue
    const m = line.startsWith('at ') ? V8.exec(line) : JSC.exec(line)
    if (!m) continue
    const file = m[2].replace(/(\?|\/\/&).*$/, '') // the dev server's bundle address runs on with its options
    const name = (m[1] || '<anonymous>').replace(/^(new|async) /, '')
    const dot = name.lastIndexOf('.')
    out.push({
      file,
      line: Number(m[3]) || 0,
      function: dot > 0 ? name.slice(dot + 1) : name,
      class: dot > 0 ? name.slice(0, dot) : null,
      in_app: inApp(file, appPaths),
    })
    if (out.length >= limit) break
  }
  return out
}

module.exports = { frames, inApp }
