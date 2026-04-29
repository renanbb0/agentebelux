const pino = require('pino');
const path = require('path');
const fs   = require('fs');

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const fileName = `belux-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.log`;
const filePath = path.join(logsDir, fileName);

const transport = pino.transport({
  targets: [
    { target: 'pino-pretty', options: { colorize: true } },
    { target: 'pino-pretty', options: { colorize: false, destination: filePath, mkdir: true } },
  ],
});

const logger = pino({ level: 'info' }, transport);

module.exports = logger;

function classifyByMessage(msg, fallback) {
  if (typeof msg === 'string') {
    if (msg.includes('[FSM]')) return 'fsm';
    if (msg.includes('webhook') || msg.includes('Webhook')) return 'webhook';
    if (msg.includes('Gemini') || msg.includes('[AI]')) return 'ai';
    if (msg.includes('Z-API') || msg.includes('send')) return 'send';
  }
  return fallback;
}

function emitVisual(defaultType, data, msg) {
  if (!global.visualIo) return;
  let payload = data;
  // Normaliza Error passado diretamente
  if (data instanceof Error) {
    payload = { err: data.message, stack: data.stack };
  }
  const type = classifyByMessage(msg, defaultType);
  const state = payload?.state || payload?.pfCheck?.state || payload?.pf?.state;
  global.visualIo.emit('log', {
    timestamp: Date.now(),
    type,
    message: msg || payload,
    state,
    data: typeof payload === 'object' ? payload : undefined,
  });
}

const originalInfo = logger.info.bind(logger);
logger.info = (data, msg) => {
  originalInfo(data, msg);
  emitVisual('system', data, msg);
};

const originalWarn = logger.warn.bind(logger);
logger.warn = (data, msg) => {
  originalWarn(data, msg);
  emitVisual('warn', data, msg);
};

const originalError = logger.error.bind(logger);
logger.error = (data, msg) => {
  originalError(data, msg);
  emitVisual('error', data, msg);
};
