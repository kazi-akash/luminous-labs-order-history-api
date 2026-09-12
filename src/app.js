const express = require('express');
const ordersRouter = require('./routes/orders');
const { errorHandler } = require('./middleware/errorHandler');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', ordersRouter);

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // Must be registered last — Express identifies error middleware by arity
  // (four params), and only routes/middleware to it errors thrown or
  // passed via next(err) before this point.
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
