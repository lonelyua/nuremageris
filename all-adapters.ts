// =============================================================================
// ALL ADAPTERS — full source dump for reference / copy-paste
// This file is NOT part of the application. It is never imported.
// Generated from src/clients/*/index.ts and their repositories.
// =============================================================================


// =============================================================================
// 1. RAW SQL ADAPTER
// src/clients/raw-sql/index.ts
// =============================================================================

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


// =============================================================================
// 2. QUERY BUILDER ADAPTER
// src/clients/query-builder/index.ts
// =============================================================================

import knex, { Knex } from 'knex'

const ALLOWED_SORT_FIELDS_QB = new Set(['id', 'name', 'email', 'created_at'])

// Internal row shape returned by getTopOrdersWithItems JOIN query
interface TopOrderRowQB {
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

export class QueryBuilderAdapter implements DbAdapter {
  private db: Knex

  constructor() {
    this.db = knex({
      client: 'pg',
      connection: {
        host:     dbConfig.host,
        port:     dbConfig.port,
        database: dbConfig.database,
        user:     dbConfig.user,
        password: dbConfig.password,
      },
      pool: {
        min:                  dbConfig.pool.min,
        max:                  dbConfig.pool.max,
        acquireTimeoutMillis: dbConfig.pool.connectionTimeoutMs,
        idleTimeoutMillis:    dbConfig.pool.idleTimeoutMs,
      },
    })
  }

  // ------------------------------------------------------------------
  // Read – simple
  // ------------------------------------------------------------------

  async findUserById(id: number): Promise<User | null> {
    const row = await this.db<User>('users')
      .select('id', 'email', 'name', 'created_at')
      .where({ id })
      .first()
    return row ?? null
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const row = await this.db<User>('users')
      .select('id', 'email', 'name', 'created_at')
      .where({ email })
      .first()
    return row ?? null
  }

  async listUsers(filters: ListUsersFilters, sort: SortOptions, page: PageOptions): Promise<User[]> {
    let q = this.db<User>('users').select('id', 'email', 'name', 'created_at')

    if (filters.createdAfter) q = q.where('created_at', '>', filters.createdAfter)
    if (filters.search)       q = q.whereILike('name', `%${filters.search}%`)

    const sortCol = ALLOWED_SORT_FIELDS_QB.has(sort.field) ? sort.field : 'id'

    return q
      .orderBy(sortCol, sort.dir)
      .limit(page.limit)
      .offset((page.page - 1) * page.limit)
  }

  // ------------------------------------------------------------------
  // Read – medium
  // ------------------------------------------------------------------

  async getOrderWithDetails(orderId: number): Promise<OrderWithDetails | null> {
    const row = await this.db('orders as o')
      .select(
        'o.id', 'o.user_id', 'o.status', 'o.total', 'o.created_at',
        'u.id as uid', 'u.email as user_email', 'u.name as user_name'
      )
      .join('users as u', 'u.id', 'o.user_id')
      .where('o.id', orderId)
      .first()
    if (!row) return null

    const items = await this.db('order_items as oi')
      .select(
        'oi.id', 'oi.order_id', 'oi.product_id', 'oi.quantity', 'oi.unit_price',
        'p.name as product_name'
      )
      .join('products as p', 'p.id', 'oi.product_id')
      .where('oi.order_id', orderId)

    return {
      order: { id: row.id, user_id: row.user_id, status: row.status, total: row.total, created_at: row.created_at },
      user:  { id: row.uid, email: row.user_email, name: row.user_name },
      items,
    }
  }

  async getUserOrderTotals(limit = 20): Promise<UserOrderTotal[]> {
    return this.db('users as u')
      .select(
        'u.id as user_id',
        'u.name as user_name',
        this.db.raw('COUNT(o.id)::int as order_count'),
        this.db.raw('COALESCE(SUM(o.total), 0) as total_spent')
      )
      .leftJoin('orders as o', 'o.user_id', 'u.id')
      .groupBy('u.id', 'u.name')
      .orderBy('total_spent', 'desc')
      .limit(limit)
  }

  // ------------------------------------------------------------------
  // Read – heavy
  // ------------------------------------------------------------------

  async getLastOrderPerUser(limit = 20): Promise<LastOrderPerUser[]> {
    const ranked = this.db('orders as o')
      .select(
        'o.id as last_order_id',
        'o.user_id',
        'o.total as last_order_total',
        'o.created_at as last_order_at',
        this.db.raw('ROW_NUMBER() OVER (PARTITION BY o.user_id ORDER BY o.created_at DESC) as rn')
      )
      .as('ranked')

    return this.db(ranked)
      .select(
        'ranked.user_id',
        'u.email as user_email',
        'ranked.last_order_id',
        'ranked.last_order_total',
        'ranked.last_order_at'
      )
      .join('users as u', 'u.id', 'ranked.user_id')
      .whereRaw('ranked.rn = 1')
      .orderBy('ranked.last_order_at', 'desc')
      .limit(limit)
  }

