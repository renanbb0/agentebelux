const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'index.js');
const zapiPath = path.join(repoRoot, 'services', 'zapi.js');

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`End marker not found: ${endMarker}`);
  return source.slice(start, end);
}

function instantiateScheduler(context = {}) {
  const source = readSource(indexPath);
  const script = new vm.Script(`
    ${extractBetween(source, 'function scheduleFecharPedidoHandoff', 'async function handoffToHuman')}
    scheduleFecharPedidoHandoff;
  `);

  const sandbox = {
    console,
    Date,
    Math,
    Map,
    parseFloat,
    fecharPedidoInactivityTimers: new Map(),
    logger: { info() {}, warn() {}, error() {} },
    zapi: { sendText: async () => {}, sendImage: async () => {}, delay: async () => {} },
    sendTextWithTTS: async () => {},
    sendCategoryShowcase: async () => {},
    appendHistory: () => {},
    conversationMemory: { refreshConversationMemory() {} },
    persistSession: () => {},
    ADMIN_PHONES: [],
    HANDOFF_PIX_DISCOUNT_PCT: 10,
    ai: {},
    pdfService: {},
    buildProductGroupsFromMatched: () => [],
    ...context,
  };

  vm.createContext(sandbox);
  return script.runInContext(sandbox);
}

test('modo Fechar Pedido espera 180s antes de agir por inatividade', () => {
  let scheduledMs = null;
  const scheduleFecharPedidoHandoff = instantiateScheduler({
    setTimeout: (_fn, ms) => {
      scheduledMs = ms;
      return { ms };
    },
    clearTimeout: () => {},
  });

  scheduleFecharPedidoHandoff('5599999999999', { supportMode: 'fechar_pedido_pending' });

  assert.equal(scheduledMs, 180_000);
});

test('Fechar Pedido sem nenhum envio pergunta se cliente precisa de ajuda e nao fecha', async () => {
  let scheduledCallback = null;
  const sent = [];
  const history = [];
  let persisted = false;

  const scheduleFecharPedidoHandoff = instantiateScheduler({
    setTimeout: (fn, ms) => {
      if (ms === 30_000) {
        fn();
        return { ms };
      }
      scheduledCallback = fn;
      return { ms };
    },
    clearTimeout: () => {},
    zapi: {
      sendText: async (_phone, message) => sent.push(message),
      sendImage: async () => {},
      delay: async () => {},
    },
    appendHistory: (_session, role, content) => history.push({ role, content }),
    persistSession: () => { persisted = true; },
  });

  const session = {
    supportMode: 'fechar_pedido_pending',
    fecharPedidoRelayBuffer: [],
    matchedProducts: [],
    pendingSizeTexts: [],
  };

  scheduleFecharPedidoHandoff('5599999999999', session);
  await scheduledCallback();

  assert.equal(session.supportMode, 'fechar_pedido_pending');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /ainda quer enviar|precisa de ajuda|d[uú]vidas/i);
  assert.doesNotMatch(sent[0], /Recebi todos os seus produtos/i);
  assert.equal(history[0].role, 'assistant');
  assert.equal(persisted, true);
});

test('menu inicial usa Dúvidas como ultima opcao', () => {
  const zapiSource = readSource(zapiPath);
  const gateBlock = extractBetween(zapiSource, 'async function sendInitialGate', 'module.exports');

  assert.match(gateBlock, /label: '❓ Dúvidas'/);
  assert.doesNotMatch(gateBlock, /Resolver um problema/);
});
