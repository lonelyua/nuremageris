import { Pool } from 'pg'
import { faker } from '@faker-js/faker'
import { dbConfig } from '../../configs/db'
import { benchConfig } from '../../configs/bench'

const SIZE = (process.env.SEED_SIZE ?? benchConfig.defaultSize) as keyof typeof benchConfig.dataSizes
const cfg = benchConfig.dataSizes[SIZE]

const pool = new Pool({
  host: dbConfig.host,
  port: dbConfig.port,
  database: dbConfig.database,
  user: dbConfig.user,
  password: dbConfig.password,
})

const CATEGORY_NAMES = ['Electronics', 'Books', 'Clothing', 'Home & Garden', 'Sports', 'Toys', 'Food', 'Beauty']

async function main() {
  console.log(`Seeding [size=${SIZE}]: ${cfg.users} users, ${cfg.products} products, ~${cfg.ordersPerUser} orders/user`)
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    await client.query(
      'TRUNCATE payments, order_items, orders, products, users, categories RESTART IDENTITY CASCADE'
    )

    // Categories
    const catIds: number[] = []
    for (const name of CATEGORY_NAMES) {
      const { rows } = await client.query<{ id: number }>(
        'INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id',
        [name, name.toLowerCase().replace(/[^a-z0-9]+/g, '-')]
      )
      catIds.push(rows[0].id)
    }

    // Products (batched)
    const PROD_BATCH = 500
    const productIds: number[] = []
    for (let i = 0; i < cfg.products; i += PROD_BATCH) {
      const batchSize = Math.min(PROD_BATCH, cfg.products - i)
      const placeholders = Array.from(
        { length: batchSize },
        (_, j) => `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4})`
      ).join(', ')
      const params = Array.from({ length: batchSize }, () => [
        catIds[Math.floor(Math.random() * catIds.length)],
        faker.commerce.productName(),
        parseFloat(faker.commerce.price({ min: 1, max: 500 })),
        faker.number.int({ min: 0, max: 1000 }),
      ]).flat()
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO products (category_id, name, price, stock) VALUES ${placeholders} RETURNING id`,
        params
      )
      productIds.push(...rows.map(r => r.id))
    }
    console.log(`  products: ${productIds.length}`)

    // Users + Orders (batched users, inline orders)
    const USER_BATCH = 200
    let totalOrders = 0

    for (let i = 0; i < cfg.users; i += USER_BATCH) {
      const batchSize = Math.min(USER_BATCH, cfg.users - i)
      const userPlaceholders = Array.from(
        { length: batchSize },
        (_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`
      ).join(', ')
      const userParams = Array.from({ length: batchSize }, (_, j) => [
        `user_${i + j + 1}@example.com`,
        faker.person.fullName(),
      ]).flat()
      const { rows: userRows } = await client.query<{ id: number }>(
        `INSERT INTO users (email, name) VALUES ${userPlaceholders} RETURNING id`,
        userParams
      )

      for (const user of userRows) {
        const numOrders = faker.number.int({ min: 1, max: cfg.ordersPerUser * 2 })
        for (let o = 0; o < numOrders; o++) {
          const numItems = faker.number.int({ min: 1, max: 5 })
          const items = Array.from({ length: numItems }, () => ({
            productId: productIds[Math.floor(Math.random() * productIds.length)],
            qty: faker.number.int({ min: 1, max: 10 }),
            price: parseFloat(faker.commerce.price({ min: 1, max: 200 })),
          }))
          const total = items.reduce((s, it) => s + it.price * it.qty, 0)
          const status = faker.helpers.arrayElement(['pending', 'paid', 'shipped', 'delivered', 'cancelled'])

          const { rows: [order] } = await client.query<{ id: number }>(
            `INSERT INTO orders (user_id, status, total) VALUES ($1, $2, $3) RETURNING id`,
            [user.id, status, total.toFixed(2)]
          )

          if (items.length > 0) {
            const iPlaceholders = items
              .map((_, k) => `($${k * 4 + 1}, $${k * 4 + 2}, $${k * 4 + 3}, $${k * 4 + 4})`)
              .join(', ')
            const iParams = items.flatMap(it => [order.id, it.productId, it.qty, it.price])
            await client.query(
              `INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ${iPlaceholders}`,
              iParams
            )
          }

          const payStatus = status === 'cancelled' ? 'failed' : status === 'pending' ? 'pending' : 'completed'
          const paidAt = payStatus === 'completed' ? new Date() : null
          await client.query(
            `INSERT INTO payments (order_id, amount, status, paid_at) VALUES ($1, $2, $3, $4)`,
            [order.id, total.toFixed(2), payStatus, paidAt]
          )
          totalOrders++
        }
      }

      if ((i + batchSize) % 1000 === 0 || i + batchSize >= cfg.users) {
        process.stdout.write(`\r  users: ${i + batchSize}/${cfg.users}  orders: ${totalOrders}`)
      }
    }

    await client.query('COMMIT')
    console.log(`\nSeeding complete. users=${cfg.users}  orders=${totalOrders}`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
