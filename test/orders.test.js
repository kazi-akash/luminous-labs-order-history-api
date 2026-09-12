// Integration tests. Require a real Postgres reachable via DATABASE_URL
// (see README) — not mocked, because the thing worth verifying here is the
// SQL and the index-backed pagination, not a mock of it.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { createApp } = require('../src/app');
const pool = require('../src/db/pool');

const app = createApp();

function tokenFor(userId, isAdmin = false) {
  return jwt.sign({ sub: userId, isAdmin }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

let userA, userB, admin;

test.before(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      total_cents INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'completed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders (user_id, created_at DESC, id DESC);
  `);
  await pool.query('TRUNCATE orders, users RESTART IDENTITY CASCADE');

  const users = await pool.query(
    `INSERT INTO users (email, is_admin) VALUES
       ('a@test.com', false), ('b@test.com', false), ('admin@test.com', true)
     RETURNING id, is_admin`
  );
  [userA, userB, admin] = users.rows;

  for (let i = 0; i < 25; i++) {
    await pool.query(
      `INSERT INTO orders (user_id, total_cents, created_at) VALUES ($1, $2, now() - ($3 || ' minutes')::interval)`,
      [userA.id, 1000 + i, i]
    );
  }
});

test.after(async () => {
  await pool.query('TRUNCATE orders, users RESTART IDENTITY CASCADE');
  await pool.end();
});

test('rejects requests with no auth', async () => {
  const res = await request(app).get(`/api/users/${userA.id}/orders`);
  assert.equal(res.status, 401);
});

test('rejects a user reading someone else\'s orders', async () => {
  const res = await request(app)
    .get(`/api/users/${userA.id}/orders`)
    .set('Authorization', `Bearer ${tokenFor(userB.id)}`);
  assert.equal(res.status, 403);
});

test('allows a user to read their own orders, newest first', async () => {
  const res = await request(app)
    .get(`/api/users/${userA.id}/orders`)
    .set('Authorization', `Bearer ${tokenFor(userA.id)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.orders.length, 20); // default page size
  const timestamps = res.body.orders.map((o) => new Date(o.createdAt).getTime());
  const sorted = [...timestamps].sort((a, b) => b - a);
  assert.deepEqual(timestamps, sorted);
});

test('allows an admin to read any user\'s orders', async () => {
  const res = await request(app)
    .get(`/api/users/${userA.id}/orders`)
    .set('Authorization', `Bearer ${tokenFor(admin.id, true)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.orders.length, 20);
});

test('paginates via cursor to a second page with no overlap', async () => {
  const page1 = await request(app)
    .get(`/api/users/${userA.id}/orders?limit=10`)
    .set('Authorization', `Bearer ${tokenFor(userA.id)}`);
  assert.equal(page1.body.orders.length, 10);
  assert.ok(page1.body.nextCursor);

  const page2 = await request(app)
    .get(`/api/users/${userA.id}/orders?limit=10&cursor=${page1.body.nextCursor}`)
    .set('Authorization', `Bearer ${tokenFor(userA.id)}`);
  assert.equal(page2.body.orders.length, 10);

  const ids1 = new Set(page1.body.orders.map((o) => o.id));
  const overlap = page2.body.orders.some((o) => ids1.has(o.id));
  assert.equal(overlap, false);
});

test('returns an empty list for a user with no orders, not an error', async () => {
  const res = await request(app)
    .get(`/api/users/${userB.id}/orders`)
    .set('Authorization', `Bearer ${tokenFor(userB.id)}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.orders, []);
  assert.equal(res.body.nextCursor, null);
});

test('404s for a nonexistent user', async () => {
  const res = await request(app)
    .get(`/api/users/999999/orders`)
    .set('Authorization', `Bearer ${tokenFor(userA.id, true)}`);
  assert.equal(res.status, 404);
});
