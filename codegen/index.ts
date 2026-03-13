#!/usr/bin/env npx ts-node
/**
 * spacetimedb-retool codegen
 *
 * Reads a SpacetimeDB TypeScript module source file and outputs Retool-ready
 * JS query snippets — one file per reducer — into an output directory.
 *
 * Usage:
 *   npx ts-node codegen/index.ts <path-to-module/src/index.ts> [output-dir]
 *
 * Example:
 *   npx ts-node codegen/index.ts ../module/src/index.ts ./queries
 *
 * The generated files can be copy-pasted as Retool JS queries.
 * Each query calls window.SpacetimeDB.call('<reducer_name>', { ...args })
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname, join } from 'path'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReducerArg {
  name: string
  type: string
}

interface ReducerDef {
  camelName: string
  snakeName: string
  args:      ReducerArg[]
}

// ─── SpacetimeDB type → JS type hint ─────────────────────────────────────────

const TYPE_MAP: Record<string, string> = {
  'u8':     'number',
  'u16':    'number',
  'u32':    'number',
  'u64':    'string (bigint as string)',
  'i8':     'number',
  'i16':    'number',
  'i32':    'number',
  'i64':    'string (bigint as string)',
  'f32':    'number',
  'f64':    'number',
  'bool':   'boolean',
  'string': 'string',
}

function mapType(stdbType: string): string {
  return TYPE_MAP[stdbType] ?? stdbType
}

function toSnakeCase(name: string): string {
  return name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')
}

// ─── Parser ───────────────────────────────────────────────────────────────────
// Extracts reducer definitions from a SpacetimeDB TypeScript module source.
// Handles the pattern:
//   export const myReducer = spacetimedb.reducer({ arg: t.type(), ... }, (ctx, args) => { ... })

function parseReducers(source: string): ReducerDef[] {
  const reducers: ReducerDef[] = []

  // Match: export const <name> = spacetimedb.reducer( { ... },
  const reducerPattern = /export\s+const\s+(\w+)\s*=\s*spacetimedb\.reducer\s*\(\s*\{([^}]*)\}/gs

  for (const match of source.matchAll(reducerPattern)) {
    const camelName = match[1]!

    // Skip lifecycle hooks that happen to match (clientConnected / clientDisconnected)
    if (camelName.startsWith('onClient')) continue

    const snakeName = toSnakeCase(camelName)
    const argsBlock = match[2]!

    // Match each arg: fieldName: t.type() or fieldName: t.type().optional()
    const argPattern = /(\w+)\s*:\s*t\.(\w+)\s*\(\s*\)/g
    const args: ReducerArg[] = []
    for (const argMatch of argsBlock.matchAll(argPattern)) {
      args.push({ name: argMatch[1]!, type: mapType(argMatch[2]!) })
    }

    reducers.push({ camelName, snakeName, args })
  }

  return reducers
}

// ─── Code generation ──────────────────────────────────────────────────────────

function generateQuery(reducer: ReducerDef): string {
  const { camelName, snakeName, args } = reducer

  const argList = args.length > 0
    ? args.map(a => `//   ${a.name.padEnd(28)} ${a.type}`).join('\n')
    : '//   (no arguments)'

  const argsObj = args.length > 0
    ? '{\n' + args.map(a => `  ${a.name}: params.${a.name},`).join('\n') + '\n}'
    : '{}'

  return `// Retool JS Query: ${camelName}
// SpacetimeDB reducer: ${snakeName}
//
// Arguments (set via query params or Retool component values):
${argList}
//
// Requires window.SpacetimeDB to be configured (see spacetimedb-retool library).

return await window.SpacetimeDB.call('${snakeName}', ${argsObj})
`
}

function generateTableQuery(tableName: string): string {
  return `// Retool JS Query: read ${tableName}
// Reads all rows from the '${tableName}' table.
// Add a WHERE clause to filter rows server-side.

return await window.SpacetimeDB.sql('SELECT * FROM ${tableName}')
`
}

// ─── Table parser ─────────────────────────────────────────────────────────────

function parseTables(source: string): string[] {
  const tables: string[] = []
  const tablePattern = /(\w+):\s*table\s*\(/g
  for (const match of source.matchAll(tablePattern)) {
    tables.push(match[1]!)
  }
  return tables
}

// ─── Setup query template ─────────────────────────────────────────────────────

function generateSetupQuery(database: string): string {
  return `// Retool JS Query: SpacetimeDB Setup
// Run this once on app load (set to run on page load in Retool).
// Replace placeholder values with your actual configuration.

window.SpacetimeDB.configure({
  httpBase: 'https://your-host/spacetimedb/instance',   // e.g. https://dev.hook.appo.nl/spacetimedb/test
  database: '${database}',
  authBase: 'https://your-auth-server',                  // e.g. https://hook.appo.nl/.../auth-server
})

// Option A: login with username/password
const result = await window.SpacetimeDB.auth.login(
  retoolContext.currentUser.email,   // or a Retool input value
  loginPasswordInput.value,
)
return result

// Option B: set a pre-existing token (e.g. stored in Retool state)
// window.SpacetimeDB.setToken(tokenState.value)
`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.error('Usage: npx ts-node codegen/index.ts <module-source.ts> [output-dir]')
    console.error('Example: npx ts-node codegen/index.ts ../module/src/index.ts ./queries')
    process.exit(1)
  }

  const sourcePath  = resolve(args[0]!)
  const outputDir   = resolve(args[1] ?? './queries')
  const database    = args[2] ?? 'your-database'

  if (!existsSync(sourcePath)) {
    console.error(`✗ Source file not found: ${sourcePath}`)
    process.exit(1)
  }

  const source   = readFileSync(sourcePath, 'utf8')
  const reducers = parseReducers(source)
  const tables   = parseTables(source)

  mkdirSync(join(outputDir, 'reducers'), { recursive: true })
  mkdirSync(join(outputDir, 'tables'),   { recursive: true })

  // Write setup query
  writeFileSync(
    join(outputDir, '00_setup.js'),
    generateSetupQuery(database)
  )
  console.log('✓ queries/00_setup.js')

  // Write one file per reducer
  for (const reducer of reducers) {
    const filename = `${reducer.snakeName}.js`
    writeFileSync(join(outputDir, 'reducers', filename), generateQuery(reducer))
    console.log(`✓ queries/reducers/${filename}`)
  }

  // Write one file per table
  for (const table of tables) {
    const filename = `${table}.js`
    writeFileSync(join(outputDir, 'tables', filename), generateTableQuery(table))
    console.log(`✓ queries/tables/${filename}`)
  }

  console.log(`\n✓ Generated ${reducers.length} reducer queries and ${tables.length} table queries`)
  console.log(`  Output: ${outputDir}`)
  console.log('\nNext steps:')
  console.log('  1. Add spacetimedb-retool bundle as an external library in Retool')
  console.log('  2. Create a "Setup" JS query in Retool and paste 00_setup.js')
  console.log('  3. Create one Retool JS query per reducer/table file')
}

main()
