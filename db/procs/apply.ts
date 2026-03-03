import 'dotenv/config'
import { Pool } from 'pg'
import * as fs from 'fs'
import * as path from 'path'
import { dbConfig } from '../../configs/db'

// Applies all *.sql files in db/procs/ to the database in alphabetical order.
// All functions use CREATE OR REPLACE — safe to run multiple times.

async function main() {
  const procsDir = __dirname

  const files = fs
    .readdirSync(procsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  if (files.length === 0) {
    console.log('No .sql files found in db/procs/.')
    return
  }

  const pool = new Pool({
    host:     dbConfig.host,
    port:     dbConfig.port,
    database: dbConfig.database,
    user:     dbConfig.user,
    password: dbConfig.password,
  })

  console.log(`Applying ${files.length} proc file(s) to "${dbConfig.database}" on ${dbConfig.host}:${dbConfig.port}...`)

  const client = await pool.connect()
  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(procsDir, file), 'utf8')
      await client.query(sql)
      console.log(`  ok  ${file}`)
    }
    console.log('All stored procedures applied successfully.')
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(err => {
  console.error('db:procs failed:', err.message)
  process.exit(1)
})
