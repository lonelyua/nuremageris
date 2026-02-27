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
npm run bench -- --adapter raw --case findUserById,getOrderWithDetails
npm run bench -- --adapter raw,knex,dal --warmup 10 --iterations 100
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

| Case                  | Category      | Description                                    |
|-----------------------|---------------|------------------------------------------------|
| `findUserById`        | Read simple   | PK lookup                                      |
| `findUserByEmail`     | Read simple   | Indexed field lookup                           |
| `listUsers_paged`     | Read simple   | LIMIT/OFFSET + ORDER BY                        |
| `listUsers_filtered`  | Read simple   | ILIKE filter + pagination                      |
| `getOrderWithDetails` | Read medium   | 3-table JOIN                                   |
| `getUserOrderTotals`  | Read medium   | GROUP BY + SUM aggregation                     |
| `getLastOrderPerUser` | Read heavy    | CTE + ROW_NUMBER (Top-N per group)             |
| `batchGetUsers`       | Read heavy    | WHERE id IN (100 ids)                          |
| `insertOneUser`       | Write         | Single INSERT RETURNING                        |
| `insertManyProducts_100` | Write      | Bulk INSERT 100 rows                           |
| `createOrderWithItems`| Write         | Transactional: order + items + payment         |
| `updateOrderStatus`   | Update        | UPDATE by PK                                   |

## Runner flags

```
--adapter   raw,knex,dal,orm    which adapters to run (default: all)
--case      findUserById,...    which cases to run (default: all)
--warmup    5                   warm-up iterations before measuring
--iterations 50                 measured iterations
--out       bench/reports       output directory
```

## Output

- `bench/reports/results_<ts>.json` — raw timings per iteration
- `bench/reports/summary_<ts>.csv` — aggregated: mean / p50 / p95 / p99 / min / max / errors

## Adding a new adapter

1. Create `src/clients/<name>/index.ts` exporting a class that implements `DbAdapter`.
2. Register it in `bench/runner/index.ts` (`createAdapter` switch + `ADAPTER_NAMES`).
3. Run `npm run bench -- --adapter <name>`.

## Reproducibility

- Fixed Postgres version: `postgres:16-alpine`
- Fixed seed per `SEED_SIZE` (deterministic email pattern `user_N@example.com`)
- Warmup before measurement
- Multiple iterations + percentile stats
- Single-machine, single-process baseline (no concurrency by default)