  async batchGetUsers(ids: number[]): Promise<User[]> {
    if (ids.length === 0) return []
    return this.db<User>('users')
      .select('id', 'email', 'name', 'created_at')
      .whereIn('id', ids)
  }

  // ------------------------------------------------------------------
  // Read – deep join (1 JOIN query vs Prisma's 6 separate queries)
  // ------------------------------------------------------------------

  async getTopOrdersWithItems(limit: number): Promise<OrderWithItems[]> {
    const topIds = this.db('orders').select('id').orderBy('created_at', 'desc').limit(limit).as('top')

    const rows = await this.db<TopOrderRowQB>(topIds)
      .join('orders as o',          'o.id',           'top.id')
      .join('users as u',           'u.id',           'o.user_id')
      .join('order_items as oi',    'oi.order_id',    'o.id')
      .join('products as p',        'p.id',           'oi.product_id')
      .join('categories as c',      'c.id',           'p.category_id')
      .leftJoin('payments as pay',  'pay.order_id',   'o.id')
      .select(
        'o.id           as order_id',
        'o.user_id',
        'o.status',
        'o.total        as order_total',
        'o.created_at   as order_created_at',
        'u.email        as user_email',
        'u.name         as user_name',
        'oi.id          as item_id',
        'oi.product_id',
        'oi.quantity',
        'oi.unit_price',
        'p.name         as product_name',
        'c.name         as category_name',
        'pay.id         as pay_id',
        'pay.amount     as pay_amount',
        'pay.status     as pay_status',
        'pay.paid_at    as pay_paid_at',
      )
      .orderBy('o.created_at', 'desc')
      .orderBy('oi.id')

    return this.aggregateOrderRows(rows)
  }

  private aggregateOrderRows(rows: TopOrderRowQB[]): OrderWithItems[] {
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
    return this.db('categories as c')
      .select(
        'c.id   as category_id',
        'c.name as category_name',
        this.db.raw('COUNT(DISTINCT p.id)::int                                   AS product_count'),
        this.db.raw('ROUND(AVG(p.price), 2)::text                                AS avg_price'),
        this.db.raw('COALESCE(SUM(p.stock), 0)::int                              AS total_stock'),
        this.db.raw('COUNT(DISTINCT oi.order_id)::int                            AS orders_count'),
        this.db.raw('COALESCE(SUM(oi.quantity * oi.unit_price), 0)::text         AS revenue'),
      )
      .leftJoin('products as p',     'p.category_id', 'c.id')
      .leftJoin('order_items as oi', 'oi.product_id', 'p.id')
      .groupBy('c.id', 'c.name')
      .orderByRaw('COALESCE(SUM(oi.quantity * oi.unit_price), 0) DESC')
  }

  async getMonthlyRevenueTrend(months: number): Promise<MonthlyRevenue[]> {
    const result = await this.db.raw<{ rows: MonthlyRevenue[] }>(
      `WITH monthly AS (
         SELECT
           EXTRACT(YEAR  FROM created_at)::int AS year,
           EXTRACT(MONTH FROM created_at)::int AS month,
           COUNT(*)::int                        AS order_count,
           SUM(total)::text                     AS revenue
         FROM orders
         WHERE created_at >= NOW() - INTERVAL '1 month' * ?
         GROUP BY year, month
       )
       SELECT
         year, month, order_count, revenue,
         SUM(revenue::numeric) OVER (ORDER BY year, month)::text AS running_total
       FROM monthly
       ORDER BY year, month`,
      [months]
    )
    return result.rows
  }

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------

  async insertOneUser(data: { email: string; name: string }): Promise<User> {
    const [row] = await this.db<User>('users')
      .insert(data)
      .returning(['id', 'email', 'name', 'created_at'])
    return row
  }

  async insertManyProducts(
    data: Array<{ categoryId: number; name: string; price: number; stock: number }>
  ): Promise<number> {
    if (data.length === 0) return 0
    const rows = data.map(d => ({ category_id: d.categoryId, name: d.name, price: d.price, stock: d.stock }))
    const result = await this.db('products').insert(rows)
    return Array.isArray(result) ? result.length : (result as unknown as { rowCount: number }).rowCount ?? data.length
  }

  async createOrderWithItems(data: NewOrderInput): Promise<Order> {
    return this.db.transaction(async trx => {
      const [order] = await trx<Order>('orders')
        .insert({ user_id: data.userId, status: 'pending', total: String(data.paymentAmount) })
        .returning(['id', 'user_id', 'status', 'total', 'created_at'])

      if (data.items.length > 0) {
        await trx('order_items').insert(
          data.items.map(it => ({
            order_id:   order.id,
            product_id: it.productId,
            quantity:   it.quantity,
            unit_price: it.unitPrice,
          }))
        )
      }

      await trx('payments').insert({ order_id: order.id, amount: data.paymentAmount, status: 'pending' })

      return order
    })
  }

