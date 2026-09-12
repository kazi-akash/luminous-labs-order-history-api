# DECISIONS.md

## 1. What did the requirements not tell you?

The spec is genuinely minimal, so I had to fill in:

- **Least-confident assumption: the schema.** The assignment states that a
  Postgres schema and seed script were provided ("A Postgres schema and a
  seed script are provided (~5,000 users, ~50,000 orders)"), but they were
  not included in the materials I received — only the PDF itself arrived.
  I therefore created a minimal schema (`schema.sql`: `users`, `orders`)
  containing only the fields necessary to implement and test the stated
  requirements, and a matching `scripts/seed.js` at the stated scale. This
  is **not** an attempt to guess the company's actual schema — it's a
  deliberately minimal stand-in built so the endpoint has something real to
  run against. If a real schema exists with different column names, types,
  or an `orders` table shaped differently (e.g. soft-deleted rows,
  multi-currency totals, a separate `order_items` table), my index and
  query would need to be rebuilt against the real thing, not adapted.
- **Auth mechanism.** Not specified at all. I assumed a stateless JWT
  bearer token (`Authorization: Bearer <token>`), verified per-request in
  middleware, carrying `sub` (user id) and `isAdmin` as claims — no server-
  side session store, so the authorization check on every request is O(1)
  and doesn't add a dependency on the request path. I did not build
  login/token-issuance — that's a separate concern (credential
  verification, token rotation, refresh flow) with no requirement behind
  it here — and instead wrote `scripts/mint-token.js` to stand in for
  whatever issues tokens in the real system.
