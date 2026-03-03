import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { SingleBar } from "cli-progress";
import CliTable3 = require("cli-table3");

import { RawSqlAdapter } from "../../src/clients/raw-sql";
import { QueryBuilderAdapter } from "../../src/clients/query-builder";
import { DataAccessLayerAdapter } from "../../src/clients/data-access-layer";
import { PrismaAdapter } from "../../src/clients/orm";
import { HybridAdapter } from "../../src/clients/hybrid-orm";
import { benchConfig } from "../../configs/bench";
import { cases, caseMap, CaseContext } from "../cases";
import type { DbAdapter } from "../../src/types";

// ------------------------------------------------------------------
// Adapter registry
// ------------------------------------------------------------------

type AdapterName = "raw" | "knex" | "dal" | "orm" | "hybrid";

const ADAPTER_NAMES: AdapterName[] = ["raw", "knex", "dal", "orm", "hybrid"];

function createAdapter(name: AdapterName): DbAdapter {
  switch (name) {
    case "raw":
      return new RawSqlAdapter();
    case "knex":
      return new QueryBuilderAdapter();
    case "dal":
      return new DataAccessLayerAdapter();
    case "orm":
      return new PrismaAdapter();
    case "hybrid":
      return new HybridAdapter();
    default:
      throw new Error(
        `Unknown adapter: ${name as string}. Valid: ${ADAPTER_NAMES.join(", ")}`
      );
  }
}

// ------------------------------------------------------------------
// ANSI colour helpers (no external package – plain escape codes)
// ------------------------------------------------------------------

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const hdr = (s: string) => `\x1b[1m\x1b[96m${s}\x1b[0m`; // bold bright-cyan for table headers

// ------------------------------------------------------------------
// Stats helpers
// ------------------------------------------------------------------

