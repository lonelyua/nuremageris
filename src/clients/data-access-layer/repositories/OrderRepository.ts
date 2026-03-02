import type { Knex } from 'knex'
import type {
  Order, OrderWithDetails, OrderWithItems, UserOrderTotal, LastOrderPerUser,
  NewOrderInput, MonthlyRevenue, Payment,
} from '../../../types'

// Internal row shape returned by findTopWithItems JOIN query
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

    const rows = await this.db<TopOrderRow>(topIds)
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
