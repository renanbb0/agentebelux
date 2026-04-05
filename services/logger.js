const pino = require('pino');
const path = require('path');

const logger = pino({
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

module.exports = logger;

module.exports = logger;
