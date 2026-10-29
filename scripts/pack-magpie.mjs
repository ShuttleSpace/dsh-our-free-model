#!/usr/bin/env node
/**
 * Pack the Magpie plugin into a self-contained zip.
 *
 * The plugin reuses the repo's `packages/standalone` runtime (Node side) and a
 * slice of `src/`. This script walks the real import graph from the two plugin
 * entry points and adds the few non-code assets the runtime reads at runtime,
 * so the archive contains exactly what Magpie needs — no DSH desktop client,
 * React sources, `frontend/`, `node_modules`, tests or the 65 MB engine binary.
 *
 * Usage: `npm run pack:magpie` (writes dist/our-free-model-magpie.zip)
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(import.meta.url), '../..')
const outDir = path.join(root, 'dist')
const outFile = path.join(outDir, 'our-free-model-magpie.zip')

// --- import graph walk ------------------------------------------------------
const importRe = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const urlRe = /new URL\(\s*[`'"]\s*([^`'"]+)\s*[`'"]\s*,\s*import\.meta\.url\s*\)/g

function resolveSpec(spec, fromFile) {
  if (spec.startsWith('node:') || spec.startsWith('node/')) return null
  if (!spec.startsWith('.') && !spec.startsWith('/')) return { bare: spec }
  const base = spec.startsWith('/') ? spec : path.resolve(path.dirname(fromFile), spec)
  for (const c of [base, `${base}.mjs`, `${base}.js`, `${base}/index.mjs`, `${base}/index.js`]) {
    try {
      const stat = fs.statSync(c)
      if (stat.isFile()) return { file: c }
      if (stat.isDirectory()) {
        for (const idx of ['index.mjs', 'index.js']) {
          const ci = path.join(c, idx)
          if (fs.existsSync(ci)) return { file: ci }
        }
      }
    } catch { /* try next */ }
  }
  return null
}

const jsFiles = new Set()
const queue = [
  path.join(root, 'magpie/index.mjs'),
  path.join(root, 'magpie/runner.mjs'),
  path.join(root, 'packages/standalone/channels/worker.mjs'),
]

function walk(file) {
  file = path.resolve(file)
  if (jsFiles.has(file)) return
  jsFiles.add(file)
  let code
  try { code = fs.readFileSync(file, 'utf8') } catch { return }
  let m
  importRe.lastIndex = 0
  while ((m = importRe.exec(code))) {
    const spec = m[1] || m[2]
    if (!spec) continue
    const r = resolveSpec(spec, file)
    if (r?.file) queue.push(r.file)
  }
}

while (queue.length) walk(queue.shift())

// --- runtime assets referenced via new URL(...) -----------------------------
const assets = new Set()
const webDirs = new Set()

function scanUrls(file) {
  let code
  try { code = fs.readFileSync(file, 'utf8') } catch { return }
  let m
  urlRe.lastIndex = 0
  while ((m = urlRe.exec(code))) {
    const spec = m[1]
    if (spec.includes('${')) { // e.g. `./web/${name}` — include that asset dir
      const dir = path.resolve(path.dirname(file), spec.slice(0, spec.indexOf('${')))
      if (fs.existsSync(dir)) webDirs.add(dir)
      continue
    }
    const target = path.resolve(path.dirname(file), spec)
    let stat
    try { stat = fs.statSync(target) } catch { continue }
    if (stat.isDirectory()) continue // `new URL('../', …)` is a path base, not a file to bundle
    if (spec.endsWith('.mjs') || spec.endsWith('.js')) queue.push(target) // follow Worker URLs
    else assets.add(target)
  }
}
for (const f of jsFiles) scanUrls(f)
while (queue.length) walk(queue.shift()) // re-walk any Worker URL we just queued

// --- explicit non-code assets the runtime needs -----------------------------
// `magpie/uninstall.mjs` is a plugin entry declared in package.json's
// `magpie.uninstall`, so the import walk never reaches it; list it explicitly.
const explicit = [
  'package.json',
  'icon.svg',
  'magpie/uninstall.mjs',
  'vendor/magpie/engine.json',
  'vendor/magpie/LICENSE',
  'vendor/magpie/NOTICE.md',
  'vendor/channel-pack/qoder-auth-wasm.wasm',
  'vendor/channel-pack/LICENSE',
  'vendor/channel-pack/NOTICE.md',
  'src/providers/registry.json',
]
for (const rel of explicit) {
  const abs = path.join(root, rel)
  if (fs.existsSync(abs)) assets.add(abs)
}

