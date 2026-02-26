import 'dotenv/config'

export const dbConfig = {
  host:     process.env.PG_HOST     ?? 'localhost',
  port:     Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? 'nuremageris',
  user:     process.env.PG_USER     ?? 'bench',
  password: process.env.PG_PASSWORD ?? 'bench',
  pool: {
    min: Number(process.env.PG_POOL_MIN ?? 2),
    max: Number(process.env.PG_POOL_MAX ?? 10),
  },
}
