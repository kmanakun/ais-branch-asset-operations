import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const uploadJwt = process.env.ASSET_SESSION_JWT
const buckets = JSON.parse(process.env.ASSET_UPLOAD_BUCKETS || '[]')
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const distRoot = join(projectRoot, 'dist')

if (!accountId || !uploadJwt || buckets.length === 0) {
  throw new Error('CLOUDFLARE_ACCOUNT_ID, ASSET_SESSION_JWT, and ASSET_UPLOAD_BUCKETS are required')
}

const html = await readFile(join(distRoot, 'index.html'), 'utf8')
const paths = ['/index.html', '/_headers', ...[...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])]
const assets = new Map()

for (const assetPath of [...new Set(paths)]) {
  const localPath = join(distRoot, assetPath.replace(/^\/+/, ''))
  const bytes = await readFile(localPath)
  const base64 = bytes.toString('base64')
  const extension = extname(localPath).replace(/^\./, '')
  const hash = createHash('sha256').update(base64 + extension).digest('hex').slice(0, 32)
  const contentType = extension === 'html'
    ? 'text/html'
    : extension === 'css'
      ? 'text/css'
      : extension === 'js'
        ? 'application/javascript'
        : 'application/octet-stream'
  assets.set(hash, { assetPath, base64, contentType, bytes: bytes.length })
}

let completionJwt
let uploaded = 0
for (const bucket of buckets) {
  const form = new FormData()
  for (const hash of bucket) {
    const asset = assets.get(hash)
    if (!asset) throw new Error('Asset manifest hash does not match the local build')
    form.append(hash, new Blob([asset.base64], { type: asset.contentType }), basename(asset.assetPath))
  }

  const response = await fetch(
    'https://api.cloudflare.com/client/v4/accounts/' + accountId + '/workers/assets/upload?base64=true',
    { method: 'POST', headers: { Authorization: 'Bearer ' + uploadJwt }, body: form },
  )
  const payload = await response.json()
  if (!response.ok || !payload.success) {
    throw new Error('Cloudflare asset upload failed: ' + JSON.stringify({ status: response.status, payload }))
  }
  if (payload.result?.jwt) completionJwt = payload.result.jwt
  uploaded += bucket.length
}

if (!completionJwt) throw new Error('Cloudflare did not return the completion token after all assets were uploaded')
await writeFile(join(projectRoot, '.asset-completion.jwt'), completionJwt, { mode: 0o600 })
console.log(JSON.stringify({ success: true, uploaded, byteCount: [...assets.values()].reduce((sum, item) => sum + item.bytes, 0) }))
