const { AppError } = require('../errors');

// Last middleware in the chain. Route handlers call next(err) instead of
// writing res.status/json directly, so the response shape for errors is
// defined in exactly one place.
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  // Anything else (a DB connection drop, a bug) is unexpected — log it with
  // detail server-side, but never leak internals to the client.
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { errorHandler };
