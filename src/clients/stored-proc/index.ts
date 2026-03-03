import { Pool } from 'pg'
import { dbConfig } from '../../../configs/db'
import type {
  DbAdapter, User, OrderWithDetails, OrderWithItems, UserOrderTotal, LastOrderPerUser,
  Order, ListUsersFilters, SortOptions, PageOptions, NewOrderInput,
  ProductSalesReport, MonthlyRevenue, Payment,
} from '../../types'

// StoredProcAdapter: all DbAdapter methods delegate to PostgreSQL functions.
// Node only passes parameters and reads results — no SQL text in application code.
//
// Routing summary:
//   Simple reads  → sp_find_user_by_id / sp_find_user_by_email / sp_list_users_paged
//                   sp_batch_get_users / sp_get_user_order_totals
//   Heavy reads   → sp_get_last_order_per_user (CTE + window inside the function)
//   Deep join     → sp_get_top_orders_with_items (flat table rows, aggregated in Node)
//   Single-obj    → sp_get_order_with_details (jsonb, 1 round-trip)
//   Analytics     → sp_get_product_sales_report / sp_get_monthly_revenue_trend
//   Writes        → sp_insert_one_user / sp_insert_many_products
//   Tx writes     → sp_create_order_with_items / sp_bulk_create_orders
//                   (entire transaction in one function call = 1 round-trip)
//   Mutations     → sp_update_order_status / sp_delete_order

// Internal row shape returned by sp_get_top_orders_with_items
interface TopOrderRow {
  order_id:         number
  user_id:          number
  status:           string
  order_total:      string
  order_created_at: Date
  user_email:       string
  user_name:        string
  item_id:          number
  product_id:       number
  quantity:         number
  unit_price:       string
  product_name:     string
  category_name:    string
  pay_id:           number | null
  pay_amount:       string | null
  pay_status:       string | null
  pay_paid_at:      Date | null
}

export class StoredProcAdapter implements DbAdapter {
  private readonly pool: Pool

  constructor() {
    this.pool = new Pool({
      host:                    dbConfig.host,
      port:                    dbConfig.port,
      database:                dbConfig.database,
      user:                    dbConfig.user,
      password:                dbConfig.password,
      min:                     dbConfig.pool.min,
      max:                     dbConfig.pool.max,
      connectionTimeoutMillis: dbConfig.pool.connectionTimeoutMs,
      idleTimeoutMillis:       dbConfig.pool.idleTimeoutMs,
    })
  }

  // ------------------------------------------------------------------
  // Read – simple
  // ------------------------------------------------------------------

  async findUserById(id: number): Promise<User | null> {
    const { rows } = await this.pool.query<User>(
      'SELECT * FROM sp_find_user_by_id($1)', [id]
    )
    return rows[0] ?? null
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const { rows } = await this.pool.query<User>(
      'SELECT * FROM sp_find_user_by_email($1)', [email]
    )
    return rows[0] ?? null
  }

  async listUsers(filters: ListUsersFilters, sort: SortOptions, page: PageOptions): Promise<User[]> {
    const { rows } = await this.pool.query<User>(
      'SELECT * FROM sp_list_users_paged($1, $2, $3, $4, $5, $6)',
      [
        filters.search        ?? null,
        filters.createdAfter  ?? null,
        sort.field,
        sort.dir,
        page.limit,
        (page.page - 1) * page.limit,
      ]
    )
    return rows
  }

  // ------------------------------------------------------------------
  // Read – medium
  // ------------------------------------------------------------------

  // sp_get_order_with_details returns jsonb — 1 round-trip (vs 2 for raw/knex/dal).
  // Timestamps inside jsonb come as ISO strings; we convert them to Date here.
  async getOrderWithDetails(orderId: number): Promise<OrderWithDetails | null> {
    const { rows } = await this.pool.query<{ result: any }>(
      'SELECT sp_get_order_with_details($1) AS result', [orderId]
    )
    const data = rows[0]?.result
    if (!data) return null

    return {
      order: {
        id:         data.order.id,
        user_id:    data.order.user_id,
        status:     data.order.status,
        total:      data.order.total,
        created_at: new Date(data.order.created_at),
      },
      user: data.user,
      items: (data.items as Array<any>).map(it => ({
        id:           it.id,
        order_id:     it.order_id,
        product_id:   it.product_id,
        quantity:     it.quantity,
        unit_price:   it.unit_price,
        product_name: it.product_name,
      })),
    }
  }

  async getUserOrderTotals(limit = 20): Promise<UserOrderTotal[]> {
    const { rows } = await this.pool.query<UserOrderTotal>(
      'SELECT * FROM sp_get_user_order_totals($1)', [limit]
    )
    return rows
  }

  // ------------------------------------------------------------------
  // Read – heavy
  // ------------------------------------------------------------------

  async getLastOrderPerUser(limit = 20): Promise<LastOrderPerUser[]> {
    const { rows } = await this.pool.query<LastOrderPerUser>(
      'SELECT * FROM sp_get_last_order_per_user($1)', [limit]
    )
    return rows
  }

