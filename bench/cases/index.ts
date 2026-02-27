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

export const cases: BenchCase[] = [
  // ── Read simple ──────────────────────────────────────────────────

  {
    name: "findUserById",
    description: "PK lookup - SELECT by id",
    async setup(_adapter, ctx) {
      ctx.userId = 500; // assumes seeded data has at least 500 users
    },
    async run(adapter, ctx) {
      return adapter.findUserById(ctx.userId as number);
    },
  },

  {
    name: "findUserByEmail",
    description: "Lookup by indexed email field",
    async run(adapter) {
      return adapter.findUserByEmail("user_500@example.com");
    },
  },

  {
    name: "listUsers_paged",
    description: "Paginated list – page 1, 20 rows, ORDER BY created_at DESC",
    async run(adapter) {
      return adapter.listUsers(
        {},
        { field: "created_at", dir: "desc" },
        { page: 1, limit: 20 }
      );
    },
  },

  {
    name: "listUsers_filtered",
    description: "Paginated list with ILIKE name filter",
    async run(adapter) {
      return adapter.listUsers(
        { search: "an" },
        { field: "name", dir: "asc" },
        { page: 1, limit: 20 }
      );
    },
  },

  // ── Read medium ──────────────────────────────────────────────────

  {
    name: "getOrderWithDetails",
    description: "JOIN orders + users + order_items + products (3 tables)",
    async run(adapter) {
      return adapter.getOrderWithDetails(100);
    },
  },

  {
    name: "getUserOrderTotals",
    description: "Aggregation – SUM total per user with GROUP BY",
    async run(adapter) {
      return adapter.getUserOrderTotals(50);
    },
  },

  // ── Read heavy ───────────────────────────────────────────────────

  {
    name: "getLastOrderPerUser",
    description: "CTE + ROW_NUMBER – Top-1 order per user",
    async run(adapter) {
      return adapter.getLastOrderPerUser(50);
    },
  },

  {
    name: "batchGetUsers",
    description: "Batch fetch – WHERE id IN (...) for 100 ids",
    async run(adapter) {
      const ids = Array.from({ length: 100 }, (_, i) => i + 1);
      return adapter.batchGetUsers(ids);
    },
  },

  // ── Write ────────────────────────────────────────────────────────

  {
    name: "insertOneUser",
    description: "Single INSERT INTO users RETURNING",
    async run(adapter) {
      const ts = Date.now();
      return adapter.insertOneUser({
        email: `bench_${ts}@test.com`,
        name: `Bench ${ts}`,
      });
    },
  },

  {
    name: "insertManyProducts_100",
    description: "Bulk INSERT 100 rows in one statement",
    async run(adapter) {
      const rows = Array.from({ length: 100 }, (_, i) => ({
        categoryId: 1,
        name: `BenchProduct_${Date.now()}_${i}`,
        price: Math.random() * 100,
        stock: 50,
      }));
      return adapter.insertManyProducts(rows);
    },
  },

  {
    name: "createOrderWithItems",
    description: "Transactional write – order + 3 items + payment",
    async run(adapter) {
      const data: NewOrderInput = {
        userId: 1,
        items: [
          { productId: 1, quantity: 2, unitPrice: 9.99 },
          { productId: 2, quantity: 1, unitPrice: 24.99 },
          { productId: 3, quantity: 3, unitPrice: 4.5 },
        ],
        paymentAmount: 59.47,
      };
      return adapter.createOrderWithItems(data);
    },
  },

  // ── Update / Delete ───────────────────────────────────────────────

  {
    name: "updateOrderStatus",
    description: "UPDATE single row by PK",
    async run(adapter) {
      return adapter.updateOrderStatus(1, "shipped");
    },
  },
];

export const caseMap: Record<string, BenchCase> = Object.fromEntries(
  cases.map((c) => [c.name, c])
);
