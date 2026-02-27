import { PrismaClient, Prisma } from '@prisma/client'
import type {
  DbAdapter, User, OrderWithDetails, UserOrderTotal, LastOrderPerUser,
  Order, ListUsersFilters, SortOptions, PageOptions, NewOrderInput,
} from '../../types'

const ALLOWED_SORT_FIELDS = new Set(['id', 'name', 'email', 'created_at'])

export class PrismaAdapter implements DbAdapter {
  private readonly prisma: PrismaClient

  constructor() {
    this.prisma = new PrismaClient({ log: [] })
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

    const orderByField = ALLOWED_SORT_FIELDS.has(sort.field) ? sort.field : 'id'

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
    // GROUP BY + aggregation — not expressible in Prisma fluent API, use raw SQL
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
    // Window function — not supported in Prisma fluent API, use raw SQL
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
