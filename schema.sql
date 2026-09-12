-- Minimal schema. No schema was actually attached to the assignment email,
-- so this is my own reasonable reconstruction — see DECISIONS.md, assumption #1.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The index that makes this endpoint viable at scale: newest-first lookup
-- scoped to one user. (id included as tiebreaker for stable keyset pagination
-- when two orders share a created_at timestamp.)
CREATE INDEX IF NOT EXISTS idx_orders_user_created
  ON orders (user_id, created_at DESC, id DESC);
