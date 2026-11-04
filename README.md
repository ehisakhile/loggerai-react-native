# LoggerAI for React Native

Crash reporting and session recording for React Native and Expo apps, in the same place as your
server's monitoring, with AI that explains what went wrong.

- **Crashes and errors**, grouped by cause with their stack: uncaught errors, promises nobody
  handled, render errors through `ErrorBoundary`, and ones you report yourself.
- **Sessions**: the screens people visit, their network calls (`fetch`, axios, XMLHttpRequest), the
  app going to the background and back, and your own events, in order.
- **Linked to your server**: calls to your own API carry `traceparent` and `x-loggerai-session`, so
  LoggerAI shows the exact server request behind a failed tap (with LoggerAI's Laravel, Python,
  Node.js or Java SDK on the server).
- **Report a problem**: people say what went wrong, with screenshots if you add them. The team gets
  an issue with the session's steps, and a message in Slack.

Secrets (passwords, tokens, cookies, API keys, JWTs), personal details (phone numbers, emails,
addresses, names like `first_name`, dates of birth) and locations are masked before anything leaves
the app. Bodies are kept only for failed calls, masked the same way.

Pure JavaScript with no native code, so it works in Expo Go and needs no rebuild.
React Native 0.70+ on iOS and Android.

## Install

```bash
npm install @loggerai/react-native
```

Use your project's **public key** (`pk_live_...`, from LoggerAI → your project → **Connect**). It's
safe to ship in the app: it can only send sessions, events and errors. Never put the secret key in
an app.

```js
// index.js, or the top of App
import * as LoggerAI from '@loggerai/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'

LoggerAI.init({
  publicKey: 'pk_live_...',
  release: '1.4.2',               // your app version: "since release X"
  traceHosts: ['api.shop.com'],   // your own API, to link calls to server requests
  storage: AsyncStorage,          // optional: keeps crashes across a restart, and this device's reports
})
```

Without `storage` everything still works, but a crash that can't be sent before the app closes is
lost, and "My reports" only knows about this run.

## Name screens

React Navigation:

```js
const ref = useNavigationContainerRef()
<NavigationContainer ref={ref} onReady={() => LoggerAI.trackNavigation(ref)}>
```

Expo Router, in your root layout:

```js
LoggerAI.useScreen(usePathname())
```

Anywhere else: `LoggerAI.setScreen('Cart')`.

## Catch render errors

```js
<LoggerAI.ErrorBoundary fallback={({ reset }) => <Button title="Try again" onPress={reset} />}>
  <App />
</LoggerAI.ErrorBoundary>
```

## More

```js
// An error you caught but still want to see
LoggerAI.captureException(error, { basket: basket.id })

// Count the session against a user: an opaque id, never an email or a name
LoggerAI.setUser(user.id)

// Something worth seeing in the timeline
LoggerAI.track('coupon_applied', { coupon: 'SAVE10' })
```

## Report a problem

```js
const [open, setOpen] = useState(false)

<Button title="Report a problem" onPress={() => setOpen(true)} />
<LoggerAI.ReportSheet visible={open} onClose={() => setOpen(false)} askContact />
```

Pass `color` for your brand colour and `dark` for a dark sheet. **My reports** on the sheet shows what
the user sent and where each report is; `MyReportsSheet` is the same list on its own.

For screenshots, give `init` a function that returns a file address, such as
[react-native-view-shot](https://github.com/gre/react-native-view-shot)'s:

```js
import { captureScreen } from 'react-native-view-shot'

LoggerAI.init({ publicKey: 'pk_live_...', captureScreen: () => captureScreen({ format: 'png', result: 'tmpfile' }) })
```

**Screenshots aren't masked**: they show whatever is on the screen, including text in fields, so
they're only taken when the user asks and the sheet says so. Leave `captureScreen` out to turn them
off.

Your own UI instead of the sheet:

```js
try {
  await LoggerAI.report(note, { screenshots: [uri], contact })
} catch (e) {
  showError(e.message) // in words for the user
}
```

## Options

| Option | Default | |
| --- | --- | --- |
| `publicKey` | | Required. |
| `service` | `app` | Names the app in LoggerAI. |
| `environment` | `development` in dev builds, otherwise `production` | |
| `release` | | Your app's version or build. |
| `traceHosts` | `[]` | Hosts of your own API. |
| `captureNetwork` | `true` | Record network calls. |
| `networkDetails` | `failures` | Headers and bodies on `failures`, `all` or `none`. |
| `maxBodyBytes` | `4096` | |
| `maskKeys` | `[]` | More field names to mask. |
| `appPaths` | `[]` | Parts of a file path that mark your own code. |
| `flushInterval` | `10000` | Milliseconds between sends. |
| `sessionTimeout` | 30 minutes | Time away, in milliseconds, before a new session. |
| `enabled` | `true` | |

## What it doesn't do yet

- **Release stack traces are minified.** A release build's frames point into the bundle, with
  shortened names. Source map upload isn't available yet, so errors from release builds are harder
  to read than the same errors in development.
- **Native crashes** (in Objective-C, Swift, Java or Kotlin code) aren't caught, only JavaScript ones.
- **No visual replay**: a session is a timeline of steps, not a recording of the screen.
- **Unhandled promises** are caught on Hermes, React Native's default engine, not on JavaScriptCore.

## Licence

MIT
