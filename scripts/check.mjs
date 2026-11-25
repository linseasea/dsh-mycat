#!/usr/bin/env node
/**
 * Repository self-check for MYCAT.
 *
 * Validates the bundle manifest, the generated client, the patch bookkeeping,
 * and scans the tracked text files for accidental secrets or local paths.
 * Run it before publishing a release:
 *
 *   node scripts/check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const ok = (name, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!condition) failures += 1
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(read(rel))

/* ------------------------------------------------------------------ manifest */

const pkg = readJson('package.json')
ok('package name is dsh-mycat', pkg.name === 'dsh-mycat', pkg.name)
ok('version is semver', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? ''), pkg.version)
ok('license is MIT', pkg.license === 'MIT')
ok('declares dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
ok('declares dsh.client for web', pkg.dsh?.client?.platform === 'web')
ok('declares engines.dsh', typeof pkg.engines?.dsh === 'string', pkg.engines?.dsh)
ok('publishes no install-time scripts', pkg.scripts === undefined || Object.keys(pkg.scripts).length === 0)
ok('exports host entry', pkg.exports?.['.'] === './index.js')
ok('exports client entry', pkg.exports?.['./client'] === './client.js')

/* ------------------------------------------------------------------ bundle patch */

const patch = read('cordis.patch.yml')
ok('patch inserts package name', patch.includes("name: 'dsh-mycat'"))
ok('patch keeps official ui-workspace disabled', /- id: ui-workspace\s*\n\s*disabled: true/.test(patch))
ok('patch has no dev-only option', !/devCycle/i.test(patch))

/* ------------------------------------------------------------------ host entry */

const index = read('index.js')
ok('host version matches package.json', index.includes(`const PLUGIN_VERSION = '${pkg.version}'`))
ok('host has no leftover internal-only code', !/DEV_CYCLE|dev_cycle/i.test(index))
ok('host registers session tools', ['session_new', 'session_pin', 'session_delete', 'session_find'].every((name) => index.includes(`name: '${name}'`)))

/* ------------------------------------------------------------------ generated client */

const client = read('client.js')
ok('client registers the package module id', client.startsWith(`window.__ModuleLoader__.load({id:\`${pkg.name}\``))
ok('client has exactly one module registration', client.split('window.__ModuleLoader__.load(').length - 1 === 1)
const spec = readJson('src/patches.json')
ok('patch spec names the official component', spec.sourceVersion !== undefined && spec.block === 'src/mycat-block.js')
const sha = crypto.createHash('sha256').update(client).digest('hex')
ok('client sha256 matches src/patches.json', sha === spec.expectedSha256, sha)

/* ------------------------------------------------------------------ docs */

for (const file of ['README.md', 'LICENSE', 'NOTICE', 'docs/DETAIL.md']) {
  ok(`has ${file}`, fs.existsSync(path.join(ROOT, file)))
}
for (const lang of ['zh', 'en']) {
  const locale = readJson(`locale/${lang}.json`)
  ok(`locale ${lang} has meta.title`, typeof locale.meta?.title === 'string')
}

/* ------------------------------------------------------------------ syntax */

for (const file of ['index.js', 'client.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' })
    ok(`node --check ${file}`, true)
  } catch (error) {
    ok(`node --check ${file}`, false, String(error?.stderr ?? error))
  }
}

/* ------------------------------------------------------------------ secret / local-path scan */

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.txt'])
const SKIP_DIRS = new Set(['node_modules', '.git'])
const FORBIDDEN = [
  [/\/Users\//, 'absolute user path'],
  [/sk-[A-Za-z0-9]{16,}/, 'possible API key'],
  [/ghp_[A-Za-z0-9]{16,}/, 'possible GitHub token'],
  [/AKIA[0-9A-Z]{12,}/, 'possible AWS key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
]
const files = []
// This file itself contains the forbidden patterns as data, so skip it.
const SELF = 'scripts/check.mjs'
const walk = (dir, prefix = '') => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const rel = path.join(prefix, entry.name)
    if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name)) && rel !== SELF) files.push(rel)
  }
}
walk(ROOT)
let scanFailures = 0
for (const rel of files) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  for (const [pattern, label] of FORBIDDEN) {
    const match = pattern.exec(text)
    if (match !== null) {
      ok(`no ${label} in ${rel}`, false, JSON.stringify(match[0]))
      scanFailures += 1
    }
  }
}
ok(`secret / local-path scan over ${files.length} text files`, scanFailures === 0)

console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
