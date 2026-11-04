'use strict'
// What people see: the error boundary, the report sheet and "My reports". Plain React Native
// components, so nothing here needs a native module.

const React = require('react')
const { ActivityIndicator, FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } = require('react-native')

const h = React.createElement
let sdk = {}
const bind = (api) => { sdk = api }

/** Catches errors while rendering, reports them, and shows `fallback` instead of a blank screen. */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { failed: false, error: null }
    this.reset = () => this.setState({ failed: false, error: null })
  }

  static getDerivedStateFromError(error) {
    return { failed: true, error }
  }

  componentDidCatch(error, info) {
    sdk.captureException(error, { component_stack: info && info.componentStack, boundary: true })
  }

  render() {
    if (!this.state.failed) return this.props.children
    const { fallback } = this.props
    return typeof fallback === 'function' ? fallback({ error: this.state.error, reset: this.reset }) : fallback === undefined ? null : fallback
  }
}

/** Names the screen while this component is shown; for Expo Router, pass usePathname(). */
function useScreen(name) {
  React.useEffect(() => { sdk.setScreen(name) }, [name])
}

const LABEL = { open: 'Received', investigating: 'Being looked at', resolved: 'Resolved' }

function Button({ label, onPress, color, solid, disabled, testID }) {
  return h(Pressable, { onPress, disabled, testID, accessibilityRole: 'button', style: [s.button, solid ? { backgroundColor: color } : { borderColor: color, borderWidth: 1 }, disabled && s.off] },
    h(Text, { style: [s.buttonText, { color: solid ? '#fff' : color }] }, label))
}

function Sheet({ visible, onClose, title, children, dark, right }) {
  return h(Modal, { visible, transparent: true, animationType: 'slide', onRequestClose: onClose },
    h(KeyboardAvoidingView, { behavior: Platform.OS === 'ios' ? 'padding' : undefined, style: s.scrim },
      h(Pressable, { style: s.flex, onPress: onClose, accessibilityLabel: 'Close' }),
      h(View, { style: [s.sheet, dark && s.sheetDark] },
        h(View, { style: s.header }, h(Text, { style: [s.title, dark && s.light], accessibilityRole: 'header' }, title), right),
        children)))
}

/**
 * "Report a problem": the user says what went wrong, and can add screenshots if you gave init a
 * captureScreen function. Your team gets an issue with it and the session's steps.
 */