  // ------------------------------------------------------------------
  // Write – bulk transactional (batch INSERT vs Prisma's per-row INSERT)
  // ------------------------------------------------------------------

  async bulkCreateOrders(orders: NewOrderInput[]): Promise<Order[]> {
    if (orders.length === 0) return []
    return this.db.transaction(async trx => {
      const results: Order[] = []

      for (const data of orders) {
        const [order] = await trx<Order>('orders')
          .insert({ user_id: data.userId, status: 'pending', total: String(data.paymentAmount) })
          .returning(['id', 'user_id', 'status', 'total', 'created_at'])

        if (data.items.length > 0) {
          await trx('order_items').insert(
            data.items.map(it => ({
              order_id:   order.id,
              product_id: it.productId,
              quantity:   it.quantity,
              unit_price: it.unitPrice,
            }))
          )
        }

        await trx('payments').insert({ order_id: order.id, amount: data.paymentAmount, status: 'pending' })

        results.push(order)
      }

      return results
    })
  }

  // ------------------------------------------------------------------
  // Update / Delete
  // ------------------------------------------------------------------

  async updateOrderStatus(orderId: number, status: string): Promise<boolean> {
    const count = await this.db('orders').where({ id: orderId }).update({ status })
    return count > 0
  }

  async deleteOrder(orderId: number): Promise<boolean> {
    const count = await this.db('orders').where({ id: orderId }).delete()
    return count > 0
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async close(): Promise<void> {
    await this.db.destroy()
  }
}


// =============================================================================
// 3. DATA ACCESS LAYER — repositories
// src/clients/data-access-layer/repositories/UserRepository.ts
// =============================================================================

export class UserRepository {
  constructor(private readonly db: Knex) {}

  async findById(id: number): Promise<User | null> {
    const row = await this.db<User>('users')
      .select('id', 'email', 'name', 'created_at')
      .where({ id })
      .first()
    return row ?? null
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.db<User>('users')
      .select('id', 'email', 'name', 'created_at')
      .where({ email })
      .first()
    return row ?? null
  }

  async list(filters: ListUsersFilters, sort: SortOptions, page: PageOptions): Promise<User[]> {
    const ALLOWED = new Set(['id', 'name', 'email', 'created_at'])
    let q = this.db<User>('users').select('id', 'email', 'name', 'created_at')

    if (filters.createdAfter) q = q.where('created_at', '>', filters.createdAfter)
    if (filters.search)       q = q.whereILike('name', `%${filters.search}%`)

    const sortCol = ALLOWED.has(sort.field) ? sort.field : 'id'

    return q
      .orderBy(sortCol, sort.dir)
      .limit(page.limit)
      .offset((page.page - 1) * page.limit)
  }

  async insert(data: { email: string; name: string }): Promise<User> {
    const [row] = await this.db<User>('users')
      .insert(data)
      .returning(['id', 'email', 'name', 'created_at'])
    return row
  }

  async batchGet(ids: number[]): Promise<User[]> {
    if (ids.length === 0) return []
    return this.db<User>('users')
      .select('id', 'email', 'name', 'created_at')
      .whereIn('id', ids)
  }
}


// =============================================================================
// src/clients/data-access-layer/repositories/OrderRepository.ts
// =============================================================================

// Internal row shape returned by findTopWithItems JOIN query
interface TopOrderRowDAL {
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

export class OrderRepository {
  constructor(private readonly db: Knex) {}

  async findWithDetails(orderId: number): Promise<OrderWithDetails | null> {
    const row = await this.db('orders as o')
      .select(
        'o.id', 'o.user_id', 'o.status', 'o.total', 'o.created_at',
        'u.id as uid', 'u.email as user_email', 'u.name as user_name',
      )
      .join('users as u', 'u.id', 'o.user_id')
      .where('o.id', orderId)
      .first()
    if (!row) return null

    const items = await this.db('order_items as oi')
      .select(
        'oi.id', 'oi.order_id', 'oi.product_id', 'oi.quantity', 'oi.unit_price',
        'p.name as product_name',
      )
      .join('products as p', 'p.id', 'oi.product_id')
      .where('oi.order_id', orderId)

    return {
      order: { id: row.id, user_id: row.user_id, status: row.status, total: row.total, created_at: row.created_at },
      user:  { id: row.uid, email: row.user_email, name: row.user_name },
      items,
    }
  }

  async getUserOrderTotals(limit: number): Promise<UserOrderTotal[]> {
    return this.db('users as u')
      .select(
        'u.id as user_id',
        'u.name as user_name',
        this.db.raw('COUNT(o.id)::int as order_count'),
        this.db.raw('COALESCE(SUM(o.total), 0) as total_spent'),
      )
      .leftJoin('orders as o', 'o.user_id', 'u.id')
      .groupBy('u.id', 'u.name')
      .orderBy('total_spent', 'desc')
      .limit(limit)
  }

