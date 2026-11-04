'use strict'
// Masks secrets and personal details before anything leaves the app: by key name (fields, headers,
// query parameters) and by shape (bearer tokens, JWTs, emails and phone numbers anywhere in a
// string). The same rules as LoggerAI's server, browser script and other SDKs.

const MASK = '[REDACTED]'

const WORDS = new Set(['password', 'passwd', 'pwd', 'pass', 'passphrase', 'secret', 'token', 'otp', 'pin', 'cvv', 'cvc',
  'ssn', 'cookie', 'authorization', 'auth', 'signature', 'sig', 'credential', 'credentials', 'bvn', 'nin',
  // where someone is: user_lat, userLng, pickup_latitude... (analytics never keep locations)
  'lat', 'lng', 'lon', 'latitude', 'longitude', 'coords', 'coordinates', 'geolocation', 'gps'])
const JOINED = ['apikey', 'accesskey', 'privatekey', 'secretkey', 'cardnumber', 'clientsecret', 'sessionid',
  'authtoken', 'accesstoken', 'refreshtoken', 'idtoken', 'csrftoken', 'xsrf', 'setcookie',
  'latlng', 'latlon', 'lnglat', 'lonlat', 'geopoint']
// Who someone is and where they live: masked when the value is text or a number (so flags like
// send_email: true stay readable).
const PERSONAL = new Set(['phone', 'phones', 'telephone', 'tel', 'mobile', 'msisdn', 'whatsapp', 'email', 'emails',
  'address', 'addresses', 'street', 'postcode', 'postcodes', 'zip', 'dob', 'birthday', 'birthdate', 'surname', 'iban'])
const PERSONAL_JOINED = ['phonenumber', 'emailaddress', 'firstname', 'lastname', 'fullname', 'middlename', 'givenname', 'familyname',
  'displayname', 'contactname', 'dateofbirth', 'postalcode', 'postcode', 'zipcode', 'accountnumber']
const URL_EXTRA = new Set(['key', 'code', 'access_token', 'id_token', 'll', 'location']) // ?ll=6.52,3.37 (maps)
const URL_KEYS = new Set(['url', 'href', 'referrer', 'referer', 'location'])

// Lookbehind isn't in every JavaScript engine an app can run on (old JavaScriptCore), and a bad
// literal would stop the whole bundle loading, so these are built here, with simpler ones to fall back on.
function pattern(source, flags, fallback) {
  try {
    return new RegExp(source, flags)
  } catch (e) {
    return new RegExp(fallback, flags)
  }
}

const SPLIT = pattern('[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])', '', '[^A-Za-z0-9]+')
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
const BEARER = /\b(bearer|basic|token)\s+[A-Za-z0-9\-._~+/]{12,}=*/gi
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
// +234 803 123 4567, +44 20 7946 0958, and Nigerian mobiles written locally (0803 123 4567)
const PHONE = pattern('(?<![\\w+])\\+\\d{1,3}[\\s-]?\\d{2,4}[\\s-]?\\d{3,4}[\\s-]?\\d{3,4}(?!\\d)|(?<![\\d.])0[7-9][01]\\d[\\s-]?\\d{3}[\\s-]?\\d{4}(?![\\d.])', 'g',
  '\\+\\d{1,3}[\\s-]?\\d{2,4}[\\s-]?\\d{3,4}[\\s-]?\\d{3,4}(?!\\d)|\\b0[7-9][01]\\d[\\s-]?\\d{3}[\\s-]?\\d{4}\\b')
// A latitude,longitude pair anywhere, e.g. in a path: /nearby/6.524379,3.379206
const COORDS = pattern('(?<![\\d.])-?\\d{1,3}\\.\\d{4,}\\s*(?:,|%2C)\\s*-?\\d{1,3}\\.\\d{4,}(?![\\d.])', 'gi', '-?\\b\\d{1,3}\\.\\d{4,}\\s*(?:,|%2C)\\s*-?\\d{1,3}\\.\\d{4,}\\b')

const words = (key) => String(key).split(SPLIT).filter(Boolean).map((w) => w.toLowerCase())

function isSensitive(key) {
  const w = words(key)
  if (w.some((x) => WORDS.has(x))) return true
  const joined = w.join('')
  return JOINED.some((x) => joined.includes(x))
}

function isPersonal(key) {
  const w = words(key)
  if (w.some((x) => PERSONAL.has(x))) return true
  const joined = w.join('')
  return PERSONAL_JOINED.some((x) => joined.includes(x))
}

/** A key as the maskKeys option compares it: lower case, letters and digits only. */
const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '')

function redactString(s) {
  return String(s)
    .replace(JWT, '[REDACTED_JWT]')
    .replace(EMAIL, '[REDACTED_EMAIL]')
    .replace(COORDS, '[REDACTED_LOCATION]')
    .replace(PHONE, '[REDACTED_PHONE]')
    .replace(BEARER, (m, kind) => `${kind} ${MASK}`)
}

// By hand: React Native's URL class doesn't implement most of the standard.
function redactUrl(url) {
  let out = String(url).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]+@/i, `$1${MASK}@`)
  const q = out.indexOf('?')
  if (q >= 0) {
    const hash = out.indexOf('#', q)
    const end = hash < 0 ? out.length : hash
    const pairs = out.slice(q + 1, end).split('&').map((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return pair
      let k = pair.slice(0, eq)
      try {
        k = decodeURIComponent(k.replace(/\+/g, ' '))
      } catch (e) { /* keep it as it came */ }
      const secret = eq < pair.length - 1 && (isSensitive(k) || isPersonal(k) || URL_EXTRA.has(k.toLowerCase()))
      return secret ? `${pair.slice(0, eq)}=${MASK}` : pair
    })
    out = `${out.slice(0, q + 1)}${pairs.join('&')}${out.slice(end)}`
  }
  return redactString(out)
}

/** A copy of value (objects, arrays, strings) with secrets and personal details masked. */
function redact(value, extraKeys, depth = 0) {
  if (depth > 40) return value
  if (Array.isArray(value)) return value.map((v) => redact(v, extraKeys, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      const v = value[key]
      const empty = v === null || v === undefined || v === '' || (typeof v === 'object' && Object.keys(v).length === 0)
      if (!empty && (isSensitive(key) || (extraKeys && extraKeys.has(normalizeKey(key))))) out[key] = MASK
      else if (!empty && (typeof v === 'string' || typeof v === 'number' || Array.isArray(v)) && isPersonal(key)) out[key] = MASK
      else if (typeof v === 'string' && URL_KEYS.has(key.toLowerCase())) out[key] = redactUrl(v)
      else out[key] = redact(v, extraKeys, depth + 1)
    }
    return out
  }
  if (typeof value === 'string') return /^https?:\/\//.test(value) ? redactUrl(value) : redactString(value)
  return value
}

module.exports = { MASK, isSensitive, isPersonal, normalizeKey, redact, redactString, redactUrl }
