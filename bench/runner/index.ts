import { Command } from 'commander'
import * as fs   from 'fs'
import * as path from 'path'

import { RawSqlAdapter }            from '../../src/clients/raw-sql'
import { QueryBuilderAdapter }      from '../../src/clients/query-builder'
import { DataAccessLayerAdapter }   from '../../src/clients/data-access-layer'
import { PrismaAdapter }            from '../../src/clients/orm'
import { benchConfig }              from '../../configs/bench'
import { cases, caseMap, CaseContext } from '../cases'
import type { DbAdapter }           from '../../src/types'

// ------------------------------------------------------------------
// Adapter registry
// ------------------------------------------------------------------

type AdapterName = 'raw' | 'knex' | 'dal' | 'orm'

const ADAPTER_NAMES: AdapterName[] = ['raw', 'knex', 'dal', 'orm']

function createAdapter(name: AdapterName): DbAdapter {
  switch (name) {
    case 'raw':  return new RawSqlAdapter()
    case 'knex': return new QueryBuilderAdapter()
    case 'dal':  return new DataAccessLayerAdapter()
    case 'orm':  return new PrismaAdapter()
    default:     throw new Error(`Unknown adapter: ${name as string}. Valid: ${ADAPTER_NAMES.join(', ')}`)
  }
}

// ------------------------------------------------------------------
// Stats helpers
// ------------------------------------------------------------------

export interface RunResult {
  adapter:    string
  case:       string
  warmup:     number
  iterations: number
  timings_ms: number[]
  mean:       number
  p50:        number
  p95:        number
  p99:        number
  min:        number
  max:        number
  errors:     number
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

function computeStats(timings: number[]) {
  const sorted = [...timings].sort((a, b) => a - b)
  const mean   = timings.reduce((s, v) => s + v, 0) / timings.length
  return {
    mean,
    p50:  percentile(sorted, 50),
    p95:  percentile(sorted, 95),
    p99:  percentile(sorted, 99),
    min:  sorted[0] ?? 0,
    max:  sorted[sorted.length - 1] ?? 0,
  }
}

// ------------------------------------------------------------------
// Single case execution
// ------------------------------------------------------------------

async function runCase(
  adapter:     DbAdapter,
  caseName:    string,
  adapterName: string,
  warmup:      number,
  iterations:  number
): Promise<RunResult> {
  const bench = caseMap[caseName]
  if (!bench) throw new Error(`Unknown case: ${caseName}`)

  const ctx: CaseContext = {}
  if (bench.setup) await bench.setup(adapter, ctx)

  // warmup
  for (let i = 0; i < warmup; i++) {
    try { await bench.run(adapter, ctx) } catch { /* ignore */ }
  }

  // measure
  const timings: number[] = []
  let errors = 0

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    try {
      await bench.run(adapter, ctx)
    } catch {
      errors++
    }
    timings.push(performance.now() - t0)
  }

  if (bench.teardown) await bench.teardown(adapter, ctx)

  return {
    adapter:    adapterName,
    case:       caseName,
    warmup,
    iterations,
    timings_ms: timings,
    errors,
    ...computeStats(timings),
  }
}

// ------------------------------------------------------------------
// CSV serialisation
// ------------------------------------------------------------------

function toCsv(results: RunResult[]): string {
  const header = 'adapter,case,iterations,mean_ms,p50_ms,p95_ms,p99_ms,min_ms,max_ms,errors'
  const rows   = results.map(r =>
    [
      r.adapter, r.case, r.iterations,
      r.mean.toFixed(3), r.p50.toFixed(3), r.p95.toFixed(3),
      r.p99.toFixed(3),  r.min.toFixed(3), r.max.toFixed(3),
      r.errors,
    ].join(',')
  )
  return [header, ...rows].join('\n')
}

// ------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------

async function main() {
  const program = new Command()

  program
    .name('bench')
    .description('PostgreSQL access-method performance benchmark')
    .option('--adapter <names>', `Comma-separated adapters (${ADAPTER_NAMES.join('|')})`, ADAPTER_NAMES.join(','))
    .option('--case <names>',    'Comma-separated case names (default: all)')
    .option('--warmup <n>',      'Warmup iterations',  String(benchConfig.warmup))
    .option('--iterations <n>',  'Measured iterations', String(benchConfig.iterations))
    .option('--out <dir>',       'Output directory',   'bench/reports')

  program.parse(process.argv)
  const opts = program.opts<{
    adapter:    string
    case?:      string
    warmup:     string
    iterations: string
    out:        string
  }>()

  const adapterNames = opts.adapter.split(',').map(s => s.trim()) as AdapterName[]
  const caseNames    = opts.case
    ? opts.case.split(',').map(s => s.trim())
    : cases.map(c => c.name)
  const warmup     = Number(opts.warmup)
  const iterations = Number(opts.iterations)
  const outDir     = opts.out

  // validate
  for (const a of adapterNames) {
    if (!ADAPTER_NAMES.includes(a)) {
      console.error(`Unknown adapter "${a}". Valid: ${ADAPTER_NAMES.join(', ')}`)
      process.exit(1)
    }
  }
  for (const c of caseNames) {
    if (!caseMap[c]) {
      console.error(`Unknown case "${c}". Valid: ${cases.map(x => x.name).join(', ')}`)
      process.exit(1)
    }
  }

  fs.mkdirSync(outDir, { recursive: true })

  console.log(`\nBenchmark  warmup=${warmup}  iterations=${iterations}`)
  console.log(`Adapters : ${adapterNames.join(', ')}`)
  console.log(`Cases    : ${caseNames.join(', ')}\n`)

  const allResults: RunResult[] = []

  for (const adapterName of adapterNames) {
    console.log(`── ${adapterName} ──`)
    const adapter = createAdapter(adapterName)

    try {
      for (const caseName of caseNames) {
        process.stdout.write(`  ${caseName.padEnd(30)} `)
        const result = await runCase(adapter, caseName, adapterName, warmup, iterations)
        allResults.push(result)
        console.log(
          `mean=${result.mean.toFixed(2).padStart(7)}ms  ` +
          `p50=${result.p50.toFixed(2).padStart(7)}ms  ` +
          `p95=${result.p95.toFixed(2).padStart(7)}ms  ` +
          `err=${result.errors}`
        )
      }
    } finally {
      await adapter.close()
    }

    console.log()
  }

  // persist results
  const ts      = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = path.join(outDir, `results_${ts}.json`)
  const csvPath  = path.join(outDir, `summary_${ts}.csv`)

  // omit raw timings from CSV but keep in JSON
  fs.writeFileSync(jsonPath, JSON.stringify(allResults, null, 2))
  fs.writeFileSync(csvPath,  toCsv(allResults))

  console.log(`Results:\n  ${jsonPath}\n  ${csvPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