  async getLastOrderPerUser(limit: number): Promise<LastOrderPerUser[]> {
    const ranked = this.db('orders as o')
      .select(
        'o.id as last_order_id',
        'o.user_id',
        'o.total as last_order_total',
        'o.created_at as last_order_at',
        this.db.raw('ROW_NUMBER() OVER (PARTITION BY o.user_id ORDER BY o.created_at DESC) as rn'),
      )
      .as('ranked')

    return this.db(ranked)
      .select(
        'ranked.user_id',
        'u.email as user_email',
        'ranked.last_order_id',
        'ranked.last_order_total',
        'ranked.last_order_at',
      )
      .join('users as u', 'u.id', 'ranked.user_id')
      .whereRaw('ranked.rn = 1')
      .orderBy('ranked.last_order_at', 'desc')
      .limit(limit)
  }

  // ------------------------------------------------------------------
  // Deep JOIN – single query vs Prisma's 6 separate queries
  // ------------------------------------------------------------------

  async findTopWithItems(limit: number): Promise<OrderWithItems[]> {
    const topIds = this.db('orders').select('id').orderBy('created_at', 'desc').limit(limit).as('top')

    const rows = await this.db<TopOrderRowDAL>(topIds)
      .join('orders as o',         'o.id',         'top.id')
      .join('users as u',          'u.id',         'o.user_id')
      .join('order_items as oi',   'oi.order_id',  'o.id')
      .join('products as p',       'p.id',         'oi.product_id')
      .join('categories as c',     'c.id',         'p.category_id')
      .leftJoin('payments as pay', 'pay.order_id', 'o.id')
      .select(
        'o.id           as order_id',
        'o.user_id',
        'o.status',
        'o.total        as order_total',
        'o.created_at   as order_created_at',
        'u.email        as user_email',
        'u.name         as user_name',
        'oi.id          as item_id',
        'oi.product_id',
        'oi.quantity',
        'oi.unit_price',
        'p.name         as product_name',
        'c.name         as category_name',
        'pay.id         as pay_id',
        'pay.amount     as pay_amount',
        'pay.status     as pay_status',
        'pay.paid_at    as pay_paid_at',
      )
      .orderBy('o.created_at', 'desc')
      .orderBy('oi.id')

    return this.aggregateOrderRows(rows)
  }

  private aggregateOrderRows(rows: TopOrderRowDAL[]): OrderWithItems[] {
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
  // Write
  // ------------------------------------------------------------------

  async createWithItems(data: NewOrderInput): Promise<Order> {
    return this.db.transaction(async trx => {
      const [order] = await trx<Order>('orders')
        .insert({ user_id: data.userId, status: 'pending', total: String(data.paymentAmount) })
        .returning(['id', 'user_id', 'status', 'total', 'created_at'])

      if (data.items.length > 0) {
        await trx('order_items').insert(
          data.items.map(it => ({
            order_id:   order.id,
            product_id: it.productId,
            quantity:   it.quantity,
            unit_price: it.unitPrice,
          }))
        )
      }

      await trx('payments').insert({ order_id: order.id, amount: data.paymentAmount, status: 'pending' })

      return order
    })
  }

  // ------------------------------------------------------------------
  // Write – bulk transactional (batch INSERT vs Prisma's per-row INSERT)
  // ------------------------------------------------------------------

  async bulkCreate(orders: NewOrderInput[]): Promise<Order[]> {
    if (orders.length === 0) return []
    return this.db.transaction(async trx => {
      const results: Order[] = []

      for (const data of orders) {
        const [order] = await trx<Order>('orders')
          .insert({ user_id: data.userId, status: 'pending', total: String(data.paymentAmount) })
          .returning(['id', 'user_id', 'status', 'total', 'created_at'])

        if (data.items.length > 0) {
          await trx('order_items').insert(
            data.items.map(it => ({
              order_id:   order.id,
              product_id: it.productId,
              quantity:   it.quantity,
              unit_price: it.unitPrice,
            }))
          )
        }

        await trx('payments').insert({ order_id: order.id, amount: data.paymentAmount, status: 'pending' })

        results.push(order)
      }

      return results
    })
  }

  // ------------------------------------------------------------------
  // Analytics
  // ------------------------------------------------------------------

  async getMonthlyRevenueTrend(months: number): Promise<MonthlyRevenue[]> {
    const result = await this.db.raw<{ rows: MonthlyRevenue[] }>(
      `WITH monthly AS (
         SELECT
           EXTRACT(YEAR  FROM created_at)::int AS year,
           EXTRACT(MONTH FROM created_at)::int AS month,
           COUNT(*)::int                        AS order_count,
           SUM(total)::text                     AS revenue
         FROM orders
         WHERE created_at >= NOW() - INTERVAL '1 month' * ?
         GROUP BY year, month
       )
       SELECT
         year, month, order_count, revenue,
         SUM(revenue::numeric) OVER (ORDER BY year, month)::text AS running_total
       FROM monthly
       ORDER BY year, month`,
      [months]
    )
    return result.rows
  }

  async updateStatus(orderId: number, status: string): Promise<boolean> {
    const count = await this.db('orders').where({ id: orderId }).update({ status })
    return count > 0
  }

  async delete(orderId: number): Promise<boolean> {
    const count = await this.db('orders').where({ id: orderId }).delete()
    return count > 0
  }
}


// =============================================================================
// src/clients/data-access-layer/repositories/ProductRepository.ts
// =============================================================================

export class ProductRepository {
  constructor(private readonly db: Knex) {}

