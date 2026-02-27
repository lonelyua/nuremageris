import type { Knex } from 'knex'
import type { User, ListUsersFilters, SortOptions, PageOptions } from '../../../types'

const ALLOWED_SORT_FIELDS = new Set(['id', 'name', 'email', 'created_at'])

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
    let q = this.db<User>('users').select('id', 'email', 'name', 'created_at')

    if (filters.createdAfter) q = q.where('created_at', '>', filters.createdAfter)
    if (filters.search)       q = q.whereILike('name', `%${filters.search}%`)

    const sortCol = ALLOWED_SORT_FIELDS.has(sort.field) ? sort.field : 'id'

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
