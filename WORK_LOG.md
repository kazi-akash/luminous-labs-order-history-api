# Work Log — Order History API Assignment

This file documents what was built, how, and why. Written for the
candidate's own record — not part of the graded submission
(`DECISIONS.md` is the graded artifact; this is the process log behind it).

## The task, as given

From `Senior Node.js Developer — Take-Home Assignment (1).pdf`:

> Build an endpoint that returns a user's order history.
> `GET /api/users/:id/orders`

Requirements:
1. Returns the user's orders, newest first
2. Must stay responsive as the number of orders grows
3. Handle users who have no orders
4. Only the user themself, or an admin, may view a user's orders

Deliverables: working code + `DECISIONS.md` (worth ~60% of the grade,
read before the code). No UI, frontend, or browser interface was
requested anywhere in the spec, the deliverables list, the grading
criteria, or the follow-up-call question examples — all of it is
backend-only (endpoint behavior, pagination, scaling, code structure).
Building one would have been unrequested scope, which cuts against the
"what did you deliberately not build" grading criterion.

## What was actually attached vs. what the PDF claims

The PDF says "A Postgres schema and a seed script are provided" — but
only the PDF itself was attached to the email; no schema or seed file
came with it. This was treated as the first assumption to make (see
`DECISIONS.md`, section 1) rather than a blocker: a minimal `users` /
`orders` schema was designed from scratch, sized to the stated scale
(~5,000 users / ~50,000 orders).

## Step-by-step build

1. **Schema (`schema.sql`).** `users (id, email, is_admin, created_at)`,
   `orders (id, user_id, total_cents, status, created_at)`. Added one
   index up front: `(user_id, created_at DESC, id DESC)` — this is the
   index that makes requirement 2 ("must stay responsive as orders grow")
   true. Without it, "newest first for one user" is a full table scan
   that gets worse as the `orders` table grows, regardless of how fast
   the app code is.

2. **Seed script (`scripts/seed.js`).** Generates 5,000 users and 50,000
   orders using batched multi-row `INSERT`s (1,000 rows per statement)
   instead of one `INSERT` per row — at this volume, row-by-row inserts
   would make seeding itself the slow, flaky part of the setup.

3. **Auth (`src/middleware/auth.js`).** Spec doesn't say how a caller
   proves who they are, only that the check must happen (requirement 4).
   Picked a stateless JWT bearer token (`Authorization: Bearer <token>`)
   carrying `{ sub: userId, isAdmin }`, verified in middleware before the
   route handler runs. Did not build a login/token-issuance endpoint —
   assumed that already exists elsewhere in a real system — and instead
   wrote `scripts/mint-token.js` as a stand-in, so the endpoint can be
   exercised without inventing a fake auth service.

4. **The endpoint (`src/routes/orders.js`).**
   - Ownership check: `req.user.id !== targetUserId && !req.user.isAdmin`
     → `403`. Straight implementation of requirement 4.
   - User-existence check before querying orders: a bad `:id` returns
     `404`, and a real user with zero orders returns `200` with an empty
     array. These had to be split explicitly — this is exactly what
     requirement 3 ("handle users who have no orders") means. Collapsing
     both cases into "empty array" would hide typo'd/deleted ids from the
     caller.
   - Pagination: **keyset (cursor) pagination**, not `OFFSET/LIMIT`, on
     `(created_at, id)`. This is the direct answer to requirement 2.
     `OFFSET` pagination re-scans and discards every prior row on each
     page — cheap on page 2, and a real cost once a user has thousands of
     orders. A cursor lets Postgres use the index to jump straight to the
     next page regardless of how deep into the history the caller is.
     `id` is included as a tiebreaker because two orders can share a
     `created_at` timestamp (especially likely with bulk-inserted seed
     data), and comparing on `created_at` alone would silently drop or
     duplicate rows across a page boundary when that happens.
   - Error handling: route logic throws typed errors
     (`BadRequestError`, `ForbiddenError`, `NotFoundError` — defined in
     `src/errors.js`) instead of writing `res.status().json()` inline.
     A single `errorHandler` middleware (`src/middleware/errorHandler.js`),
     registered last in `app.js`, turns any typed error into the right
     status code and a consistent `{ error: message }` body, and turns
     anything unexpected into a logged `500` without leaking internals.
     `asyncHandler` (`src/middleware/asyncHandler.js`) wraps the async
     route so a rejected promise (e.g. a dropped DB connection) reaches
     that middleware instead of hanging the request — Express doesn't do
     this automatically for async handlers on the version used here.
     This is the one deliberate "senior-level" structural choice beyond
     the minimum: it costs three small files, and in exchange every
     error path in the route handler is a one-line `throw` instead of a
     repeated `return res.status(...).json(...)`, and adding a fifth
     error case later doesn't mean inventing a fifth ad hoc response
     shape.
   - Response shape: `totalCents` (integer), not a float — avoids
     floating-point currency bugs, a real-world habit carried into a
     toy schema.