function ReportSheet({ visible, onClose, title = 'Report a problem', hint = 'What went wrong?', askContact = false, color = '#0b7350', dark = false, showMyReports = true }) {
  const [note, setNote] = React.useState('')
  const [contact, setContact] = React.useState('')
  const [shots, setShots] = React.useState([])
  const [sending, setSending] = React.useState(false)
  const [taking, setTaking] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [sent, setSent] = React.useState(null)
  const [mine, setMine] = React.useState(false)
  const capture = sdk.captureScreen && sdk.captureScreen()

  const done = () => {
    setNote('')
    setContact('')
    setShots([])
    setError(null)
    setSent(null)
    onClose()
  }
  const send = async () => {
    if (!note.trim()) return setError('Tell us what went wrong.')
    setSending(true)
    setError(null)
    try {
      setSent({ id: await sdk.report(note.trim(), { screenshots: shots, contact: askContact ? contact : undefined }) })
    } catch (e) {
      setError(e.message)
    }
    setSending(false)
  }
  const screenshot = async () => {
    setTaking(true) // the sheet steps aside so it isn't in the picture
    await new Promise((r) => setTimeout(r, 350))
    try {
      const uri = await capture()
      if (uri) setShots((x) => [...x, uri].slice(0, 5))
    } catch (e) {
      setError("Couldn't take the screenshot.")
    }
    setTaking(false)
  }

  if (mine) return h(MyReportsSheet, { visible, onClose: () => setMine(false), color, dark })
  const input = [s.input, dark && s.inputDark]
  const placeholder = dark ? '#8a948f' : '#6b7a72'
  return h(Sheet, {
    visible: visible && !taking, onClose: done, title, dark,
    right: showMyReports && !sent ? h(Pressable, { onPress: () => setMine(true), accessibilityRole: 'button' }, h(Text, { style: { color, fontWeight: '600' } }, 'My reports')) : null,
  }, sent
    ? h(View, { testID: 'loggerai-report-sent' },
      h(Text, { style: [s.big, dark && s.light] }, 'The team has your report'),
      h(Text, { style: [s.muted, dark && s.mutedDark] }, `They have your note and what happened in the app before it.${sent.id ? ` Report #${sent.id}.` : ''}`),
      h(Button, { label: 'Done', onPress: done, color, solid: true }))
    : h(ScrollView, { keyboardShouldPersistTaps: 'handled' },
      h(TextInput, { testID: 'loggerai-report-text', value: note, onChangeText: setNote, placeholder: hint, placeholderTextColor: placeholder, multiline: true, maxLength: 2000, style: [...input, s.note], accessibilityLabel: hint }),
      askContact && h(TextInput, { value: contact, onChangeText: setContact, placeholder: 'Your email, if we may reply (optional)', placeholderTextColor: placeholder, keyboardType: 'email-address', autoCapitalize: 'none', style: input }),
      shots.length > 0 && h(View, { style: s.shots }, shots.map((uri, i) => h(Pressable, { key: uri, accessibilityLabel: `Remove screenshot ${i + 1}`, onPress: () => setShots((x) => x.filter((u) => u !== uri)) }, h(Image, { source: { uri }, style: s.shot })))),
      capture && shots.length < 5 && h(Button, { label: 'Take a screenshot', onPress: screenshot, color, disabled: sending }),
      capture && h(Text, { style: [s.small, dark && s.mutedDark] }, 'Screenshots show everything on the screen. Tap one to remove it.'),
      error && h(Text, { style: s.error, accessibilityLiveRegion: 'polite' }, error),
      h(Button, { testID: 'loggerai-report-send', label: sending ? 'Sending…' : 'Send', onPress: send, color, solid: true, disabled: sending })))
}

/** "My reports": what this user sent, and where each one is. */
function MyReportsSheet({ visible, onClose, title = 'My reports', color = '#0b7350', dark = false }) {
  const [items, setItems] = React.useState(null)
  const [error, setError] = React.useState(null)
  const load = React.useCallback(() => {
    setError(null)
    setItems(null)
    sdk.myReports().then(setItems, (e) => setError(e.message))
  }, [])
  React.useEffect(() => { if (visible) load() }, [visible, load])
  return h(Sheet, { visible, onClose, title, dark },
    error
      ? h(View, null, h(Text, { style: s.error }, error), h(Button, { label: 'Try again', onPress: load, color }))
      : !items
        ? h(ActivityIndicator, { color, style: s.loading })
        : items.length === 0
          ? h(Text, { style: [s.muted, dark && s.mutedDark] }, 'No reports yet. If something goes wrong, tell us from Report a problem.')
          : h(FlatList, {
            data: items, keyExtractor: (r) => String(r.id), style: s.list,
            renderItem: ({ item }) => h(View, { style: s.row },
              h(View, { style: s.flex }, h(Text, { numberOfLines: 2, style: [s.rowTitle, dark && s.light] }, item.title), h(Text, { style: [s.small, dark && s.mutedDark] }, `Report #${item.id}`)),
              h(Text, { style: { color, fontWeight: '600', fontSize: 13 } }, LABEL[item.status] || item.status)),
          }))
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 32, maxHeight: '85%' },
  sheetDark: { backgroundColor: '#161f1c' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { fontSize: 20, fontWeight: '700', color: '#0a1410' },
  big: { fontSize: 18, fontWeight: '700', color: '#0a1410', marginBottom: 6 },
  light: { color: '#eaf2ee' },
  muted: { fontSize: 15, lineHeight: 21, color: '#46564e', marginBottom: 16 },
  mutedDark: { color: '#b0c0b8' },
  small: { fontSize: 13, color: '#64756c', marginTop: 6 },
  input: { borderWidth: 1, borderColor: '#dde6e1', borderRadius: 12, padding: 12, fontSize: 16, color: '#0a1410', marginBottom: 12 },
  inputDark: { borderColor: '#2a3732', color: '#eaf2ee' },
  note: { minHeight: 110, textAlignVertical: 'top' },
  button: { minHeight: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, marginTop: 10 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  off: { opacity: 0.5 },
  error: { color: '#dc2626', marginTop: 10, fontSize: 14 },
  shots: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  shot: { width: 54, height: 96, borderRadius: 8, backgroundColor: '#e1e9e4' },
  loading: { marginVertical: 32 },
  list: { maxHeight: 420 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: '#0a1410' },
})

module.exports = { ErrorBoundary, ReportSheet, MyReportsSheet, useScreen, bind }
