const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const indexPath = path.join(path.resolve(__dirname, '..'), 'index.js');

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function extractNamedFunction(source, functionName) {
  const asyncNeedle = `async function ${functionName}(`;
  const syncNeedle = `function ${functionName}(`;
  const start = source.indexOf(asyncNeedle) >= 0
    ? source.indexOf(asyncNeedle)
    : source.indexOf(syncNeedle);

  if (start < 0) {
    throw new Error(`Function ${functionName} not found`);
  }

  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) {
      return source.slice(start, i + 1);
    }
  }

  throw new Error(`Function ${functionName} body not closed`);
}

function instantiateFunction(functionSource, functionName, context = {}) {
  const sandbox = { ...context };
  vm.createContext(sandbox);
  const script = new vm.Script(`(() => { ${functionSource}; return ${functionName}; })()`);
  return script.runInContext(sandbox);
}

test('executeHandoff envia PDF para cliente e admins quando a geracao funciona', async () => {
  const source = readSource(indexPath);
  const functionSource = extractNamedFunction(source, 'executeHandoff');
  const sentDocuments = [];
  const sentTexts = [];
  const persisted = [];
  const savedOrders = [];
  const legacyCalls = [];

  const executeHandoff = instantiateFunction(functionSource, 'executeHandoff', {
    buildProductGroupsFromCart: () => [{ productId: 1, totalPieces: 3 }],
    pdfService: {
      generateOrderPdf: async () => Buffer.from('%PDF-1.7 fake'),
    },
    HANDOFF_PIX_DISCOUNT_PCT: 10,
    sendTextWithTTS: async (phone, text) => sentTexts.push({ phone, text }),
    zapi: {
      sendDocument: async (phone, buffer, fileName) => {
        sentDocuments.push({ phone, buffer, fileName });
      },
      sendText: async () => {},
    },
    ADMIN_PHONES: ['5511999999999', '5585988888888'],
    buildAdminPdfHeader: (phone) => `header:${phone}`,
    sendLegacyHandoffToAdmins: async (...args) => legacyCalls.push(args),
    sendLegacyHandoffToAdmin: async (...args) => legacyCalls.push(args),
    db: {
      saveOrder: async (payload) => savedOrders.push(payload),
    },
    resetPurchaseFlow: (session) => {
      session.purchaseFlowReset = true;
    },
    persistSession: async (phone) => persisted.push(phone),
    buildCartSummary: () => ({ summary: 'unused', total: 0 }),
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    Date,
    String,
  });

  const session = {
    customerName: 'Marcia Silveira',
    handoffDone: false,
    upsellPending: true,
    upsellSnapshot: {
      items: [{ productId: 1, productName: 'Produto', quantity: 3 }],
      summary: 'Resumo',
      total: 138.75,
    },
  };

  await executeHandoff('5585981244025', session);

  assert.equal(sentTexts.length, 1);
  assert.equal(sentTexts[0].phone, '5585981244025');
  assert.equal(sentDocuments.length, 3);
  assert.deepEqual(
    sentDocuments.map((entry) => entry.phone),
    ['5585981244025', '5511999999999', '5585988888888']
  );
  assert.equal(legacyCalls.length, 0);
  assert.equal(savedOrders.length, 1);
  assert.equal(savedOrders[0].phone, '5585981244025');
  assert.equal(savedOrders[0].total, 138.75);
  assert.equal(session.handoffDone, true);
  assert.equal(session.upsellPending, false);
  assert.equal(session.upsellSnapshot, null);
  assert.equal(session.purchaseFlowReset, true);
  assert.deepEqual(persisted, ['5585981244025']);
});

test('executeHandoff usa fallback legado quando a geracao do PDF falha', async () => {
  const source = readSource(indexPath);
  const functionSource = extractNamedFunction(source, 'executeHandoff');
  const sentDocuments = [];
  const legacyCalls = [];

  const executeHandoff = instantiateFunction(functionSource, 'executeHandoff', {
    buildProductGroupsFromCart: () => [{ productId: 1, totalPieces: 3 }],
    pdfService: {
      generateOrderPdf: async () => {
        throw new Error('pdf failed');
      },
    },
    HANDOFF_PIX_DISCOUNT_PCT: 10,
    sendTextWithTTS: async () => {},
    zapi: {
      sendDocument: async (...args) => sentDocuments.push(args),
      sendText: async () => {},
    },
    ADMIN_PHONES: ['5511999999999'],
    buildAdminPdfHeader: () => 'header',
    sendLegacyHandoffToAdmins: async (...args) => legacyCalls.push(args),
    sendLegacyHandoffToAdmin: async (...args) => legacyCalls.push(args),
    db: {
      saveOrder: async () => {},
    },
    resetPurchaseFlow: () => {},
    persistSession: async () => {},
    buildCartSummary: () => ({ summary: 'unused', total: 0 }),
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    Date,
    String,
  });

  const session = {
    customerName: 'Marcia Silveira',
    handoffDone: false,
    upsellPending: true,
    upsellSnapshot: {
      items: [{ productId: 1, productName: 'Produto', quantity: 3 }],
      summary: 'Resumo',
      total: 138.75,
    },
  };

  await executeHandoff('5585981244025', session);

  assert.equal(sentDocuments.length, 0);
  assert.equal(legacyCalls.length, 1);
  assert.equal(legacyCalls[0][0], '5585981244025');
});
