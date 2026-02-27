import knex, { Knex } from 'knex'
import { dbConfig } from '../../../configs/db'
import { UserRepository }    from './repositories/UserRepository'
import { OrderRepository }   from './repositories/OrderRepository'
import { ProductRepository } from './repositories/ProductRepository'
import type {
  DbAdapter, User, OrderWithDetails, UserOrderTotal, LastOrderPerUser,
  Order, ListUsersFilters, SortOptions, PageOptions, NewOrderInput,
} from '../../types'

// Data Access Layer adapter — repository pattern on top of knex.
// The adapter delegates every DbAdapter call to a typed repository.
// SQL / query-builder details are fully hidden from the caller.

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
      pool: { min: dbConfig.pool.min, max: dbConfig.pool.max },
    })
    this.users    = new UserRepository(this.db)
    this.orders   = new OrderRepository(this.db)
    this.products = new ProductRepository(this.db)
  }

  // ------------------------------------------------------------------
  // Read – simple
  // ------------------------------------------------------------------

  findUserById(id: number): Promise<User | null> {
    return this.users.findById(id)
  }

  findUserByEmail(email: string): Promise<User | null> {
    return this.users.findByEmail(email)
  }

  listUsers(filters: ListUsersFilters, sort: SortOptions, page: PageOptions): Promise<User[]> {
    return this.users.list(filters, sort, page)
  }

  // ------------------------------------------------------------------
  // Read – medium
  // ------------------------------------------------------------------

  getOrderWithDetails(orderId: number): Promise<OrderWithDetails | null> {
    return this.orders.findWithDetails(orderId)
  }

  getUserOrderTotals(limit = 20): Promise<UserOrderTotal[]> {
    return this.orders.getUserOrderTotals(limit)
  }

  // ------------------------------------------------------------------
  // Read – heavy
  // ------------------------------------------------------------------

  getLastOrderPerUser(limit = 20): Promise<LastOrderPerUser[]> {
    return this.orders.getLastOrderPerUser(limit)
  }

  batchGetUsers(ids: number[]): Promise<User[]> {
    return this.users.batchGet(ids)
  }

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------

  insertOneUser(data: { email: string; name: string }): Promise<User> {
    return this.users.insert(data)
  }

  insertManyProducts(
    data: Array<{ categoryId: number; name: string; price: number; stock: number }>
  ): Promise<number> {
    return this.products.insertMany(data)
  }

  createOrderWithItems(data: NewOrderInput): Promise<Order> {
    return this.orders.createWithItems(data)
  }

  // ------------------------------------------------------------------
  // Update / Delete
  // ------------------------------------------------------------------

  updateOrderStatus(orderId: number, status: string): Promise<boolean> {
    return this.orders.updateStatus(orderId, status)
  }

  deleteOrder(orderId: number): Promise<boolean> {
    return this.orders.delete(orderId)
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async close(): Promise<void> {
    await this.db.destroy()
  }
}
