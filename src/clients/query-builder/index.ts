import knex, { Knex } from 'knex'
import { dbConfig } from '../../../configs/db'
import type {
  DbAdapter, User, OrderWithDetails, OrderWithItems, UserOrderTotal, LastOrderPerUser,
  Order, ListUsersFilters, SortOptions, PageOptions, NewOrderInput,
  ProductSalesReport, MonthlyRevenue, Payment,
} from '../../types'

const ALLOWED_SORT_FIELDS = new Set(['id', 'name', 'email', 'created_at'])

// Internal row shape returned by getTopOrdersWithItems JOIN query
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
      pool: { min: dbConfig.pool.min, max: dbConfig.pool.max },
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

    const sortCol = ALLOWED_SORT_FIELDS.has(sort.field) ? sort.field : 'id'

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

    const rows = await this.db<TopOrderRow>(topIds)
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
