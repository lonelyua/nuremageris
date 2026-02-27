import type { Knex } from 'knex'
import type {
  Order, OrderWithDetails, UserOrderTotal, LastOrderPerUser, NewOrderInput,
} from '../../../types'

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

  async updateStatus(orderId: number, status: string): Promise<boolean> {
    const count = await this.db('orders').where({ id: orderId }).update({ status })
    return count > 0
  }

  async delete(orderId: number): Promise<boolean> {
    const count = await this.db('orders').where({ id: orderId }).delete()
    return count > 0
  }
}
