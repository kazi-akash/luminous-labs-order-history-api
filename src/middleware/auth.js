const jwt = require('jsonwebtoken');
const { UnauthorizedError } = require('../errors');

// Assumption: auth is a JWT bearer token carrying { sub: userId, isAdmin }.
// Nothing about auth was specified, so I picked the standard stateless
// approach rather than sessions/API keys. See DECISIONS.md assumption #2.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new UnauthorizedError('Missing or malformed Authorization header'));
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, isAdmin: !!payload.isAdmin };
    next();
  } catch (err) {
    next(new UnauthorizedError('Invalid or expired token'));
  }
}

module.exports = { requireAuth };