  async batchGetUsers(ids: number[]): Promise<User[]> {
    if (ids.length === 0) return []
    const { rows } = await this.pool.query<User>(
      'SELECT * FROM sp_batch_get_users($1::int[])', [ids]
    )
    return rows
  }

  // ------------------------------------------------------------------
  // Read – deep join
  // ------------------------------------------------------------------

  // Returns flat rows identical to raw adapter's query shape; aggregation in Node.
  async getTopOrdersWithItems(limit: number): Promise<OrderWithItems[]> {
    const { rows } = await this.pool.query<TopOrderRow>(
      'SELECT * FROM sp_get_top_orders_with_items($1)', [limit]
    )
    return this.aggregateOrderRows(rows)
  }

  private aggregateOrderRows(rows: TopOrderRow[]): OrderWithItems[] {
    const map = new Map<number, OrderWithItems>()

    for (const row of rows) {
      if (!map.has(row.order_id)) {
        const payment: Payment | null = row.pay_id !== null
          ? {
              id:       row.pay_id,
              order_id: row.order_id,
              amount:   row.pay_amount ?? '0',
              status:   row.pay_status ?? 'pending',
              paid_at:  row.pay_paid_at,
            }
          : null

        map.set(row.order_id, {
          order: {
            id:         row.order_id,
            user_id:    row.user_id,
            status:     row.status,
            total:      row.order_total,
            created_at: row.order_created_at,
          },
          user: {
            id:    row.user_id,
            email: row.user_email,
            name:  row.user_name,
          },
          items:   [],
          payment,
        })
      }

      map.get(row.order_id)!.items.push({
        id:            row.item_id,
        order_id:      row.order_id,
        product_id:    row.product_id,
        quantity:      row.quantity,
        unit_price:    row.unit_price,
        product_name:  row.product_name,
        category_name: row.category_name,
      })
    }

    return [...map.values()]
  }

  // ------------------------------------------------------------------
  // Analytics
  // ------------------------------------------------------------------

  async getProductSalesReport(): Promise<ProductSalesReport[]> {
    const { rows } = await this.pool.query<ProductSalesReport>(
      'SELECT * FROM sp_get_product_sales_report()'
    )
    return rows
  }

  async getMonthlyRevenueTrend(months: number): Promise<MonthlyRevenue[]> {
    const { rows } = await this.pool.query<MonthlyRevenue>(
      'SELECT * FROM sp_get_monthly_revenue_trend($1)', [months]
    )
    return rows
  }

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------

  async insertOneUser(data: { email: string; name: string }): Promise<User> {
    const { rows } = await this.pool.query<User>(
      'SELECT * FROM sp_insert_one_user($1, $2)', [data.email, data.name]
    )
    return rows[0]
  }

  async insertManyProducts(
    data: Array<{ categoryId: number; name: string; price: number; stock: number }>
  ): Promise<number> {
    if (data.length === 0) return 0
    const payload = JSON.stringify(
      data.map(d => ({ categoryId: d.categoryId, name: d.name, price: d.price, stock: d.stock }))
    )
    const { rows } = await this.pool.query<{ result: number }>(
      'SELECT sp_insert_many_products($1::jsonb) AS result', [payload]
    )
    return rows[0].result
  }

  // sp_create_order_with_items executes BEGIN/INSERT×3/COMMIT inside one function call.
  // This is the key advantage: 1 network round-trip vs 5 (raw) or more (Prisma).
  async createOrderWithItems(data: NewOrderInput): Promise<Order> {
    const items = JSON.stringify(
      data.items.map(it => ({ productId: it.productId, quantity: it.quantity, unitPrice: it.unitPrice }))
    )
    const { rows } = await this.pool.query<Order>(
      'SELECT * FROM sp_create_order_with_items($1, $2::jsonb, $3)',
      [data.userId, items, data.paymentAmount]
    )
    return rows[0]
  }

  // 5 orders × 10 items: 1 function call vs 15 statements (raw) vs 60 (Prisma).
  async bulkCreateOrders(orders: NewOrderInput[]): Promise<Order[]> {
    if (orders.length === 0) return []
    const payload = JSON.stringify(
      orders.map(o => ({
        userId:        o.userId,
        paymentAmount: o.paymentAmount,
        items:         o.items.map(it => ({ productId: it.productId, quantity: it.quantity, unitPrice: it.unitPrice })),
      }))
    )
    const { rows } = await this.pool.query<Order>(
      'SELECT * FROM sp_bulk_create_orders($1::jsonb)', [payload]
    )
    return rows
  }

  // ------------------------------------------------------------------
  // Update / Delete
  // ------------------------------------------------------------------

  async updateOrderStatus(orderId: number, status: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ result: boolean }>(
      'SELECT sp_update_order_status($1, $2) AS result', [orderId, status]
    )
    return rows[0].result
  }

  async deleteOrder(orderId: number): Promise<boolean> {
    const { rows } = await this.pool.query<{ result: boolean }>(
      'SELECT sp_delete_order($1) AS result', [orderId]
    )
    return rows[0].result
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async close(): Promise<void> {
    await this.pool.end()
  }
}
