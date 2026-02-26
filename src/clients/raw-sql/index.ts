import { Pool, PoolClient } from 'pg'
import { dbConfig } from '../../../configs/db'
import type {
  DbAdapter, User, OrderWithDetails, UserOrderTotal, LastOrderPerUser,
  Order, ListUsersFilters, SortOptions, PageOptions, NewOrderInput,
} from '../../types'

const ALLOWED_SORT_FIELDS = new Set(['id', 'name', 'email', 'created_at'])

export class RawSqlAdapter implements DbAdapter {
  private pool: Pool

  constructor() {
    this.pool = new Pool({
      host:     dbConfig.host,
      port:     dbConfig.port,
      database: dbConfig.database,
      user:     dbConfig.user,
      password: dbConfig.password,
      min:      dbConfig.pool.min,
      max:      dbConfig.pool.max,
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
       ORDER BY total_spent::numeric DESC
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
