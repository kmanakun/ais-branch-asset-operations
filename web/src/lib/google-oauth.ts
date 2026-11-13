export type GoogleAuthMode = 'google_oauth' | 'dev_fallback' | 'misconfigured'

export interface GoogleAuthEnv {
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  SESSION_SECRET?: string
}

export interface GoogleAuthConfig {
  mode: GoogleAuthMode
  clientId: string
  clientSecret: string
  sessionSecret: string
  googleEnabled: boolean
  devAuthEnabled: boolean
  misconfiguredReason?: string
}

export interface OAuthTransactionPayload {
  p: 'oauth_tx'
  state: string
  nonce: string
  codeVerifier: string
  exp: number
}

export interface SessionCookiePayload {
  p: 'session'
  email: string
  sub?: string
  iat: number
  exp: number
}

export interface VerifiedGoogleIdentity {
  email: string
  sub?: string
  exp: number
}

interface GoogleJsonWebKey extends JsonWebKey {
  kid?: string
}

interface JwksCacheEntry {
  keys: GoogleJsonWebKey[]
  fetchedAtMs: number
  lastForcedRefreshMs: number
}

export class GoogleAuthError extends Error {
  status: 400 | 401 | 403 | 502 | 503
  code: string

  constructor(status: 400 | 401 | 403 | 502 | 503, code: string, message: string) {
    super(message)
    this.name = 'GoogleAuthError'
    this.status = status
    this.code = code
  }
}

export const SESSION_COOKIE_NAME = 'ais_session'
export const OAUTH_TX_COOKIE_NAME = 'ais_oauth_tx'
export const SESSION_TTL_SECONDS = 12 * 60 * 60
export const OAUTH_TX_TTL_SECONDS = 10 * 60
export const MIN_SESSION_SECRET_LENGTH = 32

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_VALID_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000
const JWKS_FORCE_REFRESH_COOLDOWN_MS = 10 * 1000
const MAX_JWKS_CACHE_ENTRIES = 5
const MAX_TOKEN_LENGTH = 8192
const CLOCK_SKEW_SECONDS = 30

const jwksCache = new Map<string, JwksCacheEntry>()

export function clearGoogleJwksCache(): void {
  jwksCache.clear()
}

export function resolveGoogleAuthConfig(env: GoogleAuthEnv): GoogleAuthConfig {
  const clientId = (env.GOOGLE_CLIENT_ID || '').trim()
  const clientSecret = (env.GOOGLE_CLIENT_SECRET || '').trim()
  const sessionSecret = (env.SESSION_SECRET || '').trim()

  if (!clientId && !clientSecret && !sessionSecret) {
    return {
      mode: 'dev_fallback',
      clientId: '',
      clientSecret: '',
      sessionSecret: '',
      googleEnabled: false,
      devAuthEnabled: true,
    }
  }

  if (!clientId || !clientSecret || !sessionSecret) {
    return {
      mode: 'misconfigured',
      clientId,
      clientSecret,
      sessionSecret,
      googleEnabled: false,
      devAuthEnabled: false,
      misconfiguredReason: 'ต้องระบุ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET และ SESSION_SECRET ให้ครบทั้ง 3 ค่า',
    }
  }

  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    return {
      mode: 'misconfigured',
      clientId,
      clientSecret,
      sessionSecret,
      googleEnabled: false,
      devAuthEnabled: false,
      misconfiguredReason: `SESSION_SECRET ต้องมีความยาวอย่างน้อย ${MIN_SESSION_SECRET_LENGTH} ตัวอักษร`,
    }
  }

  return {
    mode: 'google_oauth',
    clientId,
    clientSecret,
    sessionSecret,
    googleEnabled: true,
    devAuthEnabled: false,
  }
}

export function resolveOAuthRedirectUri(requestUrl: string): string {
  const url = new URL(requestUrl)
  return `${url.origin}/api/auth/callback`
}

export function isSecureRequestUrl(requestUrl: string): boolean {
  const url = new URL(requestUrl)
  if (url.protocol === 'https:') return true
  return !(url.hostname === '127.0.0.1' || url.hostname === 'localhost')
}

