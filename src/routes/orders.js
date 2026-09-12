const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError, ForbiddenError, NotFoundError } = require('../errors');

const router = express.Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parseLimit(raw) {
  const limit = parseInt(raw, 10);
  if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (!decoded.createdAt || !Number.isInteger(decoded.id)) throw new Error('shape');
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new BadRequestError('Invalid cursor');
  }
}

function encodeCursor(order) {
  return Buffer.from(
    JSON.stringify({ createdAt: order.created_at, id: order.id })
  ).toString('base64url');
}

// Keyset (cursor) pagination, not OFFSET/LIMIT: OFFSET pagination re-scans
// and discards N rows on every page, which is fine at page 2 and a real
// problem once a user has thousands of orders. A cursor on (created_at, id)
// lets Postgres use the index to jump straight to the next page.
async function fetchOrdersPage(userId, { limit, cursor }) {
  const params = [userId];
  let whereCursor = '';
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    whereCursor = 'AND (created_at, id) < ($2, $3)';
  }
  params.push(limit + 1); // fetch one extra row to know if there's a next page

  const result = await pool.query(
    `SELECT id, total_cents, status, created_at
     FROM orders
     WHERE user_id = $1 ${whereCursor}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );

  const hasMore = result.rows.length > limit;
  const orders = hasMore ? result.rows.slice(0, limit) : result.rows;
  const nextCursor = hasMore ? encodeCursor(orders[orders.length - 1]) : null;

  return { orders, nextCursor };
}

// GET /api/users/:id/orders?limit=20&cursor=<base64>
router.get(
  '/users/:id/orders',
  requireAuth,
  asyncHandler(async (req, res) => {
    const targetUserId = Number(req.params.id);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      throw new BadRequestError('Invalid user id');
    }

    // Requirement 4: only the user themself, or an admin, may view.
    if (req.user.id !== targetUserId && !req.user.isAdmin) {
      throw new ForbiddenError('Forbidden');
    }

    const limit = parseLimit(req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    // Confirm the user exists so a bad :id reads as 404, not an empty list —
    // an empty list must mean "this real user has no orders" (requirement 3),
    // not "no such user".
    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [targetUserId]);
    if (userCheck.rowCount === 0) {
      throw new NotFoundError('User not found');
    }

    const { orders, nextCursor } = await fetchOrdersPage(targetUserId, { limit, cursor });

    res.json({
      orders: orders.map((o) => ({
        id: o.id,
        totalCents: o.total_cents,
        status: o.status,
        createdAt: o.created_at,
      })),
      nextCursor,
    });
  })
);

module.exports = router;