5. **Tests (`test/orders.test.js`).** Integration tests against a real
   Postgres, not mocks — the thing worth verifying is the SQL and the
   pagination behavior itself, and a mock of the database would verify
   nothing about whether the index-backed query and cursor logic are
   actually correct. Covers: no-auth rejection, cross-user rejection,
   own-orders newest-first ordering, admin override, two-page
   cursor walk with no row overlap, empty-orders case, and 404 for a
   nonexistent user — one test per stated requirement, plus the auth
   edge cases the requirements imply but don't spell out.

6. **`DECISIONS.md`.** Answers the four required questions: what wasn't
   specified (schema, auth mechanism, admin model, pagination style,
   money representation, empty-vs-missing semantics — with the schema
   assumption flagged as the least confident one, since no real schema
   was ever actually provided); what AI drafted vs. what was corrected
   by hand (the `OFFSET`-pagination default it reached for first, a
   cursor tiebreaker bug that would only surface on timestamp
   collisions, a parameter-binding inconsistency in the seed script);
   the specific failure mode at 100× scale (hot-user skew making a
   `COUNT(*)` expensive even though the paginated query itself stays
   fast, plus connection-pool exhaustion under concurrent load as the
   more likely actual production failure) and how it'd be detected
   before a customer complains; and what was deliberately left out
   (total counts, filtering, rate limiting, a login endpoint, caching,
   soft-delete visibility rules) with the reasoning for each cut.

## Verifying it actually works (not just "looks right")

Ran the whole thing end-to-end rather than trusting a syntax check:

- Spun up a disposable Postgres via Docker (`postgres:16-alpine`) rather
  than touching the machine's existing local Postgres install, which
  belongs to an unrelated running stack (Laragon) — didn't want to risk
  colliding with or modifying someone else's database.
- `npm install`, `npm run seed` → seeded 5,000 users / 50,000 orders for
  real.
- `npm test` → all 7 integration tests passed against the live database.
- `npm start` → hit the running server with `curl`, using tokens minted
  by `scripts/mint-token.js`, and confirmed all four requirements live:
  `401` with no token, `403` reading another user's orders, `200` for an
  admin reading anyone's orders, `404` for a nonexistent user id,
  newest-first ordering in the response body, and a working `nextCursor`
  that correctly returns `null` on the last page.
- Found and fixed two environment issues along the way, unrelated to the
  application code itself: `node --test test/` doesn't resolve a bare
  directory the way it's documented to on this Node/Windows combination
  (fixed by pointing the `test` script at an explicit glob,
  `test/*.test.js`); and port `3000` was already held by an unrelated
  Node process on the machine (Laragon), so `PORT` was moved to `3050`
  in `.env` rather than fighting over the default port.
- Tore down the disposable Postgres container afterward so nothing was
  left running on the machine.

## Why no UI

Not requested anywhere in the assignment — the spec, deliverables list,
grading rubric, and follow-up-call sample questions are all API/backend
only. The target grader is expected to exercise the endpoint directly
(curl/Postman) or read the code, per the assignment's own submission
note: "if we cannot run it in five minutes, we will grade it as it
arrives." Adding a UI would be scope not asked for, which the
assignment explicitly treats as a negative signal rather than a
positive one (see the "what did you deliberately not build" grading
criterion).