export function serializeCookie(
  name: string,
  value: string,
  options: { path: string; maxAge: number; secure: boolean; httpOnly?: boolean; sameSite?: 'Lax' | 'Strict' },
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    `SameSite=${options.sameSite ?? 'Lax'}`,
  ]
  if (options.httpOnly !== false) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

export function readCookieValue(cookieHeader: string | null | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null
  const pairs = cookieHeader.split(';')
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=')
    if (eqIndex <= 0) continue
    const name = pair.slice(0, eqIndex).trim()
    if (name !== cookieName) continue
    const rawValue = pair.slice(eqIndex + 1).trim()
    if (!rawValue) return null
    try {
      return decodeURIComponent(rawValue)
    } catch {
      return rawValue
    }
  }
  return null
}

function encodeBase64UrlBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64UrlBytes(segment: string): Uint8Array {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new GoogleAuthError(401, 'INVALID_TOKEN', 'รูปแบบโทเค็นไม่ถูกต้อง')
  }
  const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4)
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/')
  let binary: string
  try {
    binary = atob(base64)
  } catch {
    throw new GoogleAuthError(401, 'INVALID_TOKEN', 'ไม่สามารถถอดรหัสโทเค็นได้')
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> {
  const bytes = decodeBase64UrlBytes(segment)
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected JSON object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new GoogleAuthError(401, 'INVALID_TOKEN', 'โครงสร้างข้อมูลในโทเค็นไม่ถูกต้อง')
  }
}

export function generateRandomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return encodeBase64UrlBytes(bytes)
}

export async function createPkceChallenge(codeVerifier: string): Promise<string> {
  const input = new TextEncoder().encode(codeVerifier)
  const digest = await crypto.subtle.digest('SHA-256', input)
  return encodeBase64UrlBytes(new Uint8Array(digest))
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const secretBytes = new TextEncoder().encode(secret)
  return crypto.subtle.importKey(
    'raw',
    secretBytes.buffer.slice(secretBytes.byteOffset, secretBytes.byteOffset + secretBytes.byteLength) as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function signCookiePayload(
  payload: OAuthTransactionPayload | SessionCookiePayload,
  sessionSecret: string,
): Promise<string> {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(payload))
  const payloadB64 = encodeBase64UrlBytes(jsonBytes)
  const payloadAscii = new TextEncoder().encode(payloadB64)
  const key = await importHmacKey(sessionSecret)
  const sigBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    payloadAscii.buffer.slice(payloadAscii.byteOffset, payloadAscii.byteOffset + payloadAscii.byteLength) as ArrayBuffer,
  )
  return `${payloadB64}.${encodeBase64UrlBytes(new Uint8Array(sigBuffer))}`
}

export async function verifyCookiePayload<T extends OAuthTransactionPayload | SessionCookiePayload>(
  cookieValue: string | null | undefined,
  expectedPurpose: T['p'],
  sessionSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<T | null> {
  if (!cookieValue || cookieValue.length > MAX_TOKEN_LENGTH) return null
  const parts = cookieValue.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null

  const [payloadB64, sigB64] = parts
  try {
    const key = await importHmacKey(sessionSecret)
    const sigBytes = decodeBase64UrlBytes(sigB64)
    const payloadAscii = new TextEncoder().encode(payloadB64)
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes.buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + sigBytes.byteLength) as ArrayBuffer,
      payloadAscii.buffer.slice(payloadAscii.byteOffset, payloadAscii.byteOffset + payloadAscii.byteLength) as ArrayBuffer,
    )
    if (!valid) return null

    const decoded = decodeBase64UrlJson(payloadB64)
    if (decoded.p !== expectedPurpose) return null
    if (typeof decoded.exp !== 'number' || !Number.isFinite(decoded.exp) || decoded.exp <= nowSeconds) {
      return null
    }
    return decoded as unknown as T
  } catch {
    return null
  }
}

export function buildGoogleAuthorizationUrl(params: {
  clientId: string
  redirectUri: string
  state: string
  nonce: string
  codeChallenge: string
}): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT)
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', params.state)
  url.searchParams.set('nonce', params.nonce)
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

