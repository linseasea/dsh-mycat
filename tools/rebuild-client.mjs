#!/usr/bin/env node
/**
 * Regenerate client.js from the official @deepseek-ai/dsh-client-ui-workspace.
 *
 * client.js is a generated file: it is the official component's client bundle
 * with MYCAT's patches (src/patches.json) applied, MYCAT's code block
 * (src/mycat-block.js) injected, and a small error reporter / module-factory
 * fallback appended.
 *
 * Usage:
 *   node tools/rebuild-client.mjs [path/to/official/client.js]
 *
 * The official client.js usually lives inside dsh's app.asar, which plain Node
 * cannot read. Run this with dsh's own Electron binary instead:
 *
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     tools/rebuild-client.mjs
 *
 * Or extract/copy the official client.js to a normal path and pass it as the
 * first argument / set DSH_OFFICIAL_CLIENT.
 *
 * If the byte offsets in src/patches.json no longer match the official file
 * (for example after a dsh upgrade), this script fails instead of writing a
 * misaligned bundle. Re-anchor the patches against the new official file then.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')
const SPEC_FILE = path.join(ROOT, 'src', 'patches.json')
const OUT = path.join(ROOT, 'client.js')

const SPEC = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8'))
const DEFAULT_OFFICIAL = `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js`
const OFFICIAL = process.argv[2] ?? process.env.DSH_OFFICIAL_CLIENT ?? DEFAULT_OFFICIAL

let src
try {
  src = fs.readFileSync(OFFICIAL, 'utf8')
} catch (error) {
  console.error(`❌ Cannot read the official client.js: ${OFFICIAL}`)
  console.error('   It lives inside app.asar; run this with ELECTRON_RUN_AS_NODE=1 and the dsh Electron binary,')
  console.error('   or pass an extracted copy as the first argument (or set DSH_OFFICIAL_CLIENT).')
  process.exit(1)
}

const block = fs.readFileSync(path.join(ROOT, SPEC.block), 'utf8')

// Apply patches last-to-first so offsets stay relative to the official source.
for (const patch of [...SPEC.patches].sort((left, right) => right.at - left.at)) {
  const actual = src.slice(patch.at, patch.at + patch.from.length)
  if (actual !== patch.from) {
    throw new Error(
      `Patch offset mismatch at ${patch.at}: expected ${JSON.stringify(patch.from.slice(0, 80))}, ` +
        `found ${JSON.stringify(actual.slice(0, 80))}. The official component changed — re-anchor src/patches.json.`,
    )
  }
  src = src.slice(0, patch.at) + patch.to + src.slice(patch.at + patch.from.length)
}

if (src.split(SPEC.blockAnchor).length - 1 !== 1) {
  throw new Error(`MYCAT block anchor is not unique: ${SPEC.blockAnchor}`)
}
src = src.replace(SPEC.blockAnchor, block + SPEC.blockAnchor)

// Whole-factory try/catch: if MYCAT's block fails to initialise, still export a
// plugin that provides the uiWorkspace service so the web boot does not fail.
const FALLBACK = `
} catch (__mycatError) {
  try {
    fetch('/api/mycat/log', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'module factory failed: ' + String((__mycatError && __mycatError.stack) || __mycatError).slice(0, 3000) }) }).catch(() => {})
  } catch (_) {}
  try {
    const cordis = require('@deepseek-ai/cordis')
    const noop = () => undefined
    const asyncNoop = async () => undefined
    const fallbackMethods = ['openSession', 'startSession', 'forkSession', 'pickDirectory', 'retain', 'using', 'binding', 'scope', 'archiveSession', 'unarchiveSession', 'pinSession', 'unpinSession', 'rename', 'create', 'delete', 'insertBefore', 'listDirectory', 'createDirectory']
    class MycatFallbackWorkspace extends cordis.Service {
      constructor(ctx) {
        super(ctx, 'uiWorkspace')
        for (const name of fallbackMethods) if (this[name] === undefined) this[name] = name === 'pickDirectory' || name === 'retain' || name === 'using' ? asyncNoop : noop
      }
    }
    return { inject: [], apply(ctx) { new MycatFallbackWorkspace(ctx) } }
  } catch (_) {
    return { inject: [], apply() {} }
  }
}}});`

src = src.replace('factory:require=>{', 'factory:require=>{try{')
src = src.replace('return module.exports}});', 'return module.exports' + FALLBACK)

fs.writeFileSync(OUT, src)

const sha = crypto.createHash('sha256').update(src).digest('hex')
console.log(`✅ wrote ${OUT} (${(src.length / 1024).toFixed(0)} KB)`)
console.log(`   sha256 ${sha}`)
if (SPEC.expectedSha256 !== '' && SPEC.expectedSha256 !== sha) {
  console.log(`   expectedSha256 in src/patches.json is ${SPEC.expectedSha256} — update it to the sha above`)
}
