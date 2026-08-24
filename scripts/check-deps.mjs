import fs from 'fs'
import path from 'path'

/**
 * Fails when source imports a package that package.json does not declare.
 *
 * These are "phantom dependencies", and they are invisible locally: npm installs a
 * flat node_modules, so a package pulled in transitively is importable even though
 * nothing declares it. pnpm does not hoist, so the same import fails — which is how
 * a build that is green on a laptop dies in CI.
 *
 * This project has now lost two deployments to exactly that. `@types/mdast` was
 * reachable through remark's dependency tree locally and absent under pnpm.
 *
 * Run before pushing; it costs milliseconds and catches the whole class.
 */

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
])

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out'])
const ROOTS = ['app', 'lib', 'components', 'scripts', 'tests', 'middleware.ts']

/** Bare specifiers that resolve without a package.json entry. */
const ALWAYS_AVAILABLE = new Set([
  'fs', 'path', 'os', 'crypto', 'util', 'stream', 'events', 'child_process',
  'url', 'http', 'https', 'zlib', 'buffer', 'process', 'assert', 'worker_threads',
  // Provided by the framework's own dependency tree.
  'react', 'react-dom', 'next',
])

const used = new Map()

function record(spec, file) {
  // Template-literal interpolations look like specifiers to a regex.
  if (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('node:')) return
  if (spec.includes('${') || spec.includes(' ')) return

  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  if (!used.has(name)) used.set(name, new Set())
  used.get(name).add(path.relative('.', file).split(path.sep).join('/'))
}

/**
 * Removes comments before scanning.
 *
 * Prose is full of things that look like imports. A doc comment reading
 * `distinguish "tampered" from "expired"` matched the `from "…"` pattern and reported
 * a missing package called `expired`, which is the kind of false positive that
 * teaches people to ignore the tool.
 *
 * Crude on purpose: it is scanning for import specifiers, not parsing TypeScript. The
 * failure mode of over-stripping is a missed import, which the build then catches;
 * the failure mode of under-stripping is a green build blocked by a sentence.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function scan(file) {
  const source = stripComments(fs.readFileSync(file, 'utf8'))
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) record(match[1], file)
  for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) record(match[1], file)
  for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) record(match[1], file)
}

function walk(target) {
  if (!fs.existsSync(target)) return
  const stats = fs.statSync(target)
  if (stats.isFile()) {
    if (/\.(ts|tsx|mts|mjs)$/.test(target)) scan(target)
    return
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    walk(path.join(target, entry.name))
  }
}

ROOTS.forEach(walk)

/**
 * A types-only import is satisfied by its DefinitelyTyped package.
 *
 * `import type { Root } from 'mdast'` needs `@types/mdast` in package.json, not a
 * package called `mdast`. Scoped names flatten with a double underscore, so
 * `@scope/name` is typed by `@types/scope__name`.
 */
function isSatisfied(name) {
  if (declared.has(name)) return true
  const typesName = name.startsWith('@')
    ? `@types/${name.slice(1).replace('/', '__')}`
    : `@types/${name}`
  return declared.has(typesName)
}

const phantoms = [...used]
  .filter(([name]) => !ALWAYS_AVAILABLE.has(name) && !isSatisfied(name))
  .sort(([a], [b]) => a.localeCompare(b))

if (phantoms.length === 0) {
  console.log(`check-deps: ok — ${used.size} imported packages, all declared.`)
  process.exit(0)
}

console.error('check-deps: undeclared packages\n')
for (const [name, files] of phantoms) {
  console.error(`  ${name}`)
  for (const file of [...files].slice(0, 5)) console.error(`      ${file}`)
}
console.error(
  `\n${phantoms.length} package(s) are imported but not in package.json.` +
    '\nThese resolve locally through npm hoisting and fail under pnpm in CI.' +
    `\nFix: npm install ${phantoms.map(([n]) => n).join(' ')}`
)
process.exit(1)
