import { readdir, readFile, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(webDir, 'dist')
const assetsDir = resolve(distDir, 'assets')
const html = await readFile(resolve(distDir, 'index.html'), 'utf8')
const currentAssets = new Set(
  [...html.matchAll(/(?:src|href)=["'][^"']*\/?assets\/(index-[\w-]+\.(?:js|css))["']/g)]
    .map((match) => match[1]),
)

if (currentAssets.size === 0) {
  throw new Error('Could not find the current Vite JS/CSS assets in dist/index.html; no files were removed.')
}

const entries = await readdir(assetsDir, { withFileTypes: true })
let removed = 0

for (const entry of entries) {
  if (!entry.isFile() || !/^index-[\w-]+\.(?:js|css)$/.test(entry.name)) continue
  if (currentAssets.has(entry.name)) continue

  await unlink(resolve(assetsDir, entry.name))
  removed += 1
}

console.log(`Removed ${removed} stale hashed JS/CSS asset(s); retained ${currentAssets.size} referenced asset(s).`)
