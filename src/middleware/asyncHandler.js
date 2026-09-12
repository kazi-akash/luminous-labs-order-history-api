// Express doesn't forward rejected promises from async route handlers to
// error middleware on its own (pre-Express 5) — an unguarded `await` that
// throws would hang the request instead of reaching errorHandler. Wrapping
// once here means route handlers can just `throw` and skip a try/catch each.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