// --- assemble + filter ------------------------------------------------------
const all = new Set([...jsFiles, ...assets])
const entries = []
const exclude = p => {
  const rel = path.relative(root, p)
  return (
    rel.split(path.sep).includes('node_modules') ||
    rel.startsWith('.git' + path.sep) ||
    rel.includes('magpie' + path.sep + 'test') ||
    rel.endsWith('.test.mjs') ||
    rel.startsWith('dist' + path.sep) ||
    rel.startsWith('coverage' + path.sep) ||
    rel.startsWith('vendor' + path.sep + 'magpie' + path.sep + 'bin')
  )
}

for (const abs of all) if (!exclude(abs)) entries.push(abs)

function addTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    if (exclude(abs)) continue
    if (entry.isDirectory()) addTree(abs)
    else if (!entries.includes(abs)) entries.push(abs)
  }
}
for (const dir of webDirs) addTree(dir)

entries.sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)))

// --- minimal ZIP writer (deflate) -------------------------------------------
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function dosTime(date) {
  return ((Math.max(0, date.getFullYear() - 1980)) << 25) | ((date.getMonth() + 1) << 21) |
    (date.getDate() << 16) | (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
}

const local = []
const central = []
let offset = 0
let uncompressedTotal = 0

for (const abs of entries) {
  const data = fs.readFileSync(abs)
  const name = path.relative(root, abs).split(path.sep).join('/')
  const compressed = zlib.deflateRawSync(data, { level: 9 })
  const crc = crc32(data)
  const time = 0 // fixed 1980-01-01 timestamp, keeps the archive reproducible
  uncompressedTotal += data.length

  const nameBuf = Buffer.from(name, 'utf8')
  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x04034b50, 0)
  localHeader.writeUInt16LE(20, 4)
  localHeader.writeUInt16LE(0x0800, 6) // UTF-8 names
  localHeader.writeUInt16LE(8, 8) // deflate
  localHeader.writeUInt32LE(time, 10)
  localHeader.writeUInt32LE(crc, 14)
  localHeader.writeUInt32LE(compressed.length, 18)
  localHeader.writeUInt32LE(data.length, 22)
  localHeader.writeUInt16LE(nameBuf.length, 26)
  localHeader.writeUInt16LE(0, 28)
  local.push(localHeader, nameBuf, compressed)

  const cd = Buffer.alloc(46)
  cd.writeUInt32LE(0x02014b50, 0)
  cd.writeUInt16LE(20, 4)
  cd.writeUInt16LE(20, 6)
  cd.writeUInt16LE(0x0800, 8)
  cd.writeUInt16LE(8, 10)
  cd.writeUInt32LE(time, 12)
  cd.writeUInt32LE(crc, 16)
  cd.writeUInt32LE(compressed.length, 20)
  cd.writeUInt32LE(data.length, 24)
  cd.writeUInt16LE(nameBuf.length, 28)
  cd.writeUInt16LE(0, 30)
  cd.writeUInt16LE(0, 32)
  cd.writeUInt16LE(0, 34)
  cd.writeUInt16LE(0, 36)
  cd.writeUInt32LE(0, 38)
  cd.writeUInt32LE(offset, 42)
  central.push(cd, nameBuf)

  offset += localHeader.length + nameBuf.length + compressed.length
}

const centralBuf = Buffer.concat(central)
const eocd = Buffer.alloc(22)
eocd.writeUInt32LE(0x06054b50, 0)
eocd.writeUInt16LE(0, 4)
eocd.writeUInt16LE(0, 6)
eocd.writeUInt16LE(entries.length, 8)
eocd.writeUInt16LE(entries.length, 10)
eocd.writeUInt32LE(centralBuf.length, 12)
eocd.writeUInt32LE(offset, 16)
eocd.writeUInt16LE(0, 20)

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(outFile, Buffer.concat([...local, centralBuf, eocd]))

const zipSize = fs.statSync(outFile).size
const topDirs = [...new Set(entries.map(p => {
  const parts = path.relative(root, p).split('/')
  return parts.length > 1 ? parts[0] : '(root)'
}))].sort()
console.log(`已打包 ${entries.length} 个文件 → ${path.relative(root, outFile)}`)
console.log(`  未压缩 ${formatBytes(uncompressedTotal)}，压缩后 ${formatBytes(zipSize)}`)
console.log(`  包含目录：${topDirs.join(', ')}`)

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
