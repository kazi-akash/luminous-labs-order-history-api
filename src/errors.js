// Typed errors so route handlers express intent ("this is forbidden") and
// one place decides how that becomes an HTTP response, instead of every
// handler repeating res.status(...).json({ error: ... }).
class AppError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

class BadRequestError extends AppError {
  constructor(message) {
    super(400, message);
  }
}

class UnauthorizedError extends AppError {
  constructor(message) {
    super(401, message);
  }
}

class ForbiddenError extends AppError {
  constructor(message) {
    super(403, message);
  }
}

class NotFoundError extends AppError {
  constructor(message) {
    super(404, message);
  }
}

module.exports = { AppError, BadRequestError, UnauthorizedError, ForbiddenError, NotFoundError };