export async function exchangeGoogleAuthCode(params: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  codeVerifier: string
  fetcher?: typeof fetch
}): Promise<{ idToken: string }> {
  const fetcher = params.fetcher ?? globalThis.fetch
  const body = new URLSearchParams({
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: params.codeVerifier,
  })

  let response: Response
  try {
    response = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    })
  } catch {
    throw new GoogleAuthError(502, 'GOOGLE_TOKEN_UNREACHABLE', 'ไม่สามารถเชื่อมต่อ Google OAuth Token Endpoint ได้')
  }

  let data: Record<string, unknown> = {}
  try {
    data = (await response.json()) as Record<string, unknown>
  } catch {
    // ignore malformed error body
  }

  if (!response.ok || typeof data.id_token !== 'string' || !data.id_token.trim()) {
    throw new GoogleAuthError(401, 'OAUTH_EXCHANGE_FAILED', 'ไม่สามารถแลกเปลี่ยนรหัสยืนยันตัวตนจาก Google ได้')
  }

  return { idToken: data.id_token.trim() }
}

async function fetchGoogleJwks(
  certsUrl: string,
  fetcher: typeof fetch,
  forceRefresh = false,
): Promise<GoogleJsonWebKey[]> {
  const nowMs = Date.now()
  const cached = jwksCache.get(certsUrl)

  if (cached && !forceRefresh && nowMs - cached.fetchedAtMs < JWKS_CACHE_TTL_MS) {
    return cached.keys
  }

  if (cached && forceRefresh && nowMs - cached.lastForcedRefreshMs < JWKS_FORCE_REFRESH_COOLDOWN_MS) {
    return cached.keys
  }

  let response: Response
  try {
    response = await fetcher(certsUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
  } catch {
    if (cached) return cached.keys
    throw new GoogleAuthError(503, 'CERTS_UNAVAILABLE', 'ไม่สามารถเชื่อมต่อ Google public keys ได้')
  }

  if (!response.ok) {
    if (cached && forceRefresh) return cached.keys
    throw new GoogleAuthError(503, 'CERTS_UNAVAILABLE', `ดึง Google public keys ไม่สำเร็จ (HTTP ${response.status})`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new GoogleAuthError(503, 'CERTS_INVALID', 'รูปแบบ Google public keys ไม่ถูกต้อง')
  }

  const keys = Array.isArray((body as { keys?: unknown })?.keys) ? ((body as { keys: GoogleJsonWebKey[] }).keys) : null
  if (!keys || keys.length === 0) {
    throw new GoogleAuthError(503, 'CERTS_INVALID', 'ไม่พบ public keys ในการตอบกลับของ Google')
  }

  if (!jwksCache.has(certsUrl) && jwksCache.size >= MAX_JWKS_CACHE_ENTRIES) {
    const oldestKey = jwksCache.keys().next().value
    if (oldestKey) jwksCache.delete(oldestKey)
  }

  jwksCache.set(certsUrl, {
    keys,
    fetchedAtMs: nowMs,
    lastForcedRefreshMs: forceRefresh ? nowMs : (cached?.lastForcedRefreshMs ?? 0),
  })

  return keys
}

function findMatchingRsaKey(keys: GoogleJsonWebKey[], kid: string): GoogleJsonWebKey | undefined {
  return keys.find(
    (key) =>
      key.kid === kid &&
      key.kty === 'RSA' &&
      (!key.alg || key.alg === 'RS256') &&
      (!key.use || key.use === 'sig'),
  )
}

async function resolveSigningKey(
  certsUrl: string,
  kid: string,
  fetcher: typeof fetch,
): Promise<GoogleJsonWebKey> {
  const initialKeys = await fetchGoogleJwks(certsUrl, fetcher, false)
  let matched = findMatchingRsaKey(initialKeys, kid)
  if (!matched) {
    const refreshedKeys = await fetchGoogleJwks(certsUrl, fetcher, true)
    matched = findMatchingRsaKey(refreshedKeys, kid)
  }
  if (!matched) {
    throw new GoogleAuthError(401, 'UNKNOWN_KID', 'ไม่พบลายเซ็นกุญแจสาธารณะที่ตรงกับ Google ID Token')
  }
  return matched
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export async function verifyGoogleIdToken(
  idToken: string,
  options: {
    clientId: string
    expectedNonce: string
    nowSeconds?: number
    fetcher?: typeof fetch
    certsUrl?: string
  },
): Promise<VerifiedGoogleIdentity> {
  const trimmedToken = idToken.trim()
  if (!trimmedToken || trimmedToken.length > MAX_TOKEN_LENGTH) {
    throw new GoogleAuthError(401, 'INVALID_ID_TOKEN', 'Google ID Token ว่างหรือมีขนาดเกินกำหนด')
  }

  const parts = trimmedToken.split('.')
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new GoogleAuthError(401, 'INVALID_ID_TOKEN', 'โครงสร้าง Google ID Token ไม่ครบ 3 ส่วน')
  }

  const [headerSegment, payloadSegment, signatureSegment] = parts
  const header = decodeBase64UrlJson(headerSegment)
  const payload = decodeBase64UrlJson(payloadSegment)

  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid.trim()) {
    throw new GoogleAuthError(401, 'UNSUPPORTED_ALG', 'อัลกอริทึมหรือรหัสกุญแจของ Google ID Token ไม่รองรับ')
  }

  const fetcher = options.fetcher ?? globalThis.fetch
  const certsUrl = options.certsUrl ?? GOOGLE_CERTS_URL
  const jwk = await resolveSigningKey(certsUrl, header.kid.trim(), fetcher)

  let cryptoKey: CryptoKey
  try {
    cryptoKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  } catch {
    throw new GoogleAuthError(401, 'INVALID_KEY', 'ไม่สามารถนำเข้ากุญแจสาธารณะของ Google ได้')
  }

  const signingInput = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)
  const signatureBytes = decodeBase64UrlBytes(signatureSegment)
  const signatureValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signatureBytes.buffer.slice(signatureBytes.byteOffset, signatureBytes.byteOffset + signatureBytes.byteLength) as ArrayBuffer,
    signingInput.buffer.slice(signingInput.byteOffset, signingInput.byteOffset + signingInput.byteLength) as ArrayBuffer,
  )

  if (!signatureValid) {
    throw new GoogleAuthError(401, 'INVALID_SIGNATURE', 'ลายเซ็น Google ID Token ไม่ถูกต้อง')
  }

  if (typeof payload.iss !== 'string' || !GOOGLE_VALID_ISSUERS.has(payload.iss)) {
    throw new GoogleAuthError(401, 'INVALID_ISSUER', 'Issuer ของ Google ID Token ไม่ถูกต้อง')
  }

  const audiences = Array.isArray(payload.aud)
    ? payload.aud.filter((value): value is string => typeof value === 'string')
    : typeof payload.aud === 'string'
      ? [payload.aud]
      : []

  if (!audiences.includes(options.clientId)) {
    throw new GoogleAuthError(401, 'INVALID_AUDIENCE', 'Audience ของ Google ID Token ไม่ตรงกับ GOOGLE_CLIENT_ID')
  }
  if (audiences.length > 1 && payload.azp !== options.clientId) {
    throw new GoogleAuthError(401, 'INVALID_AZP', 'Authorized party ของ Google ID Token ไม่ตรงกับระบบ')
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= nowSeconds) {
    throw new GoogleAuthError(401, 'TOKEN_EXPIRED', 'Google ID Token หมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่')
  }

  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > nowSeconds + CLOCK_SKEW_SECONDS) {
      throw new GoogleAuthError(401, 'TOKEN_NOT_ACTIVE', 'Google ID Token ยังไม่อยู่ในช่วงเวลาที่ใช้งานได้')
    }
  }

  if (typeof payload.nonce !== 'string' || !timingSafeStringEqual(payload.nonce, options.expectedNonce)) {
    throw new GoogleAuthError(401, 'INVALID_NONCE', 'ค่า Nonce ใน Google ID Token ไม่ตรงกับคำขอเข้าสู่ระบบ')
  }

  if (payload.email_verified !== true) {
    throw new GoogleAuthError(403, 'UNVERIFIED_EMAIL', 'บัญชี Google นี้ยังไม่ได้ยืนยันอีเมลกับ Google')
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  if (!email || !email.includes('@') || /\s/.test(email)) {
    throw new GoogleAuthError(401, 'MISSING_EMAIL', 'ไม่พบอีเมลที่ถูกต้องใน Google ID Token')
  }

  return {
    email,
    sub: typeof payload.sub === 'string' ? payload.sub : undefined,
    exp: payload.exp,
  }
}
