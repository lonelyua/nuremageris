# nuremageris

Diploma project: PostgreSQL access-method performance benchmark.

Compares latency and throughput of four data-access approaches across a common set of realistic
read/write scenarios: raw SQL, query builder, repository/DAL, and ORM.

---

## Stack

| Layer            | Tool                       |
|------------------|----------------------------|
| Database         | PostgreSQL 16 (Docker)     |
| Runtime          | Node.js 20 + TypeScript    |
| Raw SQL (`raw`)  | `pg` (node-postgres)       |
| Query builder (`knex`) | `knex`               |
| Repository/DAL (`dal`) | `knex` + repositories |
| ORM (`orm`)      | Prisma 5                   |
| Seed data        | `@faker-js/faker`          |

## Quick start

```bash
# 1. copy env
cp .env.example .env

# 2. start postgres
docker compose up -d

# 3. install deps
npm install

# 4. generate Prisma client (required for orm adapter)
npm run db:generate

# 5. seed (default size M = 10k users)
npm run db:seed

# 6. run full benchmark (all 4 adapters)
npm run bench

# 7. run specific adapters / cases
npm run bench -- --adapter raw --case getTopOrdersWithItems,bulkCreateOrders
npm run bench -- --adapter raw,knex,dal,orm --warmup 10 --iterations 100 --concurrency 10
```

## Project structure

```
nuremageris/
├── configs/
│   ├── db.ts           connection config (reads .env)
│   └── bench.ts        warmup/iteration counts, dataset sizes
├── db/
│   ├── schema/
│   │   └── 001_schema.sql   tables + indexes (auto-applied by Docker)
│   └── seed/
│       └── seed.ts          generates S/M/L datasets
├── src/
│   ├── types.ts         domain types + DbAdapter interface
│   └── clients/
│       ├── raw-sql/          pg adapter
│       ├── query-builder/    knex adapter
│       ├── data-access-layer/  repository pattern (UserRepository, OrderRepository, ProductRepository) over knex
│       └── orm/              Prisma adapter
├── prisma/
│   └── schema.prisma    Prisma schema (mirrors 001_schema.sql)
└── bench/
    ├── cases/index.ts   test case definitions
    ├── runner/index.ts  CLI runner
    └── reports/         JSON + CSV output (gitignored)
```

## Dataset sizes

| Size | Users  | Products | Orders/user |
|------|--------|----------|-------------|
| S    | 1 000  | 500      | ~2          |
| M    | 10 000 | 2 000    | ~5          |
| L    | 100 000| 10 000   | ~10         |

Override with `SEED_SIZE=L npm run db:seed`.

## Benchmark cases

### Why these cases show maximum adapter differences

The cases are selected to amplify three classes of overhead:

1. **Round-trip count** — Prisma's `include` generates N separate SELECT queries instead of a single JOIN.
   Under concurrency each Prisma request holds a pool connection N× longer.
2. **INSERT batching** — `bulkCreateOrders` exposes Prisma's per-row INSERT vs. raw/knex batch INSERT.
   With 5 orders × 10 items: raw = 15 statements total, Prisma = 60 statements.
3. **Query parsing cost** — `batchGetUsers_500` uses `ANY($1::int[])` (1 param) in raw vs.
   `IN($1…$500)` (500 params) in knex/dal/orm — measurable parse overhead at scale.

### Case table

| Case | Category | What it measures |
|------|----------|------------------|
| `findUserById` | Baseline | PK lookup — reference point for minimal overhead |
| `listUsers_paged` | Baseline | LIMIT/OFFSET + ORDER BY — reference pagination |
| `getOrderWithDetails` | Read medium | raw/knex/dal: 2 queries; Prisma include: 4 queries |
| `batchGetUsers_500` | Read heavy | `ANY($1::int[])` (raw) vs `IN($1…$500)` (knex/orm) — 500 ids |
| `getTopOrdersWithItems` | **Read – key** | raw/knex/dal: 1 JOIN query; Prisma: 6 separate SELECTs + JS merge |
| `getProductSalesReport` | Analytics | GROUP BY + COUNT DISTINCT + SUM across 3 tables |
| `getMonthlyRevenueTrend` | Analytics | CTE + window function (running total); 12-month window |
| `createOrderWithItems` | Write | 1 order + 15 items: raw/knex = 1 batch INSERT; Prisma = 15 individual INSERTs |
| `bulkCreateOrders` | **Write – key** | 5 orders × 10 items: raw/knex = 15 stmts; Prisma = 60 stmts (4×) |
| `insertManyProducts_500` | Write | Bulk INSERT 500 rows; JS param-building overhead at 2000 params |

## Runner flags

```
--adapter      raw,knex,dal,orm    which adapters to run (default: all)
--case         findUserById,...    which cases to run (default: all)
--warmup       5                   warm-up iterations before measuring
--iterations   50                  measured iterations
--concurrency  5                   parallel requests per iteration
--out          bench/reports       output directory
```

Increasing `--concurrency` amplifies the round-trip delta between adapters: Prisma's multi-query
approach holds pool connections longer, saturating the pool faster than single-query raw SQL.

## Output

- `bench/reports/results_<ts>.json` — full result objects per case (includes raw `timings_ms[]` array)
- `bench/reports/summary_<ts>.csv` — aggregated stats per case per adapter:

| Column | Description |
|--------|-------------|
| `mean_ms` / `p50_ms` / `p95_ms` / `p99_ms` | Latency percentiles (ms) |
| `min_ms` / `max_ms` | Min and max observed latency (ms) |
| `mem_avg_kb` | Average heap used per concurrency step (KB) |
| `mem_peak_kb` | Peak heap observed during the case run (KB) |
| `cpu_avg_ms` | Average CPU time (user+sys) per request (ms) |
| `cpu_peak_ms` | Peak CPU time per request in any step (ms) |
| `errors` | Count of thrown exceptions |

## Adding a new adapter

1. Create `src/clients/<name>/index.ts` exporting a class that implements `DbAdapter`.
2. Register it in `bench/runner/index.ts` (`createAdapter` switch + `ADAPTER_NAMES`).
3. Run `npm run bench -- --adapter <name>`.

## Reproducibility

- Fixed Postgres version: `postgres:16-alpine`
- Fixed seed per `SEED_SIZE` (deterministic email pattern `user_N@example.com`)
- Warmup before measurement
- Multiple iterations + percentile stats
- Concurrency configurable via `--concurrency` (default 5)
