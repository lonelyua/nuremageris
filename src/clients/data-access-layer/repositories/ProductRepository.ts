import type { Knex } from 'knex'

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
}