- **What "admin" means.** Assumed a boolean flag on the user row rather
  than a roles/permissions table. This is the cheapest model that
  satisfies requirement 4 exactly as stated ("the user themself, or an
  admin") — a roles table would be solving a permissions problem the spec
  doesn't describe, at the cost of a join on every request.
- **Pagination isn't in the requirements, only implied by "must stay
  responsive as the number of orders grows."** I read that as: don't return
  unbounded result sets, and don't degrade as offset grows. I chose cursor
  (keyset) pagination over `OFFSET`. Nothing in the spec says the API
  consumer expects a cursor-shaped response rather than page numbers — a
  product/frontend requirement I don't have visibility into.
- **Response shape for money.** Assumed integer cents (`total_cents`), not
  a float or a formatted string, to avoid floating-point currency bugs. Not
  stated anywhere.
- **What "no orders" should return.** Assumed `200` with an empty array,
  not `404`. A `404` should mean "no such user," not "user has no orders" —
  otherwise a client can't distinguish "typo'd the id" from "brand-new
  customer."
- **Order status field.** Invented a `status` column with no real state
  machine behind it, just to make the shape look like a real order rather
  than a bare total. Not required by the spec; low-risk since it's additive.
- **Error-response shape.** Not specified. I standardized every error
  response to `{ "error": "<message>" }` with an appropriate status code,
  via a small typed-error/central-error-middleware pair
  (`src/errors.js`, `src/middleware/errorHandler.js`) rather than each
  route handler writing its own `res.status().json()`. A real API might
  have an existing error envelope convention (error codes, a `details`
  field) that this doesn't match — I picked the simplest consistent shape
  in the absence of one.

## 2. What did you use AI for, and where did you override it?

I used Claude (via Claude Code) as the primary drafting tool for this whole
submission, working iteratively rather than accepting a single generated
dump. Concretely:

- **Boilerplate (Express app wiring, package.json, .env handling):**
  generated largely as-is. Low risk, easy to verify by reading it once.
- **Pagination approach:** I asked for the standard `OFFSET/LIMIT` first
  as a first pass, which is what a naive generation defaults to. I overrode
  this myself before it was written — `OFFSET` pagination re-scans and
  discards every prior row on each page, which directly contradicts
  "must stay responsive as the number of orders grows" once a user
  accumulates thousands of orders. I redirected to keyset pagination on
  `(created_at, id)` instead, with `id` as an explicit tiebreaker.
- **The tiebreaker bug:** the first version of the cursor comparison used
  only `created_at < $cursor`, which drops or duplicates rows whenever two
  orders share the same timestamp (seed data can easily produce this with
  bulk-inserted rows). I changed the comparison to a row-value comparison,
  `(created_at, id) < ($cursor_created_at, $cursor_id)`, and made the
  `ORDER BY` and the index match that same tuple order. This is the kind of
  bug that passes casual testing (small seed, no timestamp collisions) and
  fails silently in production.
- **The seed script:** an early version tried to build the `created_at`
  value as a parameterized bind variable and also interpolate it into a
  SQL expression (`now() - $n days`) in the same string — an inconsistency
  that would either throw or silently insert garbage depending on how it
  was patched. I rewrote the batching so bind parameters and the one raw
  SQL expression (`now() - interval`) are kept clearly separate, so the
  parameter indices stay correct as the batch size changes.
- **The 404-vs-empty-array distinction:** the initial draft returned an
  empty array for both "user doesn't exist" and "user has no orders." I
  added the explicit existence check and split those two cases myself —
  this wasn't something the generation surfaced unprompted, but it directly
  satisfies "handle users who have no orders" without hiding bad `:id`
  values from the caller.
- **What I did not have AI do:** the actual judgment calls in section 1
  (schema shape, auth shape, pagination style, money representation) were
  mine — I used the tool to execute decisions, not to make them, and I read
  every line of SQL before accepting it because that's the part most likely
  to have a silent, not-loudly-wrong bug.

## 3. What breaks first at 100× this data?

At ~500,000 users / ~5,000,000 orders, **the endpoint's own query stays
fine** — the `(user_id, created_at DESC, id DESC)` index plus keyset
pagination means the query is an index range scan bounded by `LIMIT`,
regardless of how large `orders` grows or how deep into one user's history
the cursor is. Data volume alone does not break this endpoint. I didn't
just assume this — I ran `EXPLAIN ANALYZE` against the seeded 50,000-row
table for both the first page and a cursor'd later page, and confirmed
both hit `Index Scan using idx_orders_user_created`, not a sequential
scan, with the cursor condition pushed into the index condition itself:

```
Limit (actual time=0.052..0.115 rows=8 loops=1)
  -> Index Scan using idx_orders_user_created on orders
       Index Cond: (user_id = 2)
Execution Time: 0.158 ms

Limit (actual time=0.036..0.073 rows=8 loops=1)
  -> Index Scan using idx_orders_user_created on orders
       Index Cond: ((user_id = 2) AND (ROW(created_at, id) < ROW(...)))
Execution Time: 0.130 ms
```

Sub-millisecond at this scale, and the plan shape doesn't change as the
cursor moves deeper into the result set — which is the actual claim
behind "index-backed pagination scales," not just a name-drop of the
technique.

**The primary failure is connection-pool exhaustion under concurrent
load** — a capacity problem, not a correctness one. A single Postgres
instance has a fixed connection ceiling (`max_connections`, and the app's
own `pg.Pool` size on top of that). At 100x *traffic* — which tends to
arrive alongside 100x data, not because of it — this endpoint being fast
per-query doesn't stop the pool from filling up once concurrent request
volume outpaces how fast connections are checked out and returned.
Requests start queuing for a connection, latency climbs, and it looks like
the whole service degraded even though no individual query got slower.
This is the one I'd actually expect to page someone, given what this
implementation actually does today.

**A secondary, conditional risk:** this endpoint does not run `COUNT(*)`
today, so it isn't a current bottleneck. But if a future requirement adds
total-count metadata (e.g. "page X of Y," a "total orders" badge), a naive
`COUNT(*) WHERE user_id = ?` would become one — cheap for a typical user,
but a full index scan over hundreds of thousands of rows for a hot user
(a marketplace seller, a high-volume account) with disproportionately many
orders. I flag this because it's an easy thing to add later without
realizing it doesn't scale the way the paginated query does — not because
it's a problem in the code as it stands.

**Detection, before a customer reports it:** alert on Postgres
active-connection count approaching `max_connections` (or the app's pool
utilization) — this is the leading indicator, since it fails before any
individual query gets slow. Alongside that, track p99 latency and
`pg_stat_statements` for this specific query, watching for mean execution
time drifting upward, which would indicate the index stopped being used
(e.g. after a bad migration or a planner regression) rather than a load
problem. The two alerts catch different failures: a slow-query alert alone
would miss pool exhaustion entirely, since individual queries stay fast
right up until requests start queuing for a connection.

## 4. What did you deliberately not build?

- **No total order count or "page X of Y."** Cursor pagination doesn't
  give you a cheap total, and computing one (`COUNT(*) WHERE user_id = ?`)
  is a full scan for high-volume users — the exact hot-path cost I'm trying
  to avoid. If the product needs a total, it should be a separate,
  cacheable/denormalized value, not computed inline on every page request.
- **No filtering or search (by date range, status, amount).** Not in the
  spec. Adding it speculatively would mean guessing at index shapes I have
  no requirement for yet.
- **No rate limiting.** Real APIs need it, but it's an infrastructure/
  gateway concern more than an application-code concern, and bolting on a
  fake in-process limiter would be security theater without knowing the
  actual deployment topology (single instance vs. horizontally scaled).
- **No login/token-issuance endpoint.** I assumed JWTs already exist,
  minted by whatever the real auth system is, and built only the
  verification side plus a CLI helper to mint test tokens.
- **No caching layer (Redis, etc.) in front of the query.** The index
  already makes the query cheap per-request; adding a cache before there's
  a measured need would be solving a problem I don't have evidence of yet.
  I'd add it if profiling showed this endpoint as a hot path under real
  traffic, not preemptively.
- **No soft-delete / order visibility rules beyond owner-or-admin** (e.g.
  cancelled orders, refunded orders being hidden). Not mentioned in the
  spec, and inventing a visibility rule with no requirement behind it risks
  hiding data a real stakeholder wanted shown.
