// ============================================================
// Domain types
// ============================================================

export interface Category {
  id:   number
  name: string
  slug: string
}

export interface Product {
  id:          number
  category_id: number
  name:        string
  price:       string   // NUMERIC comes back as string from pg
  stock:       number
  created_at:  Date
}

export interface User {
  id:         number
  email:      string
  name:       string
  created_at: Date
}

export interface Order {
  id:         number
  user_id:    number
  status:     string
  total:      string
  created_at: Date
}

export interface OrderItem {
  id:         number
  order_id:   number
  product_id: number
  quantity:   number
  unit_price: string
}

export interface Payment {
  id:       number
  order_id: number
  amount:   string
  status:   string
  paid_at:  Date | null
}

// ============================================================
// Composite / result types
// ============================================================

export interface OrderWithDetails {
  order: Order
  user:  Pick<User, 'id' | 'email' | 'name'>
  items: Array<OrderItem & { product_name: string }>
}

export interface UserOrderTotal {
  user_id:     number
  user_name:   string
  order_count: number
  total_spent: string
}

export interface LastOrderPerUser {
  user_id:          number
  user_email:       string
  last_order_id:    number
  last_order_total: string
  last_order_at:    Date
}

// ============================================================
// Input / option types
// ============================================================

export interface PageOptions {
  page:  number   // 1-based
  limit: number
}

export interface SortOptions {
  field: string
  dir:   'asc' | 'desc'
}

export interface ListUsersFilters {
  createdAfter?: Date
  search?:       string   // ILIKE match on name
}

export interface NewOrderInput {
  userId: number
  items:  Array<{ productId: number; quantity: number; unitPrice: number }>
  paymentAmount: number
}

// ============================================================
// Unified adapter interface — all implementations must satisfy this
// ============================================================

export interface DbAdapter {
  // Read – simple
  findUserById(id: number): Promise<User | null>
  findUserByEmail(email: string): Promise<User | null>
  listUsers(filters: ListUsersFilters, sort: SortOptions, page: PageOptions): Promise<User[]>

  // Read – medium (joins / aggregation)
  getOrderWithDetails(orderId: number): Promise<OrderWithDetails | null>
  getUserOrderTotals(limit?: number): Promise<UserOrderTotal[]>

  // Read – heavy (CTE, top-N, batch)
  getLastOrderPerUser(limit?: number): Promise<LastOrderPerUser[]>
  batchGetUsers(ids: number[]): Promise<User[]>

  // Write
  insertOneUser(data: { email: string; name: string }): Promise<User>
  insertManyProducts(data: Array<{ categoryId: number; name: string; price: number; stock: number }>): Promise<number>
  createOrderWithItems(data: NewOrderInput): Promise<Order>

  // Update / Delete
  updateOrderStatus(orderId: number, status: string): Promise<boolean>
  deleteOrder(orderId: number): Promise<boolean>

  // Lifecycle
  close(): Promise<void>
}
