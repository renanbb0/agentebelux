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

const originalInfo = logger.info.bind(logger);
logger.info = (data, msg) => {
  originalInfo(data, msg);
  if (global.visualIo) {
    let type = 'system';
    if (typeof msg === 'string') {
      if (msg.includes('[FSM]')) type = 'fsm';
      else if (msg.includes('webhook') || msg.includes('Webhook')) type = 'webhook';
      else if (msg.includes('Gemini') || msg.includes('[AI]')) type = 'ai';
      else if (msg.includes('Z-API') || msg.includes('send')) type = 'send';
    }
    const state = data?.state || data?.pfCheck?.state || (data?.pf?.state);
    global.visualIo.emit('log', { timestamp: Date.now(), type, message: msg || data, state });
  }
};