export interface RunResult {
  adapter: string;
  case: string;
  warmup: number;
  iterations: number;
  concurrency: number;
  timings_ms: number[];
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  errors: number;
  /** Average heap-used per concurrency step (KB) */
  mem_avg_kb: number;
  /** Peak heap-used across all steps (KB) */
  mem_peak_kb: number;
  /** Average CPU time (user+sys) per individual request (ms) */
  cpu_avg_ms: number;
  /** Peak CPU time per request in any concurrency step (ms) */
  cpu_peak_ms: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeStats(timings: number[]) {
  if (timings.length === 0)
    return { mean: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  const sorted = [...timings].sort((a, b) => a - b);
  const mean = timings.reduce((s, v) => s + v, 0) / timings.length;
  return {
    mean,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

// ------------------------------------------------------------------
// Formatting helpers
// ------------------------------------------------------------------

function fmtMs(n: number, w = 7): string {
  return `${n.toFixed(2).padStart(w)}ms`;
}

function fmtKb(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}mb` : `${Math.round(n)}kb`;
}

// ------------------------------------------------------------------
// Single case execution
// ------------------------------------------------------------------

async function runCase(
  adapter: DbAdapter,
  caseName: string,
  adapterName: string,
  warmup: number,
  iterations: number,
  concurrency: number
): Promise<RunResult> {
  const bench = caseMap[caseName];
  if (!bench) throw new Error(`Unknown case: ${caseName}`);

  const ctx: CaseContext = {};
  if (bench.setup) await bench.setup(adapter, ctx);

  const totalSteps = warmup + iterations;
  const conc = concurrency > 1 ? ` ×${concurrency}` : "";

  // One bar covers warmup + measurement so the user sees continuous progress
  const bar = new SingleBar({
    format: `  {name}  [{bar}]  {value}/{total}  {phase}`,
    barCompleteChar: "█",
    barIncompleteChar: "░",
    clearOnComplete: true,
    hideCursor: true,
    barsize: 24,
    linewrap: false,
  });

  bar.start(totalSteps, 0, { name: caseName.padEnd(32), phase: "starting..." });

  // Warmup (bar advances but timings are discarded)
  for (let i = 0; i < warmup; i++) {
    bar.update(i, { phase: `warmup ${i + 1}/${warmup}` });
    try {
      await bench.run(adapter, ctx);
    } catch {
      /* ignore */
    }
    bar.update(i + 1, { phase: `warmup ${i + 1}/${warmup}` });
  }

  // Measurement
  const timings: number[] = [];
  let errors = 0;

  const memSamples: number[] = [];
  let memPeakBytes = 0;
  const cpuPerStep: Array<{ us: number; n: number }> = [];

  let done = 0;
  while (done < iterations) {
    const batchSize = Math.min(concurrency, iterations - done);
    bar.update(warmup + done, { phase: `${done}/${iterations}${conc}` });

    const memBefore = process.memoryUsage().heapUsed;
    const cpuBefore = process.cpuUsage();

    const batchTimings = await Promise.all(
      Array.from({ length: batchSize }, async () => {
        const t0 = performance.now();
        try {
          await bench.run(adapter, ctx);
        } catch {
          errors++;
        }
        return performance.now() - t0;
      })
    );

    const cpuDelta = process.cpuUsage(cpuBefore);
    const memAfter = process.memoryUsage().heapUsed;
    const stepPeak = Math.max(memBefore, memAfter);

    memSamples.push(stepPeak);
    memPeakBytes = Math.max(memPeakBytes, stepPeak);
    cpuPerStep.push({ us: cpuDelta.user + cpuDelta.system, n: batchSize });

    for (const t of batchTimings) timings.push(t);
    done += batchSize;
  }

  bar.update(totalSteps, { phase: "done" });
  bar.stop(); // clearOnComplete=true → clears bar line, cursor at col 0

  if (bench.teardown) await bench.teardown(adapter, ctx);

  const stats = computeStats(timings);

  const memAvgKb =
    memSamples.length > 0
      ? memSamples.reduce((s, v) => s + v, 0) / memSamples.length / 1024
      : 0;
  const memPeakKb = memPeakBytes / 1024;

  // CPU per individual request (each step had N concurrent requests)
  const cpuPerReq = cpuPerStep.map((s) => s.us / s.n); // µs per request
  const cpuAvgMs =
    cpuPerReq.length > 0
      ? cpuPerReq.reduce((s, v) => s + v, 0) / cpuPerReq.length / 1000
      : 0;
  const cpuPeakMs = cpuPerReq.length > 0 ? Math.max(...cpuPerReq) / 1000 : 0;

  const result: RunResult = {
    adapter: adapterName,
    case: caseName,
    warmup,
    iterations,
    concurrency,
    timings_ms: timings,
    errors,
    ...stats,
    mem_avg_kb: Math.round(memAvgKb),
    mem_peak_kb: Math.round(memPeakKb),
    cpu_avg_ms: Math.round(cpuAvgMs * 100) / 100,
    cpu_peak_ms: Math.round(cpuPeakMs * 100) / 100,
  };

  // Write compact one-liner on the cleared bar line
  process.stdout.write(
    `  ${caseName.padEnd(32)}` +
      `  ${dim("mean")} ${fmtMs(result.mean)}` +
      `  ${dim("p95")} ${fmtMs(result.p95)}` +
      `  ${dim("heap")} ${fmtKb(result.mem_avg_kb)}/${fmtKb(
        result.mem_peak_kb
      )}` +
      `  ${dim("cpu")} ${result.cpu_avg_ms.toFixed(
        2
      )}/${result.cpu_peak_ms.toFixed(2)}ms` +
      (result.errors > 0 ? `  \x1b[31m${result.errors} err\x1b[0m` : "") +
      "\n"
  );

  return result;
}

// ------------------------------------------------------------------
// Final summary table (printed after all adapters finish)
// ------------------------------------------------------------------

function printSummaryTable(results: RunResult[]): void {
  // Preserve case definition order, find fastest adapter per case
  const caseOrder = [...new Set(results.map((r) => r.case))];

  const bestPerCase: Record<string, string> = {};
  for (const c of caseOrder) {
    const group = results.filter((r) => r.case === c);
    bestPerCase[c] = group.reduce((a, b) => (a.mean < b.mean ? a : b)).adapter;
  }

  const worstPerCase: Record<string, string> = {};
  for (const c of caseOrder) {
    const group = results.filter((r) => r.case === c);
    if (group.length > 1)
      worstPerCase[c] = group.reduce((a, b) =>
        a.mean > b.mean ? a : b
      ).adapter;
  }

  // Case name is a full-width section header row; columns are adapter + metrics only
  const COL_COUNT = 8;
  const table = new CliTable3({
    head: [
      hdr("Adapter"),
      hdr("throughput"),
      hdr("mean ms"),
      hdr("p95 ms"),
      hdr("p99 ms"),
      hdr("heap avg/peak *"),
      hdr("cpu avg/peak *"),
      hdr("err"),
    ],
    colWidths: [8, 11, 10, 10, 10, 17, 17, 5],
    style: { head: [], border: [] },
  });

  for (const caseName of caseOrder) {
    const group = results.filter((r) => r.case === caseName);

    // Case name as a full-width section header
    table.push([
      {
        colSpan: COL_COUNT,
        content: `\x1b[1m\x1b[36m ${caseName}\x1b[0m`,
        hAlign: "left",
      },
    ]);

    for (const r of group) {
      const isBest = r.adapter === bestPerCase[caseName];
      const isWorst = r.adapter === worstPerCase[caseName];
      const hl = isBest ? green : isWorst ? red : (s: string) => s;

      const rps = r.mean > 0 ? (r.concurrency * 1000) / r.mean : 0;
      const throughput =
        rps >= 1000
          ? `${(rps / 1000).toFixed(1)}k r/s`
          : `${rps.toFixed(0)} r/s`;

      table.push([
        isBest
          ? `\x1b[1m\x1b[33m${r.adapter}\x1b[0m`
          : isWorst
          ? `\x1b[2m\x1b[33m${r.adapter}\x1b[0m`
          : `\x1b[33m${r.adapter}\x1b[0m`,
        hl(throughput),
        hl(r.mean.toFixed(2)),
        hl(r.p95.toFixed(2)),
        hl(r.p99.toFixed(2)),
        hl(`${fmtKb(r.mem_avg_kb)} / ${fmtKb(r.mem_peak_kb)}`),
        hl(`${r.cpu_avg_ms.toFixed(2)} / ${r.cpu_peak_ms.toFixed(2)}ms`),
        r.errors > 0 ? `\x1b[31m${r.errors}\x1b[0m` : "0",
      ]);
    }
  }

  console.log();
  console.log(
    bold("── Summary ──────────────────────────────────────────────────────")
  );
  console.log(table.toString());
  console.log(
    dim("  * CPU time = processor time (user+sys), not IO wait time.\n") +
      dim(
        "    Measures JS/ORM overhead only. Low values (0.1–2 ms) are normal.\n"
      ) +
      dim(
        "    avg = mean per request across all steps;  peak = worst single step.\n"
      ) +
      dim(
        "    Highlighted green = fastest adapter for that case (lowest mean)."
      )
  );
}

// ------------------------------------------------------------------
// CSV serialisation
// ------------------------------------------------------------------

function toCsv(results: RunResult[]): string {
  const header = [
    "adapter",
    "case",
    "iterations",
    "concurrency",
    "mean_ms",
    "p50_ms",
    "p95_ms",
    "p99_ms",
    "min_ms",
    "max_ms",
    "mem_avg_kb",
    "mem_peak_kb",
    "cpu_avg_ms",
    "cpu_peak_ms",
    "errors",
  ].join(",");

  const rows = results.map((r) =>
    [
      r.adapter,
      r.case,
      r.iterations,
      r.concurrency,
      r.mean.toFixed(3),
      r.p50.toFixed(3),
      r.p95.toFixed(3),
      r.p99.toFixed(3),
      r.min.toFixed(3),
      r.max.toFixed(3),
      r.mem_avg_kb,
      r.mem_peak_kb,
      r.cpu_avg_ms,
      r.cpu_peak_ms,
      r.errors,
    ].join(",")
  );
  return [header, ...rows].join("\n");
}

// ------------------------------------------------------------------
// CLI
// ------------------------------------------------------------------

async function main() {
  const program = new Command();

  program
    .name("bench")
    .description("PostgreSQL access-method performance benchmark")
    .option(
      "--adapter <names>",
      `Comma-separated adapters (${ADAPTER_NAMES.join("|")})`,
      ADAPTER_NAMES.join(",")
    )
    .option("--case <names>", "Comma-separated case names (default: all)")
    .option(
      "--warmup <n>",
      "Warmup iterations (not measured)",
      String(benchConfig.warmup)
    )
    .option(
      "--iterations <n>",
      "Measured iterations",
      String(benchConfig.iterations)
    )
    .option(
      "--concurrency <n>",
      "Parallel requests per step",
      String(benchConfig.concurrency)
    )
    .option("--out <dir>", "Output directory for JSON/CSV", "bench/reports")
    .option("--report", "Write JSON and CSV report files to --out directory");

  program.parse(process.argv);
  const opts = program.opts<{
    adapter: string;
    case?: string;
    warmup: string;
    iterations: string;
    concurrency: string;
    out: string;
    report?: boolean;
  }>();

  const adapterNames = opts.adapter
    .split(",")
    .map((s) => s.trim()) as AdapterName[];
  const caseNames = opts.case
    ? opts.case.split(",").map((s) => s.trim())
    : cases.map((c) => c.name);
  const warmup = Number(opts.warmup);
  const iterations = Number(opts.iterations);
  const concurrency = Number(opts.concurrency);
  const outDir = opts.out;
  const writeReport = opts.report ?? false;

  for (const a of adapterNames) {
    if (!ADAPTER_NAMES.includes(a)) {
      console.error(
        `Unknown adapter "${a}". Valid: ${ADAPTER_NAMES.join(", ")}`
      );
      process.exit(1);
    }
  }
  for (const c of caseNames) {
    if (!caseMap[c]) {
      console.error(
        `Unknown case "${c}". Valid: ${cases.map((x) => x.name).join(", ")}`
      );
      process.exit(1);
    }
  }

  console.log(
    `\n${bold("Benchmark")}  ` +
      `warmup=${warmup}  iterations=${iterations}  concurrency=${concurrency}`
  );
  console.log(
    `${dim("adapters:")} ${adapterNames.join(", ")}   ${dim("cases:")} ${
      caseNames.length
    }`
  );

  const allResults: RunResult[] = [];

  for (const adapterName of adapterNames) {
    console.log(
      `\n${bold(`── ${adapterName}`)} ${"─".repeat(
        Math.max(0, 60 - adapterName.length)
      )}`
    );

    const adapter = createAdapter(adapterName);

    try {
      for (const caseName of caseNames) {
        const result = await runCase(
          adapter,
          caseName,
          adapterName,
          warmup,
          iterations,
          concurrency
        );
        allResults.push(result);
      }
    } finally {
      await adapter.close();
    }
  }

  printSummaryTable(allResults);

  if (writeReport) {
    fs.mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const jsonPath = path.join(outDir, `results_${ts}.json`);
    const csvPath = path.join(outDir, `summary_${ts}.csv`);
    fs.writeFileSync(jsonPath, JSON.stringify(allResults, null, 2));
    fs.writeFileSync(csvPath, toCsv(allResults));
    console.log(`${dim("Results saved:")}  ${jsonPath}   ${csvPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
