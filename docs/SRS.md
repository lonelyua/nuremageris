# Software Requirements Specification
## nuremageris — PostgreSQL Access Method Benchmarking Tool

**Document ID:** SRS-NUREMAGERIS-1.0
**Version:** 1.0
**Date:** 2026-03-19
**Organization:** NURE, Software Engineering
**Author:** Ivan Bobyr
**Status:** Final

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Overall Description](#2-overall-description)
3. [Specific Requirements](#3-specific-requirements)
   - [3.1 External Interface Requirements](#31-external-interface-requirements)
   - [3.2 Functional Requirements](#32-functional-requirements)
   - [3.3 Usability Requirements](#33-usability-requirements)
   - [3.4 Performance Requirements](#34-performance-requirements)
   - [3.5 Logical Database Requirements](#35-logical-database-requirements)
   - [3.6 Design Constraints](#36-design-constraints)
   - [3.7 Software System Attributes](#37-software-system-attributes)
   - [3.8 Supporting Information](#38-supporting-information)
4. [Verification](#4-verification)
5. [Appendices](#5-appendices)

---

## 1. Introduction

### 1.1 Purpose

This Software Requirements Specification (SRS) defines the requirements for
**nuremageris**, a benchmarking system designed to measure and compare the
performance characteristics of different PostgreSQL database access methods in
a Node.js/TypeScript environment.

This document is intended for the diploma project supervisor, the developer,
and any evaluators of the diploma work. It is prepared in accordance with
IEEE 29148:2018 — Systems and software engineering: Life cycle processes —
Requirements engineering.

### 1.2 Scope

**Product name:** nuremageris
**Product type:** CLI benchmarking tool (research / academic)

The system enables empirical comparison of six PostgreSQL access approaches:

| Adapter key | Technology |
|-------------|-----------|
| `raw` | Plain SQL via `pg` (node-postgres) connection pool |
| `knex` | Query builder via `knex` |
| `dal` | Data Access Layer / Repository pattern built on top of `knex` |
| `orm` | ORM via Prisma 5 (fluent API + `$queryRaw` for GROUP BY / window functions) |
| `hybrid` | Prisma for simple CRUD + `pg` Pool for complex queries and all write transactions |
| `stored-proc` | All logic delegated to PL/pgSQL functions; no SQL in Node.js application code |

The tool executes a fixed set of benchmark cases against a shared PostgreSQL
database schema, collects latency and throughput metrics, and serializes results
to JSON and CSV for inclusion in the diploma thesis.

**Out of scope:**

- Web UI or REST API
- Production deployment or multi-tenant usage
- Multi-database support (MySQL, SQLite, etc.)
- ORM frameworks other than Prisma 5

### 1.3 Product Overview

#### 1.3.1 Product Perspective

nuremageris is a standalone research tool. It does not integrate with any
external systems at runtime. It requires a local PostgreSQL 16 instance
(provided via Docker Compose) and a Node.js 20 runtime on the host machine.

The high-level data flow is as follows:

```
[Developer / Researcher]
        │
        ▼  npm run bench [options]
[CLI Runner (bench/runner/index.ts)]
        │
        ├─► [Adapter: raw]        ─┐
        ├─► [Adapter: knex]        │
        ├─► [Adapter: dal]         ├──► [PostgreSQL 16 (Docker, port 5433)]
        ├─► [Adapter: orm]         │
        ├─► [Adapter: hybrid]      │
        └─► [Adapter: stored-proc]─┘
        │
        ▼
[bench/reports/results_<timestamp>.json]
[bench/reports/results_<timestamp>.csv]
```

#### 1.3.2 Product Functions (Summary)

- **Schema management:** DDL applied automatically by Docker on first start;
  PL/pgSQL functions applied via `npm run db:procs`
- **Data seeding:** Deterministic synthetic dataset in three sizes (S / M / L)
  via `npm run db:seed`
- **Benchmark execution:** 10 benchmark cases × 6 adapters = 60 measurements
  per run; configurable warmup, iteration count, and concurrency
- **Statistical aggregation:** p50, p95, p99, mean, min, max latency (ms) and
  throughput (ops/s) per (adapter, case) pair
- **Output:** Raw JSON timings + CSV aggregate table per run

#### 1.3.3 User Characteristics

Single user: the diploma student and project author. Expected skill level:
intermediate Node.js/TypeScript developer with basic SQL knowledge and
familiarity with CLI tools and Docker. No graphical interface is required or
provided.

#### 1.3.4 Limitations and Assumptions

- Benchmark results are valid only for the configured hardware and PostgreSQL
  server configuration; they are not generalizable to other environments
- Docker and Docker Compose must be available on the host machine
- The host machine must not be under significant external CPU/IO load during
  benchmark runs, as results depend on system resources
- The Prisma client must be regenerated (`npm run db:generate`) whenever
  `prisma/schema.prisma` changes
- The `stored-proc` adapter requires the PL/pgSQL functions to be applied to
  the database (`npm run db:procs`) before use

### 1.4 Definitions, Acronyms, Abbreviations

| Term | Definition |
|------|-----------|
| Adapter | A TypeScript class implementing the `DbAdapter` interface for a specific PostgreSQL access method |
| Benchmark case | A named, repeatable scenario that exercises one or more `DbAdapter` methods and is timed |
| CTE | Common Table Expression — a SQL `WITH` clause |
| DAL | Data Access Layer — Repository pattern implemented on top of `knex` |
| DDL | Data Definition Language — SQL statements that define the schema (`CREATE TABLE`, etc.) |
| ORM | Object-Relational Mapper — in this project, Prisma 5 |
| p50 / p95 / p99 | 50th, 95th, and 99th percentile of a latency distribution |
| PL/pgSQL | PostgreSQL's built-in procedural language for server-side functions |
| Pool | `pg.Pool` — a managed set of reusable PostgreSQL client connections |
| Seed | Script that generates and inserts synthetic test data into the database |
| SRS | Software Requirements Specification |
| Throughput | Number of benchmark case invocations completed per second |
| Warmup | Iterations executed before timing begins, used to prime OS caches and JIT state |
| WSL2 | Windows Subsystem for Linux 2 |

### 1.5 References

| ID | Reference |
|----|-----------|
| R1 | IEEE 29148:2018 — Systems and software engineering: Life cycle processes — Requirements engineering |
| R2 | PostgreSQL 16 Documentation — https://www.postgresql.org/docs/16/ |
| R3 | Prisma 5 Documentation — https://www.prisma.io/docs |
| R4 | node-postgres (pg) Documentation — https://node-postgres.com |
| R5 | knex.js Documentation — https://knexjs.org |
| R6 | Node.js 20 LTS Documentation — https://nodejs.org/en/docs |
| R7 | TypeScript 5 Documentation — https://www.typescriptlang.org/docs |
| R8 | @faker-js/faker Documentation — https://fakerjs.dev |
| R9 | commander.js Documentation — https://github.com/tj/commander.js |

---

## 2. Overall Description

nuremageris addresses the research question:

> *What are the measurable latency and throughput differences between raw SQL,
> query builders, repository patterns, ORM frameworks, and stored procedures
> when used for identical workloads against PostgreSQL 16 in a Node.js
> environment?*

The system was developed as a diploma thesis project. It is not intended for
production use. The primary stakeholder and sole end-user is the diploma author.

The research contribution is the empirical data produced by the tool: CSV tables
and JSON files containing per-adapter, per-case statistics that are included
directly in the diploma thesis as evidence for the comparative analysis.

Key design philosophy:

- **Single contract:** All six adapters implement the same `DbAdapter`
  TypeScript interface. The runner has no knowledge of what library is used
  under the hood.
- **Identical semantics:** Each benchmark case performs the same business
  operation and returns semantically identical data across all adapters. The
  only differences are at the SQL/wire-protocol level — these differences are
  the subject of measurement.
- **Idiomatic implementation:** Each adapter uses the approach that is natural
  and typical for its library. No artificial degradations or non-native
  optimizations are introduced to skew results.

---

## 3. Specific Requirements

### 3.1 External Interface Requirements

#### 3.1.1 User Interfaces

**REQ-UI-01** The system shall expose a command-line interface (CLI) as the
sole user interface. No graphical user interface shall be implemented.

**REQ-UI-02** The CLI shall accept the following command-line options:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `--adapter` | Comma-separated string | all adapters | One or more adapter keys to benchmark |
| `--case` | Comma-separated string | all cases | One or more case IDs to run |
| `--warmup` | Integer ≥ 0 | `5` | Number of warmup iterations (discarded) |
| `--iterations` | Integer ≥ 1 | `50` | Number of measured iterations per case |
| `--concurrency` | Integer ≥ 1 | `1` | Number of concurrent execution slots |
| `--out` | Directory path | `bench/reports/` | Directory for output JSON and CSV files |
| `--report` | Boolean flag | `false` | Print a summary table to stdout after completion |
| `--verbose` | Boolean flag | `false` | Print per-iteration timing to stdout during execution |

**REQ-UI-03** The CLI shall print a progress indicator to stdout showing the
current adapter name, case name, and iteration number during execution.

**REQ-UI-04** When `--report` is specified, the CLI shall print a formatted
summary table to stdout on completion, showing p50 / p95 / p99 / mean latency
for each (adapter, case) pair.

**REQ-UI-05** The CLI shall exit with code `0` on successful completion and a
non-zero exit code on any unrecoverable error (e.g., database connection
failure, missing environment variable).

**REQ-UI-06** Valid adapter keys accepted by `--adapter` shall be:
`raw`, `knex`, `dal`, `orm`, `hybrid`, `stored-proc`.

#### 3.1.2 Hardware Interfaces

**REQ-HW-01** The system shall run on any x86-64 machine capable of hosting
Docker Engine and Node.js 20.

**REQ-HW-02** Minimum recommended resources: 4 GB RAM, 2 GB free disk space
(for Docker image, test data, and output files).

**REQ-HW-03** No special hardware (GPU, FPGA, hardware security module, etc.)
is required or used.

#### 3.1.3 Software Interfaces

**REQ-SW-01** The system shall connect to a PostgreSQL 16 server at the host
and port specified by the environment variables `PG_HOST`, `PG_PORT`,
`PG_USER`, `PG_PASSWORD`, and `PG_DATABASE`.

**REQ-SW-02** The default PostgreSQL host port shall be `5433`. This non-standard
port is chosen to avoid conflict with a system-level PostgreSQL instance that
may be running on port `5432`. The Docker Compose file shall map
`5433` on the host to `5432` inside the container.

**REQ-SW-03** The `raw`, `knex`, `dal`, `hybrid`, and `stored-proc` adapters
shall use the `pg` npm package (node-postgres) for all database connections.

**REQ-SW-04** The `knex` and `dal` adapters shall use the `knex` npm package
as the query builder layer.

**REQ-SW-05** The `orm` and `hybrid` adapters shall use the Prisma 5 ORM
(`@prisma/client`). The Prisma client must be generated via
`npm run db:generate` before these adapters can be instantiated.

**REQ-SW-06** The project shall use Node.js 20 LTS and TypeScript 5 with
`strict: true`. The `tsx` runtime shall be used for direct TypeScript
execution without a separate compilation step.

**REQ-SW-07** The `DATABASE_URL` environment variable shall be present and in
the format `postgresql://user:password@host:port/database` for adapters that
use Prisma.

**REQ-SW-08** Synthetic data generation during seeding shall use the
`@faker-js/faker` npm package.

**REQ-SW-09** The CLI argument parser shall use the `commander` npm package.

#### 3.1.4 Communication Interfaces

**REQ-COM-01** All communication between the Node.js process and the database
shall use the PostgreSQL wire protocol over TCP/IP on the configured host and
port.

**REQ-COM-02** No external network calls (HTTP, DNS to external hosts, third-
party APIs, telemetry) shall be made during benchmark execution.

**REQ-COM-03** All database connections shall use connection pooling. The `pg`-
based adapters shall use `pg.Pool`; Prisma manages its own internal pool.

---

### 3.2 Functional Requirements

#### 3.2.1 Database Schema Management

**REQ-F-01** The Docker Compose configuration shall start a PostgreSQL 16
container and automatically apply the schema file `db/schema/001_schema.sql`
on the first start using a Docker init-scripts mechanism.

**REQ-F-02** The schema shall define the following six tables with the
specified relationships:

| Table | Primary Key | Notable Columns | Foreign Keys |
|-------|------------|----------------|--------------|
| `categories` | `id` SERIAL | `name` VARCHAR(100) | — |
| `products` | `id` SERIAL | `name` VARCHAR(200), `price` NUMERIC(10,2) | `category_id → categories.id` |
| `users` | `id` SERIAL | `name` VARCHAR(100), `email` VARCHAR(200) UNIQUE | — |
| `orders` | `id` SERIAL | `status` VARCHAR(20), `total` NUMERIC(10,2), `created_at` TIMESTAMPTZ | `user_id → users.id` |
| `order_items` | `id` SERIAL | `quantity` INT, `unit_price` NUMERIC(10,2) | `order_id → orders.id`, `product_id → products.id` |
| `payments` | `id` SERIAL | `amount` NUMERIC(10,2), `method` VARCHAR(20), `status` VARCHAR(20) | `order_id → orders.id` UNIQUE |

**REQ-F-03** The `npm run db:procs` script shall apply all PL/pgSQL function
definition files from `db/procs/*.sql` to the database idempotently, using
`CREATE OR REPLACE FUNCTION`. The script shall process files in lexicographic
order: `001_users.sql`, `002_orders.sql`, `003_analytics.sql`.

**REQ-F-04** The schema shall define B-tree indexes on all foreign key columns,
a unique index on `users.email`, and an index on `orders.created_at`.

#### 3.2.2 Data Seeding

**REQ-F-05** The `npm run db:seed` script shall generate and insert synthetic
test data in a size controlled by the `SEED_SIZE` environment variable:

| SEED_SIZE | Users | Categories | Products | Orders (approx.) | Items / Order (approx.) |
|-----------|-------|-----------|---------|-----------------|------------------------|
| `S` | 1 000 | 10 | 200 | ~3 000 | ~5 |
| `M` | 10 000 | 20 | 2 000 | ~50 000 | ~5 |
| `L` | 100 000 | 50 | 5 000 | ~700 000 | ~5 |

**REQ-F-06** The seed script shall generate user emails following the
deterministic pattern `user_N@example.com`, where N is the 1-based sequential
user index (e.g., `user_1@example.com`, `user_500@example.com`).

**REQ-F-07** The seed script shall truncate all tables (with CASCADE) before
inserting new data, ensuring the script is safe to run multiple times.

**REQ-F-08** The default dataset size for benchmark runs shall be `M`.

#### 3.2.3 Adapter Interface Contract

**REQ-F-09** All six adapters shall implement the `DbAdapter` TypeScript
interface defined in `src/types.ts`. The interface shall be the single contract
between the runner and the adapters.

**REQ-F-10** The `DbAdapter` interface shall define the following methods:

| Method | Return Type | Parameters | Description |
|--------|------------|------------|-------------|
| `findUserById` | `Promise<User \| null>` | `id: number` | Look up a single user by primary key |
| `findUserByEmail` | `Promise<User \| null>` | `email: string` | Look up a single user by unique email index |
| `listUsers` | `Promise<User[]>` | `page: number, pageSize: number` | Return a paginated list of users (OFFSET / LIMIT) |
| `insertOneUser` | `Promise<User>` | `data: NewUser` | Insert a single user record and return it |
| `getOrderWithDetails` | `Promise<OrderWithDetails \| null>` | `orderId: number` | Return an order with its items and associated product data |
| `batchGetUsers` | `Promise<User[]>` | `ids: number[]` | Return multiple users by an array of primary keys |
| `getTopOrdersWithItems` | `Promise<OrderWithItems[]>` | `limit: number` | Return the top N orders by total amount, with their items |
| `getProductSalesReport` | `Promise<ProductSalesReport[]>` | — | Return per-category aggregation: total revenue, units sold, distinct buyers |
| `getMonthlyRevenueTrend` | `Promise<MonthlyRevenue[]>` | `months: number` | Return monthly revenue with a rolling cumulative sum (CTE + window function) |
| `createOrderWithItems` | `Promise<Order>` | `order: NewOrder, items: NewOrderItem[]` | Insert one order and its items in a single transaction; return the created order |
| `bulkCreateOrders` | `Promise<Order[]>` | `orders: NewOrderWithItems[]` | Insert multiple orders with their items in a single transaction |
| `insertManyProducts` | `Promise<Product[]>` | `products: NewProduct[]` | Bulk-insert a list of products and return them |
| `updateOrderStatus` | `Promise<Order>` | `orderId: number, status: string` | Update the status field of a single order and return it |
| `deleteOrder` | `Promise<void>` | `orderId: number` | Delete an order and cascade to related records |
| `close` | `Promise<void>` | — | Release all database connections held by the adapter |

**REQ-F-11** Every adapter method shall return data that is semantically
identical to the equivalent method in any other adapter when given the same
input. Observable SQL-level differences (e.g., parameter count, number of
round-trips) are expected and are the subject of measurement, not defects.

**REQ-F-12** The `close()` method shall be called by the runner after all
benchmark cases for an adapter have completed. Upon `close()`, the adapter
must release all database connections and free all associated resources.

**REQ-F-13** Any change to the `DbAdapter` interface shall require simultaneous
update of all six adapter implementations. No adapter may partially implement
the interface.

#### 3.2.4 Domain Types

**REQ-F-14** The following domain types shall be defined in `src/types.ts`
and used by all adapters:

| Type | Key Fields |
|------|-----------|
| `User` | `id: number`, `name: string`, `email: string` |
| `NewUser` | `name: string`, `email: string` |
| `Product` | `id: number`, `name: string`, `price: string`, `categoryId: number` |
| `NewProduct` | `name: string`, `price: string`, `categoryId: number` |
| `Order` | `id: number`, `userId: number`, `status: string`, `total: string`, `createdAt: Date` |
| `NewOrder` | `userId: number`, `status: string` |
| `OrderItem` | `id: number`, `orderId: number`, `productId: number`, `quantity: number`, `unitPrice: string` |
| `NewOrderItem` | `productId: number`, `quantity: number`, `unitPrice: string` |
| `NewOrderWithItems` | `order: NewOrder`, `items: NewOrderItem[]` |
| `OrderWithDetails` | `Order` + `items: (OrderItem & { product: Product })[]` |
| `OrderWithItems` | `Order` + `items: OrderItem[]` |
| `ProductSalesReport` | `categoryId: number`, `categoryName: string`, `productId: number`, `productName: string`, `totalRevenue: string`, `unitsSold: number`, `distinctBuyers: number` |
| `MonthlyRevenue` | `month: string`, `revenue: string`, `cumulativeRevenue: string` |

**REQ-F-15** Monetary and numeric fields (`price`, `total`, `amount`,
`unitPrice`, `revenue`, `cumulativeRevenue`, `totalRevenue`) shall have type
`string` in all domain types. This is intentional: the `pg` driver returns
`NUMERIC` columns as JavaScript strings, and Prisma's `Decimal` type must be
converted via `.toString()` before being placed into these fields.

#### 3.2.5 Benchmark Cases

**REQ-F-16** The system shall include exactly 10 benchmark cases. Each case
shall be defined as an object conforming to the `BenchCase` interface with
fields: `id: string`, `description: string`, and
`run(adapter: DbAdapter): Promise<unknown>`.

**REQ-F-17** The 10 benchmark cases shall be as follows:

| Case ID | Identifier | Category | Key Overhead Characteristic |
|---------|-----------|----------|-----------------------------|
| BC-01 | `findUserById` | Baseline | Single PK lookup — reference point for all latencies |
| BC-02 | `listUsers_paged` | Baseline | OFFSET/LIMIT pagination on `users` table |
| BC-03 | `getOrderWithDetails` | Read – medium | 2 queries (raw/knex/dal) vs. 4 queries (Prisma `include`) |
| BC-04 | `batchGetUsers_500` | Read – heavy | `ANY($1::int[])` 1 param vs. `IN($1…$500)` 500 params |
| BC-05 | `getTopOrdersWithItems` | Read – key | 1 JOIN query vs. 6 separate SELECTs (Prisma); amplified by concurrency |
| BC-06 | `getProductSalesReport` | Analytics | GROUP BY + COUNT DISTINCT + SUM across categories → products → order_items |
| BC-07 | `getMonthlyRevenueTrend` | Analytics | CTE + window function; 12-month rolling cumulative sum |
| BC-08 | `createOrderWithItems` | Write | 1 order + 15 items: 1 batch INSERT vs. 15 individual INSERTs (Prisma) |
| BC-09 | `bulkCreateOrders` | Write – key | 5 orders × 10 items: 15 statements vs. 60 statements (Prisma); largest write gap |
| BC-10 | `insertManyProducts_500` | Write | Bulk INSERT of 500 rows; stresses parameter serialization |

**REQ-F-18** The `batchGetUsers_500` case (BC-04) shall pass exactly **500**
user IDs to `batchGetUsers`.

**REQ-F-19** The `createOrderWithItems` case (BC-08) shall create exactly
**1 order with 15 items** per iteration.

**REQ-F-20** The `bulkCreateOrders` case (BC-09) shall create exactly
**5 orders, each with 10 items** (50 items total), per iteration.

**REQ-F-21** The `insertManyProducts_500` case (BC-10) shall insert exactly
**500 products** per iteration.

**REQ-F-22** The `getTopOrdersWithItems` case (BC-05) shall request the top
**5** orders by total amount.

**REQ-F-23** The `getMonthlyRevenueTrend` case (BC-07) shall request
**12 months** of rolling revenue data.

**REQ-F-24** The `listUsers_paged` case (BC-02) shall use a fixed page number
and page size that are representative of mid-dataset access (not the first page).

**REQ-F-25** The `findUserById` case (BC-01) shall look up a user at a fixed
ID that is known to exist in all seeded dataset sizes.

**REQ-F-26** The `findUserByEmail` lookup within cases shall use the email
`user_500@example.com`, which is guaranteed to exist in all dataset sizes (S,
M, L) by the seed pattern defined in REQ-F-06.

#### 3.2.6 Benchmark Runner

**REQ-F-27** The runner shall process adapters in the order specified by
`--adapter` (or a fixed default order when all adapters are run). Within each
adapter, cases shall be processed in the order specified by `--case` (or the
fixed default order).

**REQ-F-28** For each (adapter, case) pair, the runner shall execute the
following sequence:
1. Execute `--warmup` iterations; discard all timing results
2. Execute `--iterations` measured iterations; record wall-clock duration of
   each iteration using `performance.now()` or `process.hrtime.bigint()`
3. Compute aggregate statistics over the recorded durations

**REQ-F-29** When `--concurrency N` is specified (N > 1), the runner shall
execute up to N iterations of a case simultaneously using asynchronous
concurrency. Iterations shall be dispatched continuously until the total
iteration count is reached.

**REQ-F-30** The runner shall instantiate each adapter once at the start of
that adapter's run, execute all cases against the single instance, then call
`close()` before moving to the next adapter.

**REQ-F-31** The runner shall not share adapter instances between concurrent
iterations. When concurrency > 1, the same adapter instance is used but the
adapter's internal pool handles concurrent connections.

#### 3.2.7 Statistical Metrics

**REQ-F-32** For each (adapter, case) pair, the runner shall compute and record
the following metrics:

| Metric | Unit | Description |
|--------|------|-------------|
| `p50` | milliseconds | 50th percentile (median) of iteration latencies |
| `p95` | milliseconds | 95th percentile of iteration latencies |
| `p99` | milliseconds | 99th percentile of iteration latencies |
| `mean` | milliseconds | Arithmetic mean of iteration latencies |
| `min` | milliseconds | Minimum observed latency |
| `max` | milliseconds | Maximum observed latency |
| `throughput` | ops/second | `iterations / total_wall_time_of_measured_run` |

**REQ-F-33** Latency measurement shall use sub-millisecond precision timers
(`performance.now()` or `process.hrtime.bigint()`). Measurement shall bracket
only the `run(adapter)` call; setup and teardown shall not be included.

**REQ-F-34** Percentile computation shall sort all recorded iteration durations
and select the value at the corresponding rank, using nearest-rank or
linear-interpolation method consistently across all metrics.

#### 3.2.8 Output Files

**REQ-F-35** On completion, the runner shall write the following files to the
directory specified by `--out`:

| File | Format | Content |
|------|--------|---------|
| `results_<timestamp>.json` | JSON | All raw per-iteration timings and computed aggregates for every (adapter, case) pair |
| `results_<timestamp>.csv` | CSV | One row per (adapter, case) pair; aggregate statistics only |

**REQ-F-36** The timestamp in output filenames shall be in ISO 8601 format
with colons replaced by hyphens for filesystem compatibility, e.g.
`results_2026-03-19T12-00-00.json`.

**REQ-F-37** The CSV file shall contain the following columns:

```
adapter, case, iterations, concurrency, p50_ms, p95_ms, p99_ms,
mean_ms, min_ms, max_ms, throughput_ops
```

**REQ-F-38** The JSON file shall contain:
- Run metadata: timestamp, `--adapter`, `--case`, `--warmup`,
  `--iterations`, `--concurrency`
- Per (adapter, case) entry: computed aggregates (same fields as CSV) plus
  an array of all raw iteration durations in milliseconds

**REQ-F-39** The `bench/reports/` directory shall be listed in `.gitignore`.
Output files are not committed to the repository.

---

### 3.3 Usability Requirements

**REQ-U-01** The CLI shall print a human-readable error message to stderr for
user configuration errors, including: unknown adapter name, unknown case ID,
invalid numeric option value, missing required environment variable. Raw stack
traces shall not be shown for configuration errors.

**REQ-U-02** The project `README.md` shall document:
- Prerequisites (Node.js 20, Docker)
- All setup steps in order: `cp .env.example .env`, `docker compose up -d`,
  `npm install`, `npm run db:generate`, `npm run db:procs`, `npm run db:seed`
- All CLI options and their defaults
- All environment variables with example values

**REQ-U-03** The `.env.example` file shall list all required environment
variables with safe example values. A developer shall be able to start the
system without modifying `.env.example` other than copying it.

**REQ-U-04** The `npm run typecheck` script shall provide zero-output success
or a clearly formatted error listing for type failures, enabling quick
feedback during development.

---

### 3.4 Performance Requirements

**REQ-P-01** The runner's own measurement overhead shall not exceed 0.1 ms per
iteration. This overhead includes the time to record the start/end timestamp
and append the result to an in-memory array; it does not include the iteration
body (database round-trip).

**REQ-P-02** The system shall support `--concurrency` values up to at least 50
concurrent iterations without deadlocking, crashing, or producing incorrect
results.

**REQ-P-03** The `db:seed` script shall complete generation and insertion of
dataset size M (10 000 users, ~2 000 products, ~50 000 orders) within
**5 minutes** on a standard development machine (quad-core CPU, SSD, 8 GB RAM).

**REQ-P-04** The runner shall not hold database connections open between
iterations of different cases (i.e., connections shall be returned to the pool
promptly after each iteration completes, except for adapters that use
transaction-scoped connections).

---

### 3.5 Logical Database Requirements

**REQ-DB-01** The schema shall define B-tree indexes on all foreign key columns:
`products.category_id`, `orders.user_id`, `order_items.order_id`,
`order_items.product_id`, `payments.order_id`.

**REQ-DB-02** The schema shall define a unique B-tree index on `users.email`.

**REQ-DB-03** The schema shall define a B-tree index on `orders.created_at` to
support the range scans performed by the analytics benchmark cases.

**REQ-DB-04** All monetary and price columns shall be stored as `NUMERIC(10,2)`:
`products.price`, `orders.total`, `order_items.unit_price`, `payments.amount`.

**REQ-DB-05** The `pg` driver returns `NUMERIC` PostgreSQL columns as JavaScript
`string`. All domain types in `src/types.ts` shall use `string` for monetary
fields. This representation shall not be changed to `number` or `Decimal`.

**REQ-DB-06** Prisma returns `NUMERIC` columns as `Prisma.Decimal`. Adapters
using Prisma shall call `.toString()` on all `Decimal` values before
assigning them to domain type fields.

**REQ-DB-07** The `orders.status` and `payments.status` columns shall accept
the following values: `'pending'`, `'confirmed'`, `'shipped'`,
`'delivered'`, `'cancelled'`. No CHECK constraint is required, but the seed
and benchmark cases shall only use these values.

---

### 3.6 Design Constraints

**REQ-DC-01** All TypeScript source files shall pass `tsc --noEmit` with
`strict: true` and zero type errors. The `npm run typecheck` command shall
be the verification mechanism.

**REQ-DC-02** All SQL parameter values shall use positional placeholders
(`$1`, `$2`, … for `pg`), knex bindings, or Prisma parameterized queries.
String concatenation or template literals shall never be used to interpolate
user-supplied or externally-sourced values into SQL statements.

**REQ-DC-03** Each adapter shall implement its methods using the approach that
is natural and idiomatic for its library. The following constraints apply:
- The `raw` adapter shall use only `pg.Pool` and hand-written SQL with `$N`
  placeholders
- The `knex` adapter shall use only the `knex` query builder API; no raw SQL
  strings except where knex does not support the construct
- The `dal` adapter shall delegate all database access to the three repositories
  (`UserRepository`, `OrderRepository`, `ProductRepository`); repositories use
  `knex` internally
- The `orm` adapter shall use Prisma's fluent API for all CRUD operations and
  `$queryRaw` only for GROUP BY aggregations and window functions that the
  fluent API cannot express
- The `hybrid` adapter shall use Prisma for the six simple CRUD methods and
  `pg.Pool` for all other methods (see REQ-DC-05)
- The `stored-proc` adapter shall contain no SQL text in Node.js code; all
  logic resides in PL/pgSQL functions

**REQ-DC-04** The `stored-proc` adapter shall invoke PL/pgSQL functions using:
- `SELECT * FROM sp_<name>(...)` for functions returning a table / set of rows
- `SELECT sp_<name>(...) AS result` for scalar-returning functions

No SQL `INSERT`, `UPDATE`, `DELETE`, `SELECT ... FROM <table>`, or JOIN
statements shall appear in `src/clients/stored-proc/index.ts`.

**REQ-DC-05** The `hybrid` adapter shall use Prisma exclusively for the
following six methods: `findUserById`, `findUserByEmail`, `listUsers`,
`insertOneUser`, `updateOrderStatus`, `deleteOrder`. All remaining methods
(complex reads, analytics, write transactions) shall use `pg.Pool` directly.
All write transactions in the `hybrid` adapter shall use a single dedicated
`pg.PoolClient` connection to guarantee ACID semantics on a single connection.

**REQ-DC-06** The `DbAdapter` interface in `src/types.ts` is the single
contract. Any modification to the interface (addition, removal, or signature
change of a method) requires simultaneous update of all six adapter
implementations before the change is considered complete.

**REQ-DC-07** The PL/pgSQL stored functions shall cast `VARCHAR(n)` columns to
`text` explicitly in `RETURN QUERY` statements (e.g., `o.status::text`).
PostgreSQL validates types strictly at runtime for PL/pgSQL `RETURN QUERY`,
unlike SQL-language functions which coerce implicitly at parse time.

**REQ-DC-08** The benchmark cases in `bench/cases/index.ts` shall not contain
adapter-type checks or conditional logic. Each case's `run` function receives
only the `DbAdapter` interface and must not inspect or cast the adapter to a
concrete type.

---

### 3.7 Software System Attributes

#### 3.7.1 Reliability

**REQ-Q-01** The runner shall not silently discard adapter errors. Any
exception thrown by a `run(adapter)` call shall be caught, logged to stderr
with the adapter name, case name, and error message, and the (adapter, case)
pair shall be marked as failed in the output. The runner shall continue with
the remaining pairs.

**REQ-Q-02** Write benchmark cases (`createOrderWithItems` — BC-08,
`bulkCreateOrders` — BC-09, `insertManyProducts_500` — BC-10) shall delete all
records created during each iteration immediately after that iteration completes,
to prevent unbounded growth of the database and inter-iteration interference.

**REQ-Q-03** Connection pool exhaustion shall not cause silent hangs. If a pool
connection cannot be acquired within a reasonable timeout (≤ 10 seconds), the
adapter shall throw an error that the runner can catch per REQ-Q-01.

#### 3.7.2 Maintainability

**REQ-Q-04** New adapters shall be addable without modifying any existing
adapter code. The only required changes are:
1. Create `src/clients/<name>/index.ts` implementing `DbAdapter`
2. Register the new key in `bench/runner/index.ts`: add to the `AdapterName`
   union type, to `createAdapter()`, and to `ADAPTER_NAMES`

**REQ-Q-05** New benchmark cases shall be addable without modifying the runner.
The only required change is appending a `BenchCase` object to the array in
`bench/cases/index.ts`.

**REQ-Q-06** The PL/pgSQL function files (`db/procs/*.sql`) shall be
self-contained and idempotent. Running `npm run db:procs` multiple times shall
produce the same result as running it once.

#### 3.7.3 Portability

**REQ-Q-07** The system shall run without modification on Linux, macOS, and
Windows (via WSL2), provided Node.js 20 and Docker Engine are installed.

**REQ-Q-08** No OS-specific shell scripts shall be required for normal
operation. All commands shall be invokable via `npm run <script>`.

#### 3.7.4 Reproducibility

**REQ-Q-09** Given identical hardware, PostgreSQL configuration, `SEED_SIZE`,
`--warmup`, `--iterations`, `--concurrency`, and no significant background
system load, repeated benchmark runs shall produce statistically consistent
results. The p95 latency for any (adapter, case) pair shall vary by no more
than ±20% between runs under these conditions.

**REQ-Q-10** The seed script shall produce the same dataset when run multiple
times on the same machine with the same `SEED_SIZE` value. Email addresses
(`user_N@example.com`) and sequential IDs shall be deterministic.

#### 3.7.5 Security

**REQ-Q-11** Database credentials shall be stored in `.env` only, which shall
be listed in `.gitignore`. The `.env.example` file shall not contain real
credentials.

**REQ-Q-12** No user-supplied input is accepted during benchmark execution
(all inputs are CLI options provided by the developer). SQL injection via CLI
option values is not a realistic threat, but `$N` parameterization
(REQ-DC-02) shall be maintained regardless.

---

### 3.8 Supporting Information

#### 3.8.1 Adapter-Specific SQL Behaviour (Informational)

The following SQL-level differences between adapters are expected characteristics
of the respective libraries — not defects or deliberate degradations. They are
the primary data of the research:

| Behaviour | raw / knex / dal | Prisma (orm / hybrid) | stored-proc |
|-----------|------------------|-----------------------|-------------|
| Array lookup | `ANY($1::int[])` — 1 parameter | `IN($1, $2, …, $N)` — N parameters | Passed as PL/pgSQL array parameter |
| Relation fetch depth | Single JOIN query | Separate `SELECT` per relation level (N+1 pattern by design) | Single JOIN inside PL/pgSQL function |
| Batch INSERT | One multi-row `VALUES` statement | One `INSERT` per row via Prisma's `create` | One multi-row `VALUES` inside PL/pgSQL |
| Write transaction | `BEGIN` / batch SQL / `COMMIT` on one client | Prisma's implicit transaction per `create` call | `BEGIN` / SQL / `COMMIT` inside PL/pgSQL — 1 round-trip total |

#### 3.8.2 Key Differentiators Per Benchmark Category (Informational)

**Baseline cases (BC-01, BC-02):** Establish a reference point. Expected
latency differences to be small (< 2×); any larger gap indicates connection
or pool overhead specific to the library.

**Read – heavy (BC-04):** The `ANY($1::int[])` vs. `IN($1…$500)` comparison
isolates parameter serialization and query-plan cache efficiency. With 500
parameters, query plan reuse becomes less likely for the `IN` variant.

**Read – key (BC-05):** `getTopOrdersWithItems` is the most impactful read
case. Prisma's `include` API issues a separate `SELECT` for each relation
level; for 5 orders × items × 1 item-level, this produces ~6 round-trips vs.
1 for adapters that use a JOIN. Under concurrency, this difference is amplified
linearly.

**Write – key (BC-09):** `bulkCreateOrders` (5 orders × 10 items) produces
15 SQL statements for raw/knex/dal (1 order INSERT + 1 batch items INSERT per
order) vs. 60 statements for Prisma (1 order INSERT + 10 individual item
INSERTs per order). The `stored-proc` adapter executes the entire bulk
operation in 1 network round-trip.

---

## 4. Verification

The following table maps each key requirement to its verification method and
acceptance criterion:

| Req ID | Requirement Summary | Verification Method | Acceptance Criterion |
|--------|---------------------|--------------------|--------------------|
| REQ-UI-02 | CLI accepts all documented options | Run `npm run bench -- --help` | All options listed in help output |
| REQ-UI-05 | CLI exits non-zero on error | Run with invalid `--adapter unknown` | Exit code ≠ 0; error message on stderr |
| REQ-F-01 | Docker applies schema on first start | `docker compose up -d` then `psql -c '\dt'` | All 6 tables present |
| REQ-F-03 | `db:procs` applies functions idempotently | Run `npm run db:procs` twice | No errors on second run; `\df sp_*` lists all functions |
| REQ-F-06 | Seed generates deterministic emails | `SELECT email FROM users WHERE id = 500` | Returns `user_500@example.com` |
| REQ-F-09 / REQ-F-13 | All adapters implement `DbAdapter` | `npm run typecheck` | Zero type errors |
| REQ-F-11 | All adapters return identical data | Manual comparison of JSON output for same input across adapters | Semantically identical results |
| REQ-F-18 | BC-04 uses exactly 500 IDs | Code inspection of `bench/cases/index.ts` | Array of length 500 passed to `batchGetUsers` |
| REQ-F-20 | BC-09 uses 5 orders × 10 items | Code inspection | 5 `NewOrderWithItems` objects, each with 10 items |
| REQ-F-32 | All 7 metrics computed per pair | Inspect output JSON file | Fields `p50`, `p95`, `p99`, `mean`, `min`, `max`, `throughput` present |
| REQ-F-35/36 | JSON and CSV output files created | Run `npm run bench`; inspect `bench/reports/` | Both files present with timestamp suffix |
| REQ-F-37 | CSV has required columns | Open CSV in text editor | All 11 columns present in header row |
| REQ-DC-01 | TypeScript strict mode, zero errors | `npm run typecheck` exits 0 | Exit code 0, no output |
| REQ-DC-02 | No SQL string interpolation | Code inspection / grep for template literals in SQL context | No instances found |
| REQ-DC-04 | `stored-proc` has no SQL text | Code inspection of `src/clients/stored-proc/index.ts` | No `INSERT`, `UPDATE`, `SELECT ... FROM <table>` strings |
| REQ-DB-01/02/03 | Indexes present | `\d+ orders`, `\d+ users`, `\d+ order_items` in psql | All required indexes listed |
| REQ-P-02 | Concurrency up to 50 | `npm run bench -- --concurrency 50 --iterations 20` | Completes without deadlock, crash, or error |
| REQ-Q-02 | Write cases clean up after themselves | Count rows before and after a bench run of BC-08, BC-09, BC-10 | Row counts identical before and after |
| REQ-Q-07 | Runs on WSL2 | Execute full benchmark on WSL2 environment | Completes successfully |
| REQ-Q-11 | `.env` not committed | `git ls-files .env` | No output (file not tracked) |

---

## 5. Appendices

### Appendix A — Environment Variables

| Variable | Example Value | Required by | Description |
|----------|--------------|-------------|-------------|
| `PG_HOST` | `localhost` | raw, knex, dal, hybrid, stored-proc | PostgreSQL server hostname |
| `PG_PORT` | `5433` | raw, knex, dal, hybrid, stored-proc | PostgreSQL server port (Docker-mapped) |
| `PG_USER` | `postgres` | all adapters | PostgreSQL username |
| `PG_PASSWORD` | `postgres` | all adapters | PostgreSQL password |
| `PG_DATABASE` | `nuremageris` | all adapters | Database name |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5433/nuremageris` | orm, hybrid | Prisma connection string |
| `SEED_SIZE` | `S`, `M`, or `L` | db:seed script | Dataset size for seeding |

### Appendix B — Project Directory Structure

```
/
├── .env                        # Local config (gitignored)
├── .env.example                # Template with example values
├── docker-compose.yml          # PostgreSQL 16 service definition
├── package.json
├── tsconfig.json               # strict: true
├── prisma/
│   └── schema.prisma           # Prisma schema (mirrors 001_schema.sql)
├── configs/
│   ├── db.ts                   # pg Pool configuration
│   └── bench.ts                # Default benchmark parameters
├── db/
│   ├── schema/
│   │   └── 001_schema.sql      # DDL — single source of truth for schema
│   ├── procs/
│   │   ├── 001_users.sql       # sp_find_user_by_id, sp_find_user_by_email, etc.
│   │   ├── 002_orders.sql      # sp_get_order_with_details, sp_create_order_with_items, etc.
│   │   ├── 003_analytics.sql   # sp_get_product_sales_report, sp_get_monthly_revenue_trend, etc.
│   │   └── apply.ts            # Idempotent procedure applicator
│   └── seed/
│       └── seed.ts             # Synthetic data generator
├── src/
│   ├── types.ts                # Domain types + DbAdapter interface
│   └── clients/
│       ├── raw-sql/
│       │   └── index.ts        # RawSqlAdapter (pg Pool)
│       ├── query-builder/
│       │   └── index.ts        # QueryBuilderAdapter (knex)
│       ├── data-access-layer/
│       │   ├── repositories/
│       │   │   ├── UserRepository.ts
│       │   │   ├── OrderRepository.ts
│       │   │   └── ProductRepository.ts
│       │   └── index.ts        # DataAccessLayerAdapter
│       ├── orm/
│       │   └── index.ts        # PrismaAdapter
│       ├── hybrid-orm/
│       │   └── index.ts        # HybridAdapter
│       └── stored-proc/
│           └── index.ts        # StoredProcAdapter
├── bench/
│   ├── cases/
│   │   └── index.ts            # BenchCase[] — 10 cases
│   ├── runner/
│   │   └── index.ts            # CLI entry point (commander)
│   └── reports/                # (gitignored) JSON + CSV output
└── docs/
    └── SRS.md                  # This document
```

### Appendix C — npm Scripts Reference

| Script | Command | Description |
|--------|---------|-------------|
| `db:generate` | `prisma generate` | Generate Prisma client from `schema.prisma` |
| `db:procs` | `tsx db/procs/apply.ts` | Apply PL/pgSQL functions idempotently |
| `db:seed` | `tsx db/seed/seed.ts` | Populate database (use `SEED_SIZE=S\|M\|L`) |
| `bench` | `tsx bench/runner/index.ts` | Run benchmarks (accepts CLI options) |
| `typecheck` | `tsc --noEmit` | TypeScript strict-mode check |

### Appendix D — Setup Quick-Start

```bash
# 1. Configure environment
cp .env.example .env

# 2. Start PostgreSQL (applies schema automatically on first start)
docker compose up -d

# 3. Install Node.js dependencies
npm install

# 4. Generate Prisma client (required for orm and hybrid adapters)
npm run db:generate

# 5. Apply PL/pgSQL stored functions (required for stored-proc adapter)
npm run db:procs

# 6. Seed the database (default size M)
npm run db:seed

# 7. Run all benchmarks
npm run bench

# Optional: selective run
npm run bench -- --adapter raw,knex,orm --case getTopOrdersWithItems,bulkCreateOrders --iterations 100 --concurrency 10 --report
```

### Appendix E — PL/pgSQL Function Inventory

The following PL/pgSQL functions are defined in `db/procs/` and are required
by the `stored-proc` adapter:

| Function | File | Returns | Corresponds to `DbAdapter` method |
|----------|------|---------|----------------------------------|
| `sp_find_user_by_id(p_id INT)` | 001_users.sql | `SETOF users` | `findUserById` |
| `sp_find_user_by_email(p_email TEXT)` | 001_users.sql | `SETOF users` | `findUserByEmail` |
| `sp_list_users(p_page INT, p_page_size INT)` | 001_users.sql | `SETOF users` | `listUsers` |
| `sp_insert_one_user(p_name TEXT, p_email TEXT)` | 001_users.sql | `SETOF users` | `insertOneUser` |
| `sp_batch_get_users(p_ids INT[])` | 001_users.sql | `SETOF users` | `batchGetUsers` |
| `sp_get_order_with_details(p_order_id INT)` | 002_orders.sql | custom composite type | `getOrderWithDetails` |
| `sp_get_top_orders_with_items(p_limit INT)` | 002_orders.sql | custom composite type | `getTopOrdersWithItems` |
| `sp_create_order_with_items(...)` | 002_orders.sql | `SETOF orders` | `createOrderWithItems` |
| `sp_bulk_create_orders(...)` | 002_orders.sql | `SETOF orders` | `bulkCreateOrders` |
| `sp_update_order_status(p_id INT, p_status TEXT)` | 002_orders.sql | `SETOF orders` | `updateOrderStatus` |
| `sp_delete_order(p_id INT)` | 002_orders.sql | `VOID` | `deleteOrder` |
| `sp_insert_many_products(...)` | 002_orders.sql | `SETOF products` | `insertManyProducts` |
| `sp_get_product_sales_report()` | 003_analytics.sql | custom composite type | `getProductSalesReport` |
| `sp_get_monthly_revenue_trend(p_months INT)` | 003_analytics.sql | custom composite type | `getMonthlyRevenueTrend` |

---

*End of document.*
*Prepared in accordance with IEEE 29148:2018.*
