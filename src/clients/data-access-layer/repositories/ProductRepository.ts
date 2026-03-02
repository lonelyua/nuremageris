import type { Knex } from 'knex'
import type { ProductSalesReport } from '../../../types'

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