  async insertMany(
    data: Array<{ categoryId: number; name: string; price: number; stock: number }>
  ): Promise<number> {
    if (data.length === 0) return 0
    const rows = data.map(d => ({
      category_id: d.categoryId,
      name:        d.name,
      price:       d.price,
      stock:       d.stock,
    }))
    const result = await this.db('products').insert(rows)
    return Array.isArray(result) ? result.length : (result as unknown as { rowCount: number }).rowCount ?? data.length
  }

  async getSalesReport(): Promise<ProductSalesReport[]> {
    return this.db('categories as c')
      .select(
        'c.id   as category_id',
        'c.name as category_name',
        this.db.raw('COUNT(DISTINCT p.id)::int                                   AS product_count'),
        this.db.raw('ROUND(AVG(p.price), 2)::text                                AS avg_price'),
        this.db.raw('COALESCE(SUM(p.stock), 0)::int                              AS total_stock'),
        this.db.raw('COUNT(DISTINCT oi.order_id)::int                            AS orders_count'),
        this.db.raw('COALESCE(SUM(oi.quantity * oi.unit_price), 0)::text         AS revenue'),
      )
      .leftJoin('products as p',     'p.category_id', 'c.id')
      .leftJoin('order_items as oi', 'oi.product_id', 'p.id')
      .groupBy('c.id', 'c.name')
      .orderByRaw('COALESCE(SUM(oi.quantity * oi.unit_price), 0) DESC')
  }
}


// =============================================================================
// src/clients/data-access-layer/index.ts  (DataAccessLayerAdapter shell)
// =============================================================================

export class DataAccessLayerAdapter implements DbAdapter {
  private readonly db:       Knex
  private readonly users:    UserRepository
  private readonly orders:   OrderRepository
  private readonly products: ProductRepository

  constructor() {
    this.db = knex({
      client: 'pg',
      connection: {
        host:     dbConfig.host,
        port:     dbConfig.port,
        database: dbConfig.database,
        user:     dbConfig.user,
        password: dbConfig.password,
      },
      pool: {
        min:                  dbConfig.pool.min,
        max:                  dbConfig.pool.max,
        acquireTimeoutMillis: dbConfig.pool.connectionTimeoutMs,
        idleTimeoutMillis:    dbConfig.pool.idleTimeoutMs,
      },
    })
    this.users    = new UserRepository(this.db)
    this.orders   = new OrderRepository(this.db)
    this.products = new ProductRepository(this.db)
  }

  findUserById(id: number)                                                          { return this.users.findById(id) }
  findUserByEmail(email: string)                                                    { return this.users.findByEmail(email) }
  listUsers(f: ListUsersFilters, s: SortOptions, p: PageOptions)                   { return this.users.list(f, s, p) }
  getOrderWithDetails(orderId: number)                                              { return this.orders.findWithDetails(orderId) }
  getUserOrderTotals(limit = 20)                                                    { return this.orders.getUserOrderTotals(limit) }
  getLastOrderPerUser(limit = 20)                                                   { return this.orders.getLastOrderPerUser(limit) }
  batchGetUsers(ids: number[])                                                      { return this.users.batchGet(ids) }
  getTopOrdersWithItems(limit: number)                                              { return this.orders.findTopWithItems(limit) }
  getProductSalesReport()                                                           { return this.products.getSalesReport() }
  getMonthlyRevenueTrend(months: number)                                            { return this.orders.getMonthlyRevenueTrend(months) }
  insertOneUser(data: { email: string; name: string })                             { return this.users.insert(data) }
  insertManyProducts(data: Array<{ categoryId: number; name: string; price: number; stock: number }>) { return this.products.insertMany(data) }
  createOrderWithItems(data: NewOrderInput)                                         { return this.orders.createWithItems(data) }
  bulkCreateOrders(orders: NewOrderInput[])                                         { return this.orders.bulkCreate(orders) }
  updateOrderStatus(orderId: number, status: string)                               { return this.orders.updateStatus(orderId, status) }
  deleteOrder(orderId: number)                                                      { return this.orders.delete(orderId) }

