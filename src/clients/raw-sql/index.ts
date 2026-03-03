import { Pool, PoolClient } from 'pg'
import { dbConfig } from '../../../configs/db'
import type {
  DbAdapter, User, OrderWithDetails, OrderWithItems, UserOrderTotal, LastOrderPerUser,
  Order, ListUsersFilters, SortOptions, PageOptions, NewOrderInput,
  ProductSalesReport, MonthlyRevenue, Payment,
} from '../../types'

const ALLOWED_SORT_FIELDS = new Set(['id', 'name', 'email', 'created_at'])

// Internal row shape returned by getTopOrdersWithItems JOIN query
interface TopOrderRow {
  order_id:        number
  user_id:         number
  status:          string
  order_total:     string
  order_created_at: Date
  user_email:      string
  user_name:       string
  item_id:         number
  product_id:      number
  quantity:        number
  unit_price:      string
  product_name:    string
  category_name:   string
  pay_id:          number | null
  pay_amount:      string | null
  pay_status:      string | null
  pay_paid_at:     Date | null
}

export class RawSqlAdapter implements DbAdapter {
  private pool: Pool

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
      'SELECT id, email, name, created_at FROM users WHERE id = $1',
      [id]
    )
    return rows[0] ?? null
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const { rows } = await this.pool.query<User>(
      'SELECT id, email, name, created_at FROM users WHERE email = $1',
      [email]
    )
    return rows[0] ?? null
  }

  async listUsers(filters: ListUsersFilters, sort: SortOptions, page: PageOptions): Promise<User[]> {
    const conditions: string[] = []
    const params: unknown[]    = []
    let p = 1

    if (filters.createdAfter) {
      conditions.push(`created_at > $${p++}`)
      params.push(filters.createdAfter)
    }
    if (filters.search) {
      conditions.push(`name ILIKE $${p++}`)
      params.push(`%${filters.search}%`)
    }

    const where    = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const sortCol  = ALLOWED_SORT_FIELDS.has(sort.field) ? sort.field : 'id'
    const sortDir  = sort.dir === 'desc' ? 'DESC' : 'ASC'
    const offset   = (page.page - 1) * page.limit

    params.push(page.limit, offset)

    const sql = `
      SELECT id, email, name, created_at
      FROM users
      ${where}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT $${p++} OFFSET $${p}
    `
    const { rows } = await this.pool.query<User>(sql, params)
    return rows
  }

  // ------------------------------------------------------------------
  // Read – medium
  // ------------------------------------------------------------------

  async getOrderWithDetails(orderId: number): Promise<OrderWithDetails | null> {
    const { rows: [row] } = await this.pool.query(
      `SELECT o.id, o.user_id, o.status, o.total, o.created_at,
              u.id AS uid, u.email AS user_email, u.name AS user_name
       FROM orders o
       JOIN users u ON u.id = o.user_id
       WHERE o.id = $1`,
      [orderId]
    )
    if (!row) return null

    const { rows: items } = await this.pool.query(
      `SELECT oi.id, oi.order_id, oi.product_id, oi.quantity, oi.unit_price,
              p.name AS product_name
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1`,
      [orderId]
    )

    return {
      order: { id: row.id, user_id: row.user_id, status: row.status, total: row.total, created_at: row.created_at },
      user:  { id: row.uid, email: row.user_email, name: row.user_name },
      items,
    }
  }

  async getUserOrderTotals(limit = 20): Promise<UserOrderTotal[]> {
    const { rows } = await this.pool.query<UserOrderTotal>(
      `SELECT u.id AS user_id, u.name AS user_name,
              COUNT(o.id)::int AS order_count,
              COALESCE(SUM(o.total), 0)::text AS total_spent
       FROM users u
       LEFT JOIN orders o ON o.user_id = u.id
       GROUP BY u.id, u.name
       ORDER BY COALESCE(SUM(o.total), 0) DESC
       LIMIT $1`,
      [limit]
    )
    return rows
  }

  // ------------------------------------------------------------------
  // Read – heavy
  // ------------------------------------------------------------------

  async getLastOrderPerUser(limit = 20): Promise<LastOrderPerUser[]> {
    const { rows } = await this.pool.query<LastOrderPerUser>(
      `WITH ranked AS (
         SELECT o.id          AS last_order_id,
                o.user_id,
                o.total       AS last_order_total,
                o.created_at  AS last_order_at,
                ROW_NUMBER() OVER (PARTITION BY o.user_id ORDER BY o.created_at DESC) AS rn
         FROM orders o
       )
       SELECT r.user_id, u.email AS user_email,
              r.last_order_id, r.last_order_total, r.last_order_at
       FROM ranked r
       JOIN users u ON u.id = r.user_id
       WHERE r.rn = 1
       ORDER BY r.last_order_at DESC
       LIMIT $1`,
      [limit]
    )
    return rows
  }

  async batchGetUsers(ids: number[]): Promise<User[]> {
    if (ids.length === 0) return []
    const { rows } = await this.pool.query<User>(
      'SELECT id, email, name, created_at FROM users WHERE id = ANY($1::int[])',
      [ids]
    )
    return rows
  }

  // ------------------------------------------------------------------
  // Read – deep join (1 query vs Prisma's 6 separate queries)
  // ------------------------------------------------------------------

  async getTopOrdersWithItems(limit: number): Promise<OrderWithItems[]> {
    const { rows } = await this.pool.query<TopOrderRow>(
      `SELECT
         o.id            AS order_id,
         o.user_id,
         o.status,
         o.total         AS order_total,
         o.created_at    AS order_created_at,
         u.email         AS user_email,
         u.name          AS user_name,
         oi.id           AS item_id,
         oi.product_id,
         oi.quantity,
         oi.unit_price,
         p.name          AS product_name,
         c.name          AS category_name,
         pay.id          AS pay_id,
         pay.amount      AS pay_amount,
         pay.status      AS pay_status,
         pay.paid_at     AS pay_paid_at
       FROM (SELECT id FROM orders ORDER BY created_at DESC LIMIT $1) top
       JOIN orders o           ON o.id = top.id
       JOIN users u            ON u.id = o.user_id
       JOIN order_items oi     ON oi.order_id = o.id
       JOIN products p         ON p.id = oi.product_id
       JOIN categories c       ON c.id = p.category_id
       LEFT JOIN payments pay  ON pay.order_id = o.id
       ORDER BY o.created_at DESC, oi.id`,
      [limit]
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
      `SELECT
         c.id                                                         AS category_id,
         c.name                                                       AS category_name,
         COUNT(DISTINCT p.id)::int                                    AS product_count,
         ROUND(AVG(p.price), 2)::text                                 AS avg_price,
         COALESCE(SUM(p.stock), 0)::int                               AS total_stock,
         COUNT(DISTINCT oi.order_id)::int                             AS orders_count,
         COALESCE(SUM(oi.quantity * oi.unit_price), 0)::text          AS revenue
       FROM categories c
       LEFT JOIN products p     ON p.category_id = c.id
       LEFT JOIN order_items oi ON oi.product_id = p.id
       GROUP BY c.id, c.name
       ORDER BY COALESCE(SUM(oi.quantity * oi.unit_price), 0) DESC`
    )
    return rows
  }

  async getMonthlyRevenueTrend(months: number): Promise<MonthlyRevenue[]> {
    const { rows } = await this.pool.query<MonthlyRevenue>(
      `WITH monthly AS (
         SELECT
           EXTRACT(YEAR  FROM created_at)::int AS year,
           EXTRACT(MONTH FROM created_at)::int AS month,
           COUNT(*)::int                        AS order_count,
           SUM(total)::text                     AS revenue
         FROM orders
         WHERE created_at >= NOW() - INTERVAL '1 month' * $1
         GROUP BY year, month
       )
       SELECT
         year, month, order_count, revenue,
         SUM(revenue::numeric) OVER (ORDER BY year, month)::text AS running_total
       FROM monthly
       ORDER BY year, month`,
      [months]
    )
    return rows
  }

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------

  async insertOneUser(data: { email: string; name: string }): Promise<User> {
    const { rows } = await this.pool.query<User>(
      'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id, email, name, created_at',
      [data.email, data.name]
    )
    return rows[0]
  }

  async insertManyProducts(
    data: Array<{ categoryId: number; name: string; price: number; stock: number }>
  ): Promise<number> {
    if (data.length === 0) return 0
    const placeholders = data
      .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
      .join(', ')
    const params = data.flatMap(d => [d.categoryId, d.name, d.price, d.stock])
    const { rowCount } = await this.pool.query(
      `INSERT INTO products (category_id, name, price, stock) VALUES ${placeholders}`,
      params
    )
    return rowCount ?? 0
  }

  async createOrderWithItems(data: NewOrderInput): Promise<Order> {
    const client: PoolClient = await this.pool.connect()
    try {
      await client.query('BEGIN')

      const { rows: [order] } = await client.query<Order>(
        `INSERT INTO orders (user_id, status, total)
         VALUES ($1, 'pending', $2)
         RETURNING id, user_id, status, total, created_at`,
        [data.userId, data.paymentAmount]
      )

      if (data.items.length > 0) {
        const placeholders = data.items
          .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
          .join(', ')
        const params = data.items.flatMap(it => [order.id, it.productId, it.quantity, it.unitPrice])
        await client.query(
          `INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ${placeholders}`,
          params
        )
      }

      await client.query(
        `INSERT INTO payments (order_id, amount, status) VALUES ($1, $2, 'pending')`,
        [order.id, data.paymentAmount]
      )

      await client.query('COMMIT')
      return order
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // ------------------------------------------------------------------
  // Write – bulk transactional (batch INSERT vs Prisma's per-row INSERT)
  // ------------------------------------------------------------------

  async bulkCreateOrders(orders: NewOrderInput[]): Promise<Order[]> {
    if (orders.length === 0) return []
    const client: PoolClient = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const results: Order[] = []

      for (const data of orders) {
        const { rows: [order] } = await client.query<Order>(
          `INSERT INTO orders (user_id, status, total)
           VALUES ($1, 'pending', $2)
           RETURNING id, user_id, status, total, created_at`,
          [data.userId, data.paymentAmount]
        )

        if (data.items.length > 0) {
          const placeholders = data.items
            .map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`)
            .join(', ')
          const params = data.items.flatMap(it => [order.id, it.productId, it.quantity, it.unitPrice])
          await client.query(
            `INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ${placeholders}`,
            params
          )
        }

        await client.query(
          `INSERT INTO payments (order_id, amount, status) VALUES ($1, $2, 'pending')`,
          [order.id, data.paymentAmount]
        )

        results.push(order)
      }

      await client.query('COMMIT')
      return results
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // ------------------------------------------------------------------
  // Update / Delete
  // ------------------------------------------------------------------

  async updateOrderStatus(orderId: number, status: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2',
      [status, orderId]
    )
    return (rowCount ?? 0) > 0
  }

  async deleteOrder(orderId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM orders WHERE id = $1',
      [orderId]
    )
    return (rowCount ?? 0) > 0
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async close(): Promise<void> {
    await this.pool.end()
  }
}
