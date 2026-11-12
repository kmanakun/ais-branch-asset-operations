import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const headerPath = path.resolve('dist', '_headers')
const headers = await readFile(headerPath, 'utf8')
const marker = '__SUPABASE_ORIGINS__'

const cleaned = headers.includes(marker) ? headers.replace(marker, '').replace(/\s+/g, ' ') : headers
await writeFile(headerPath, cleaned, 'utf8')

