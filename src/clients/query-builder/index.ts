import knex, { Knex } from 'knex'
import { dbConfig } from '../../../configs/db'
import type {
  DbAdapter, User, OrderWithDetails, UserOrderTotal, LastOrderPerUser,
  Order, ListUsersFilters, SortOptions, PageOptions, NewOrderInput,
} from '../../types'

const ALLOWED_SORT_FIELDS = new Set(['id', 'name', 'email', 'created_at'])

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
      .where('ranked.rn', 1)
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
    // knex returns inserted rows with .returning(); rowCount is in the array length
    const result = await this.db('products').insert(rows)
    // pg driver: result is an array of row counts or row objects depending on returning()
    return Array.isArray(result) ? result.length : (result as unknown as { rowCount: number }).rowCount ?? data.length
  }

  async createOrderWithItems(data: NewOrderInput): Promise<Order> {
    return this.db.transaction(async trx => {
      const [order] = await trx<Order>('orders')
        .insert({ user_id: data.userId, status: 'pending', total: data.paymentAmount })
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
