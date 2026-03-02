import type { DbAdapter, NewOrderInput } from "../../src/types";

// ------------------------------------------------------------------
// BenchCase definition
// ------------------------------------------------------------------

export interface CaseContext {
  [key: string]: unknown;
}

export interface BenchCase {
  name: string;
  description: string;
  /** Called once before warmup. Use to store ids / state into ctx. */
  setup?: (adapter: DbAdapter, ctx: CaseContext) => Promise<void>;
  /** The measured call. Must be idempotent or produce throwaway data. */
  run: (adapter: DbAdapter, ctx: CaseContext) => Promise<unknown>;
  /** Called once after all iterations. */
  teardown?: (adapter: DbAdapter, ctx: CaseContext) => Promise<void>;
}

// ------------------------------------------------------------------
// Case definitions
// ------------------------------------------------------------------

// Helpers
const makeOrderInput = (userId: number, itemCount: number, baseProductId: number): NewOrderInput => ({
  userId,
  items: Array.from({ length: itemCount }, (_, i) => ({
    productId: ((baseProductId + i) % 100) + 1, // cycle through first 100 products
    quantity:  (i % 5) + 1,
    unitPrice: Math.round(((i + 1) * 7.99) * 100) / 100,
  })),
  paymentAmount: Math.round(itemCount * 15.5 * 100) / 100,
});

export const cases: BenchCase[] = [
  // ── Baseline simple (kept for reference) ─────────────────────────

  {
    name: "findUserById",
    description: "Baseline: PK lookup – SELECT by id (single indexed read)",
    async setup(_adapter, ctx) {
      ctx.userId = 500;
    },
    async run(adapter, ctx) {
      return adapter.findUserById(ctx.userId as number);
    },
  },

  {
    name: "listUsers_paged",
    description: "Baseline: paginated list – LIMIT 20, ORDER BY created_at DESC",
    async run(adapter) {
      return adapter.listUsers(
        {},
        { field: "created_at", dir: "desc" },
        { page: 1, limit: 20 }
      );
    },
  },

  // ── Read – medium: multi-query vs ORM include ─────────────────────

  {
    name: "getOrderWithDetails",
    description:
      "2-query read: order+user then items+products (raw/knex/dal) vs " +
      "Prisma 4-query include (orders→users→order_items→products)",
    async run(adapter) {
      return adapter.getOrderWithDetails(100);
    },
  },

  {
    name: "batchGetUsers_500",
    description:
      "Batch fetch 500 users: raw uses ANY($1::int[]) (1 param) vs " +
      "knex/dal/orm generate IN($1…$500) (500 params) – query parse overhead",
    async run(adapter) {
      const ids = Array.from({ length: 500 }, (_, i) => i + 1);
      return adapter.batchGetUsers(ids);
    },
  },

  // ── Read – heavy: single JOIN vs N round-trips ────────────────────

  {
    name: "getTopOrdersWithItems",
    description:
      "20 orders with full hierarchy (user + items + products + categories + payment): " +
      "raw/knex/dal → 1 JOIN query; orm (Prisma include) → 6 separate SELECT queries + JS merge. " +
      "Under concurrency Prisma holds pool connections 6× longer.",
    async run(adapter) {
      return adapter.getTopOrdersWithItems(20);
    },
  },

  // ── Analytics ─────────────────────────────────────────────────────

  {
    name: "getProductSalesReport",
    description:
      "Category analytics: GROUP BY + COUNT DISTINCT + SUM across " +
      "categories→products→order_items. All adapters hit the same SQL path; " +
      "shows $queryRaw overhead (Prisma) vs direct pool (raw) under concurrency.",
    async run(adapter) {
      return adapter.getProductSalesReport();
    },
  },

  {
    name: "getMonthlyRevenueTrend",
    description:
      "CTE + window function (SUM OVER): rolling 12-month revenue with running total. " +
      "Prisma uses $queryRaw; knex/dal use db.raw(); raw uses pool.query() directly.",
    async run(adapter) {
      return adapter.getMonthlyRevenueTrend(12);
    },
  },

  // ── Write – single transaction with many items ────────────────────

  {
    name: "createOrderWithItems",
    description:
      "Transaction: 1 order + 15 items (batch) + 1 payment. " +
      "raw/knex/dal → 1 batch INSERT for items (1 round-trip); " +
      "Prisma → 15 individual INSERT per item (15× more round-trips inside transaction).",
    async run(adapter) {
      return adapter.createOrderWithItems(makeOrderInput(1, 15, 1));
    },
  },

  // ── Write – bulk transaction (maximum write overhead delta) ───────

  {
    name: "bulkCreateOrders",
    description:
      "5 orders × 10 items each in a single transaction (+ 5 payments). " +
      "raw/knex/dal → 5 batch INSERTs = 15 statements total; " +
      "Prisma → 5×10 individual item INSERTs = 60 statements total (4× more). " +
      "Most discriminating write case under concurrency.",
    async run(adapter) {
      const orders = Array.from({ length: 5 }, (_, i) =>
        makeOrderInput((i % 200) + 1, 10, i * 10)
      );
      return adapter.bulkCreateOrders(orders);
    },
  },

  // ── Write – bulk INSERT throughput ───────────────────────────────

  {
    name: "insertManyProducts_500",
    description:
      "Bulk INSERT 500 product rows in one statement. " +
      "raw → single multi-value INSERT with 2000 params (manual placeholder generation); " +
      "knex/dal → knex batch insert (same SQL, different param handling); " +
      "Prisma createMany → single INSERT. JS overhead of building 2000 params is measurable.",
    async run(adapter) {
      const rows = Array.from({ length: 500 }, (_, i) => ({
        categoryId: (i % 5) + 1,
        name:       `BenchProd_${Date.now()}_${i}`,
        price:      Math.round(((i + 1) * 3.99) * 100) / 100,
        stock:      50,
      }));
      return adapter.insertManyProducts(rows);
    },
  },
];

export const caseMap: Record<string, BenchCase> = Object.fromEntries(
  cases.map((c) => [c.name, c])
);
