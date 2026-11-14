import { access, readdir, readFile, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(webDir, 'dist')
const assetsDir = resolve(distDir, 'assets')
const html = await readFile(resolve(distDir, 'index.html'), 'utf8')
const currentAssets = new Set()
const pendingAssets = []
const assetReferencePattern = /(?:\/?assets\/|\.\/)([\w-]+\.(?:js|css|woff2?))/g

function addReferencedAssets(content) {
  for (const match of content.matchAll(assetReferencePattern)) {
    if (!currentAssets.has(match[1])) {
      currentAssets.add(match[1])
      pendingAssets.push(match[1])
    }
  }
}

addReferencedAssets(html)

if (currentAssets.size === 0) {
  throw new Error('Could not find the current Vite JS/CSS assets in dist/index.html; no files were removed.')
}

while (pendingAssets.length) {
  const assetName = pendingAssets.pop()
  const assetPath = resolve(assetsDir, assetName)
  try {
    if (/\.(?:js|css)$/.test(assetName)) {
      addReferencedAssets(await readFile(assetPath, 'utf8'))
    } else {
      await access(assetPath)
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Referenced build asset is missing: ${assetName}`)
    throw error
  }
}

const entries = await readdir(assetsDir, { withFileTypes: true })
let removed = 0

for (const entry of entries) {
  if (!entry.isFile() || !/^[\w-]+-[\w-]+\.(?:js|css|woff2?)$/.test(entry.name)) continue
  if (currentAssets.has(entry.name)) continue

  await unlink(resolve(assetsDir, entry.name))
  removed += 1
}

console.log(`Removed ${removed} stale hashed JS/CSS/font asset(s); retained ${currentAssets.size} referenced asset(s).`)
