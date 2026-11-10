interface Env {
  ASSETS: Fetcher
  SUPABASE_URL?: string
}

interface Fetcher {
  fetch(request: Request): Promise<Response>
}

function getSecurityHeaders(supabaseUrl?: string): Record<string, string> {
  const connectSources = ["'self'"]

  try {
    const url = new URL(supabaseUrl || '')
    if (url.protocol === 'https:' && url.hostname.endsWith('.supabase.co') && !url.username && !url.password) {
      connectSources.push(url.origin, `wss://${url.host}`)
    }
  } catch {
    // A missing or invalid project URL fails closed to same-origin connections.
  }

  return {
    'Content-Security-Policy':
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src ${connectSources.join(' ')}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await env.ASSETS.fetch(request)
    const headers = new Headers(response.headers)

    for (const [name, value] of Object.entries(getSecurityHeaders(env.SUPABASE_URL))) {
      headers.set(name, value)
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  },
}
