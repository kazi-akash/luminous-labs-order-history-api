// Convenience script for manual testing — mints a JWT for a given user id.
// Usage: node scripts/mint-token.js <userId> [--admin]
require('dotenv').config();
const jwt = require('jsonwebtoken');

const userId = Number(process.argv[2]);
const isAdmin = process.argv.includes('--admin');

if (!Number.isInteger(userId)) {
  console.error('Usage: node scripts/mint-token.js <userId> [--admin]');
  process.exit(1);
}

const token = jwt.sign({ sub: userId, isAdmin }, process.env.JWT_SECRET, {
  expiresIn: '1h',
});

console.log(token);