  async close(): Promise<void> { await this.db.destroy() }
}


// =============================================================================
// 4. ORM ADAPTER (Prisma)
// src/clients/orm/index.ts
// =============================================================================

import { PrismaClient, Prisma } from '@prisma/client'

const ALLOWED_SORT_FIELDS_ORM = new Set(['id', 'name', 'email', 'created_at'])

export class PrismaAdapter implements DbAdapter {
  private readonly prisma: PrismaClient

  constructor() {
    const poolTimeout = Math.max(1, Math.ceil(dbConfig.pool.connectionTimeoutMs / 1000))
    const url =
      `postgresql://${dbConfig.user}:${dbConfig.password}` +
      `@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}` +
      `?connection_limit=${dbConfig.pool.max}&pool_timeout=${poolTimeout}`
    this.prisma = new PrismaClient({ log: [], datasources: { db: { url } } })
  }

  // ------------------------------------------------------------------
  // Read – simple
  // ------------------------------------------------------------------

  async findUserById(id: number): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } }) as Promise<User | null>
  }

  async findUserByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } }) as Promise<User | null>
  }

  async listUsers(filters: ListUsersFilters, sort: SortOptions, page: PageOptions): Promise<User[]> {
    const where: Prisma.UserWhereInput = {}
    if (filters.createdAfter) where.created_at = { gt: filters.createdAfter }
    if (filters.search)       where.name = { contains: filters.search, mode: 'insensitive' }

    const orderByField = ALLOWED_SORT_FIELDS_ORM.has(sort.field) ? sort.field : 'id'

    return this.prisma.user.findMany({
      where,
      orderBy: { [orderByField]: sort.dir },
      take:    page.limit,
      skip:    (page.page - 1) * page.limit,
    }) as Promise<User[]>
  }

  // ------------------------------------------------------------------
  // Read – medium
  // ------------------------------------------------------------------

  async getOrderWithDetails(orderId: number): Promise<OrderWithDetails | null> {
    const row = await this.prisma.order.findUnique({
      where:   { id: orderId },
      include: {
        user:  { select: { id: true, email: true, name: true } },
        items: { include: { product: { select: { name: true } } } },
      },
    })
    if (!row) return null

    return {
      order: {
        id:         row.id,
        user_id:    row.user_id,
        status:     row.status,
        total:      row.total.toString(),
        created_at: row.created_at,
      },
      user: row.user,
      items: row.items.map(item => ({
        id:           item.id,
        order_id:     item.order_id,
        product_id:   item.product_id,
        quantity:     item.quantity,
        unit_price:   item.unit_price.toString(),
        product_name: item.product.name,
      })),
    }
  }

  async getUserOrderTotals(limit = 20): Promise<UserOrderTotal[]> {
    return this.prisma.$queryRaw<UserOrderTotal[]>(Prisma.sql`
      SELECT
        u.id                                    AS user_id,
        u.name                                  AS user_name,
        COUNT(o.id)::int                        AS order_count,
        COALESCE(SUM(o.total), 0)::text         AS total_spent
      FROM users u
      LEFT JOIN orders o ON o.user_id = u.id
      GROUP BY u.id, u.name
      ORDER BY COALESCE(SUM(o.total), 0) DESC
      LIMIT ${limit}
    `)
  }

  // ------------------------------------------------------------------
  // Read – heavy
  // ------------------------------------------------------------------

  async getLastOrderPerUser(limit = 20): Promise<LastOrderPerUser[]> {
    return this.prisma.$queryRaw<LastOrderPerUser[]>(Prisma.sql`
      SELECT
        ranked.user_id,
        u.email                       AS user_email,
        ranked.last_order_id,
        ranked.last_order_total::text AS last_order_total,
        ranked.last_order_at
      FROM (
        SELECT
          o.id          AS last_order_id,
          o.user_id,
          o.total       AS last_order_total,
          o.created_at  AS last_order_at,
          ROW_NUMBER() OVER (PARTITION BY o.user_id ORDER BY o.created_at DESC) AS rn
        FROM orders o
      ) ranked
      JOIN users u ON u.id = ranked.user_id
      WHERE ranked.rn = 1
      ORDER BY ranked.last_order_at DESC
      LIMIT ${limit}
    `)
  }

  async batchGetUsers(ids: number[]): Promise<User[]> {
    if (ids.length === 0) return []
    return this.prisma.user.findMany({ where: { id: { in: ids } } }) as Promise<User[]>
  }

  // ------------------------------------------------------------------
  // Read – deep join (Prisma generates 6 separate SELECT queries;
  //         raw/knex/dal use a single JOIN query — key differentiator)
  // ------------------------------------------------------------------

  async getTopOrdersWithItems(limit: number): Promise<OrderWithItems[]> {
    const orders = await this.prisma.order.findMany({
      take:    limit,
      orderBy: { created_at: 'desc' },
      include: {
        user:  { select: { id: true, email: true, name: true } },
        items: {
          include: {
            product: {
              include: { category: { select: { name: true } } },
            },
          },
        },
        payment: true,
      },
    })

    return orders.map(o => ({
      order: {
        id:         o.id,
        user_id:    o.user_id,
        status:     o.status,
        total:      o.total.toString(),
        created_at: o.created_at,
      },
      user: o.user,
      items: o.items.map(it => ({
        id:            it.id,
        order_id:      it.order_id,
        product_id:    it.product_id,
        quantity:      it.quantity,
        unit_price:    it.unit_price.toString(),
        product_name:  it.product.name,
        category_name: it.product.category.name,
      })),
      payment: o.payment
        ? {
            id:       o.payment.id,
            order_id: o.payment.order_id,
            amount:   o.payment.amount.toString(),
            status:   o.payment.status,
            paid_at:  o.payment.paid_at,
          }
        : null,
    }))
  }

  // ------------------------------------------------------------------
  // Analytics (GROUP BY / window functions — all via $queryRaw)
  // ------------------------------------------------------------------

  async getProductSalesReport(): Promise<ProductSalesReport[]> {
    return this.prisma.$queryRaw<ProductSalesReport[]>(Prisma.sql`
      SELECT
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
      ORDER BY COALESCE(SUM(oi.quantity * oi.unit_price), 0) DESC
    `)
  }

  async getMonthlyRevenueTrend(months: number): Promise<MonthlyRevenue[]> {
    return this.prisma.$queryRaw<MonthlyRevenue[]>(Prisma.sql`
      WITH monthly AS (
        SELECT
          EXTRACT(YEAR  FROM created_at)::int AS year,
          EXTRACT(MONTH FROM created_at)::int AS month,
          COUNT(*)::int                        AS order_count,
          SUM(total)::text                     AS revenue
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '1 month' * ${months}
        GROUP BY year, month
      )
      SELECT
        year, month, order_count, revenue,
        SUM(revenue::numeric) OVER (ORDER BY year, month)::text AS running_total
      FROM monthly
      ORDER BY year, month
    `)
  }

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------

  async insertOneUser(data: { email: string; name: string }): Promise<User> {
    return this.prisma.user.create({ data }) as Promise<User>
  }

  async insertManyProducts(
    data: Array<{ categoryId: number; name: string; price: number; stock: number }>
  ): Promise<number> {
    if (data.length === 0) return 0
    const result = await this.prisma.product.createMany({
      data: data.map(d => ({
        category_id: d.categoryId,
        name:        d.name,
        price:       d.price,
        stock:       d.stock,
      })),
    })
    return result.count
  }

  async createOrderWithItems(data: NewOrderInput): Promise<Order> {
    const row = await this.prisma.$transaction(async trx => {
      return trx.order.create({
        data: {
          user_id: data.userId,
          status:  'pending',
          total:   data.paymentAmount,
          items: {
            create: data.items.map(it => ({
              product_id: it.productId,
              quantity:   it.quantity,
              unit_price: it.unitPrice,
            })),
          },
          payment: {
            create: { amount: data.paymentAmount, status: 'pending' },
          },
        },
      })
    })

    return {
      id:         row.id,
      user_id:    row.user_id,
      status:     row.status,
      total:      row.total.toString(),
      created_at: row.created_at,
    }
  }

  // ------------------------------------------------------------------
  // Write – bulk transactional (per-row INSERT vs raw/knex batch INSERT)
  // Prisma creates each order_item individually → N×items more round-trips
  // ------------------------------------------------------------------

  async bulkCreateOrders(orders: NewOrderInput[]): Promise<Order[]> {
    if (orders.length === 0) return []
    return this.prisma.$transaction(async trx => {
      const results: Order[] = []

      for (const data of orders) {
        const row = await trx.order.create({
          data: {
            user_id: data.userId,
            status:  'pending',
            total:   data.paymentAmount,
            items: {
              create: data.items.map(it => ({
                product_id: it.productId,
                quantity:   it.quantity,
                unit_price: it.unitPrice,
              })),
            },
            payment: {
              create: { amount: data.paymentAmount, status: 'pending' },
            },
          },
        })

        results.push({
          id:         row.id,
          user_id:    row.user_id,
          status:     row.status,
          total:      row.total.toString(),
          created_at: row.created_at,
        })
      }

      return results
    })
  }

  // ------------------------------------------------------------------
  // Update / Delete
  // ------------------------------------------------------------------

  async updateOrderStatus(orderId: number, status: string): Promise<boolean> {
    try {
      await this.prisma.order.update({ where: { id: orderId }, data: { status } })
      return true
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') return false
      throw e
    }
  }

  async deleteOrder(orderId: number): Promise<boolean> {
    try {
      await this.prisma.order.delete({ where: { id: orderId } })
      return true
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') return false
      throw e
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async close(): Promise<void> {
    await this.prisma.$disconnect()
  }
}


// =============================================================================
// 5. HYBRID ADAPTER (Prisma + pg)
// src/clients/hybrid-orm/index.ts
// =============================================================================

// HybridAdapter: Prisma ORM for simple CRUD; pg raw SQL for complex/heavy queries.
//
// Routing:
//   ORM  → findUserById, findUserByEmail, listUsers,
//           insertOneUser, updateOrderStatus, deleteOrder
//   Raw  → getOrderWithDetails, getUserOrderTotals, getLastOrderPerUser,
//           batchGetUsers, getTopOrdersWithItems, getProductSalesReport,
//           getMonthlyRevenueTrend, insertManyProducts,
//           createOrderWithItems, bulkCreateOrders
//
// Transactional writes (createOrderWithItems, bulkCreateOrders) run entirely
// through the pg pool — single connection guarantees ACID and avoids the
// cross-client transaction problem (Prisma and pg do not share connections).

const ALLOWED_SORT_FIELDS_HYB = new Set(['id', 'name', 'email', 'created_at'])

interface TopOrderRowHYB {
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

export class HybridAdapter implements DbAdapter {
  private readonly pool:   Pool
  private readonly prisma: PrismaClient

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

    const poolTimeout = Math.max(1, Math.ceil(dbConfig.pool.connectionTimeoutMs / 1000))
    const url =
      `postgresql://${dbConfig.user}:${dbConfig.password}` +
      `@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}` +
      `?connection_limit=${dbConfig.pool.max}&pool_timeout=${poolTimeout}`
    this.prisma = new PrismaClient({ log: [], datasources: { db: { url } } })
  }

  // ------------------------------------------------------------------
  // Read – simple  [ORM]
  // ------------------------------------------------------------------

  async findUserById(id: number): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } }) as Promise<User | null>
  }

  async findUserByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } }) as Promise<User | null>
  }

  async listUsers(filters: ListUsersFilters, sort: SortOptions, page: PageOptions): Promise<User[]> {
    const where: Prisma.UserWhereInput = {}
    if (filters.createdAfter) where.created_at = { gt: filters.createdAfter }
    if (filters.search)       where.name = { contains: filters.search, mode: 'insensitive' }

    const orderByField = ALLOWED_SORT_FIELDS_HYB.has(sort.field) ? sort.field : 'id'

    return this.prisma.user.findMany({
      where,
      orderBy: { [orderByField]: sort.dir },
      take:    page.limit,
      skip:    (page.page - 1) * page.limit,
    }) as Promise<User[]>
  }

  // ------------------------------------------------------------------
  // Read – medium  [Raw]
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
  // Read – heavy  [Raw]
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
  // Read – deep join  [Raw: 1 JOIN query vs Prisma's 6 separate SELECTs]
  // ------------------------------------------------------------------

  async getTopOrdersWithItems(limit: number): Promise<OrderWithItems[]> {
    const { rows } = await this.pool.query<TopOrderRowHYB>(
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

  private aggregateOrderRows(rows: TopOrderRowHYB[]): OrderWithItems[] {
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
  // Analytics  [Raw]
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
  // Write – simple  [ORM]
  // ------------------------------------------------------------------

  async insertOneUser(data: { email: string; name: string }): Promise<User> {
    return this.prisma.user.create({ data }) as Promise<User>
  }

  // ------------------------------------------------------------------
  // Write – bulk  [Raw: single multi-row INSERT vs ORM's N individual INSERTs]
  // ------------------------------------------------------------------

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

  // Transactional writes run entirely through the pg pool.
  // Using a single pg connection per transaction guarantees ACID and avoids
  // mixing Prisma + pg within the same logical transaction (they cannot share
  // a connection, so mixing would produce two separate transactions).

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
  // Update / Delete  [ORM]
  // ------------------------------------------------------------------

  async updateOrderStatus(orderId: number, status: string): Promise<boolean> {
    try {
      await this.prisma.order.update({ where: { id: orderId }, data: { status } })
      return true
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') return false
      throw e
    }
  }

  async deleteOrder(orderId: number): Promise<boolean> {
    try {
      await this.prisma.order.delete({ where: { id: orderId } })
      return true
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') return false
      throw e
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async close(): Promise<void> {
    await Promise.all([this.prisma.$disconnect(), this.pool.end()])
  }
}


// =============================================================================
// 6. STORED PROCEDURE ADAPTER
// src/clients/stored-proc/index.ts
// =============================================================================

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
interface TopOrderRowSP {
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
    const { rows } = await this.pool.query<TopOrderRowSP>(
      'SELECT * FROM sp_get_top_orders_with_items($1)', [limit]
    )
    return this.aggregateOrderRows(rows)
  }

  private aggregateOrderRows(rows: TopOrderRowSP[]): OrderWithItems[] {
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
