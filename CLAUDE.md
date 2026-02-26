# CLAUDE.md — nuremageris

Diploma project: benchmarking different PostgreSQL access methods in Node.js/TypeScript.

## Goal

Compare latency and throughput of the following access methods on identical scenarios:
- `raw` — plain SQL via `pg` (node-postgres)
- `knex` — query builder
- `orm` — Prisma (planned)
- `hybrid-orm` — ORM + raw SQL for heavy queries (planned)
- `stored-proc` — stored procedure calls (planned)

## Key architectural decisions

### Single contract
All adapters implement the `DbAdapter` interface from [src/types.ts](src/types.ts).
The runner has no knowledge of what is used under the hood — it receives an adapter and calls contract methods.
**Never break this interface without synchronously updating all implementations.**

### Identical SQL scenarios
Each case in [bench/cases/index.ts](bench/cases/index.ts) must perform semantically identical
work across all adapters. Adding optimisations to only one adapter is not allowed.

### Fixed schema and seed
The schema in [db/schema/001_schema.sql](db/schema/001_schema.sql) is the single source of truth.
The seed in [db/seed/seed.ts](db/seed/seed.ts) generates deterministic emails (`user_N@example.com`),
which bench cases rely on (e.g. `findUserByEmail('user_500@example.com')`).
**Do not change the email pattern without updating the cases.**

### Metrics
The runner collects `p50 / p95 / p99 / mean / min / max` per case per adapter.
Raw timings are stored in JSON; aggregates go to CSV (for diploma tables).

## Structure

```
configs/          db.ts (connection config), bench.ts (sizes, warmup)
db/schema/        SQL schema — applied by Docker on first start
db/seed/          seed.ts — S/M/L dataset generation
src/types.ts      Domain types + DbAdapter interface
src/clients/      Adapter implementations (one folder per method)
bench/cases/      Case definitions (BenchCase[])
bench/runner/     CLI runner, stats helpers, CSV serialisation
bench/reports/    Output files (gitignored)
```

## Commands

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:seed                     # SEED_SIZE=S|M|L
npm run bench                       # all adapters, all cases
npm run bench -- --adapter raw,knex --case findUserById,getOrderWithDetails
npm run bench -- --warmup 10 --iterations 100 --out bench/reports
npm run typecheck
```

## Adding a new adapter

1. Create `src/clients/<name>/index.ts` with a class implementing `DbAdapter`
2. Register in `bench/runner/index.ts`: add to `AdapterName`, `createAdapter()`, and `ADAPTER_NAMES`
3. Run `npm run bench -- --adapter <name>`

## Conventions

- TypeScript strict mode, no `any`
- All code and code comments must be in English
- `pg` returns `NUMERIC` as `string` — domain types `price: string`, `total: string` are intentional
- Always use `$N` placeholders or knex bindings — never string concatenation for SQL params
- Pool lifecycle: `close()` is called by the runner after all cases for an adapter are done
- Default dataset size: `M` (10k users, ~2k products, ~5 orders/user)
