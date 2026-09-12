// Seeds ~5,000 users and ~50,000 orders, matching the scale the assignment
// describes. Uses batched multi-row INSERTs, not one INSERT per row —
// 55,000 round trips would make seeding itself the slow part.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const USER_COUNT = 5000;
const ORDER_COUNT = 50000;
const BATCH_SIZE = 1000;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(schema);

  await pool.query('TRUNCATE orders, users RESTART IDENTITY CASCADE');

  console.log(`Seeding ${USER_COUNT} users...`);
  for (let i = 0; i < USER_COUNT; i += BATCH_SIZE) {
    const rows = [];
    const values = [];
    for (let j = 0; j < BATCH_SIZE && i + j < USER_COUNT; j++) {
      const n = i + j;
      const isAdmin = n === 0; // user id 1 is the one admin, for manual testing
      values.push(`user${n}@example.com`, isAdmin);
      rows.push(`($${values.length - 1}, $${values.length})`);
    }
    await pool.query(
      `INSERT INTO users (email, is_admin) VALUES ${rows.join(',')}`,
      values
    );
  }

  console.log(`Seeding ${ORDER_COUNT} orders...`);
  for (let i = 0; i < ORDER_COUNT; i += BATCH_SIZE) {
    const rows = [];
    const values = [];
    for (let j = 0; j < BATCH_SIZE && i + j < ORDER_COUNT; j++) {
      const userId = 1 + Math.floor(Math.random() * USER_COUNT);
      const total = 100 + Math.floor(Math.random() * 99900);
      const daysAgo = (Math.random() * 730).toFixed(4);
      values.push(userId, total, daysAgo);
      const base = values.length - 3;
      rows.push(
        `($${base + 1}, $${base + 2}, now() - ($${base + 3} || ' days')::interval)`
      );
    }
    await pool.query(
      `INSERT INTO orders (user_id, total_cents, created_at) VALUES ${rows.join(',')}`,
      values
    );
  }

  console.log('Done.');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
