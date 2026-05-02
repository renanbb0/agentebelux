const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'index.js');
const wooPath = path.join(repoRoot, 'services', 'woocommerce.js');

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

  let braceStart = source.indexOf('{', start);
  if (braceStart < 0) {
    throw new Error(`Function ${functionName} has no body`);
  }

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

test('buildCaption nao vaza grade bruta quando produto tem variantes sem variantSizes', () => {
  const { buildCaption } = require('../services/woocommerce');

  const caption = buildCaption({
    name: 'Pijama inverno mae e filha',
    price: '44',
    regularPrice: '44',
    salePrice: '',
    sizes: ['GG', 'G', 'M'],
    secondaryAttributes: [{ name: 'Categoria', options: ['Mãe', 'Filha'] }],
    description: '',
  });

  assert.match(caption, /Mãe \| Filha/);
  assert.doesNotMatch(caption, /GG \| G \| M/);
  assert.doesNotMatch(caption, /Tamanhos:/);
});

test('buildCaption usa sizeDetails filtrado para produto sem variantes quando existir', () => {
  const { buildCaption } = require('../services/woocommerce');

  const caption = buildCaption({
    name: 'Calcinha basica',
    price: '19.9',
    regularPrice: '19.9',
    salePrice: '',
    sizes: ['P', 'M', 'G'],
    sizeDetails: [
      { size: 'P', isAvailable: false },
      { size: 'M', isAvailable: true },
      { size: 'G', isAvailable: true },
    ],
    secondaryAttributes: [],
    description: '',
  });

  assert.match(caption, /Disponível: M \| G/);
  assert.doesNotMatch(caption, /Disponível: P \| M \| G/);
});

test('resolveProductById sempre enriquece produto carregado ou buscado', async () => {
  const source = readSource(indexPath);
  const functionSource = extractNamedFunction(source, 'resolveProductById');

  const ensureCalls = [];
  const loadedProduct = { id: 101, name: 'Produto carregado' };
  const fetchedProduct = { id: 202, name: 'Produto API' };

  const resolveProductById = instantiateFunction(functionSource, 'resolveProductById', {
    getLoadedProductById: (_session, productId) => (String(productId) === '101' ? loadedProduct : null),
    ensureProductStockData: async (product) => {
      ensureCalls.push(product.id);
      return { ...product, enriched: true };
    },
    woocommerce: {
      getProductById: async (productId) => (String(productId) === '202' ? fetchedProduct : null),
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  });

  const resolvedLoaded = await resolveProductById({ products: [] }, 101);
  const resolvedFetched = await resolveProductById({ products: [] }, 202);

  assert.equal(resolvedLoaded.enriched, true);
  assert.equal(resolvedFetched.enriched, true);
  assert.deepEqual(ensureCalls, [101, 202]);
});

test('processNextInQueue responde com citacao quando recebe replyToMessageId', async () => {
  const source = readSource(indexPath);
  const functionSource = extractNamedFunction(source, 'processNextInQueue');
  const sent = [];

  const processNextInQueue = instantiateFunction(functionSource, 'processNextInQueue', {
    ensureProductStockData: async (product) => product,
    resolveProductById: async () => null,
    logger: { info() {}, warn() {} },
    zapi: {
      sendText: async (...args) => sent.push(['sendText', ...args]),
      replyText: async (...args) => sent.push(['replyText', ...args]),
      sendImage: async () => {},
    },
    getAvailableSizesForSession: () => ['M', 'G'],
    sendVariantList: async () => {},
    sendStockAwareSizeQtyList: async () => {},
    process: { env: {} },
    Date,
    parseFloat,
    Object,
  });

  const session = {
    purchaseFlow: {
      buyQueue: [{ productId: 1, productSnapshot: { id: 1, name: 'Produto fila', price: '40', salePrice: '', sizes: ['M', 'G'], secondaryAttributes: [] } }],
      addedSizes: [],
    },
    items: [],
  };

  const result = await processNextInQueue('5511999999999', session, 'msg-123');

  assert.equal(result, true);
  assert.equal(sent[0][0], 'replyText');
  assert.equal(sent[0][1], '5511999999999');
  assert.equal(sent[0][3], 'msg-123');
});

test('handlePurchaseFlowEvent aceita nova escolha sizeqty do mesmo menu e mesmo produto', async () => {
  const source = readSource(indexPath);
  const functionSource = extractNamedFunction(source, 'handlePurchaseFlowEvent');
  const parseSizeQtyEvent = require('../src/utils/event-extractor').parseSizeQtyEvent;
  const sent = [];
  const added = [];
  const product = { id: 620, name: 'Pijama americano Bordado', price: '60', salePrice: '', sizes: ['M', 'G', 'GG'] };

  const handlePurchaseFlowEvent = instantiateFunction(functionSource, 'handlePurchaseFlowEvent', {
    isStaleEvent: () => true,
    parseSizeQtyEvent,
    ensureProductStockData: async (value) => value,
    resolveProductById: async (session, productId) => (String(productId) === String(product.id) ? product : null),
    getLoadedProductById: () => product,
    switchFsmFocus: () => ({ contextMessage: null }),
    addToCart: async (phone, qty, session) => {
      added.push({ phone, qty, productId: session.purchaseFlow.productId, size: session.purchaseFlow.selectedSize });
      return true;
    },
    sendStockAwareSizeQtyList: async () => sent.push(['sendStockAwareSizeQtyList']),
    handleQueueGuard: async () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    zapi: {
      sendText: async (...args) => sent.push(['sendText', ...args]),
      replyText: async (...args) => sent.push(['replyText', ...args]),
    },
    persistSession: () => {},
    Date,
    String,
    parseInt,
    parseFloat,
    isNaN,
  });

  const session = {
    currentProduct: product,
    purchaseFlow: {
      state: 'awaiting_more_sizes',
      productId: product.id,
      productName: product.name,
      price: 60,
      selectedSize: null,
      interactiveVersion: 2,
      addedSizes: ['GG'],
      buyQueue: [],
    },
    items: [{ productId: product.id, productName: product.name, size: 'GG', quantity: 1 }],
  };

  await handlePurchaseFlowEvent('5585999999999', 'sizeqty_620_M_1_v1', session);

  assert.deepEqual(added, [{ phone: '5585999999999', qty: 1, productId: 620, size: 'M' }]);
  assert.equal(sent.some((entry) => entry[0] === 'sendText' && /expirou/i.test(entry[2] || '')), false);
});

test('handlePurchaseFlowEvent aceita sizeqty antigo do produto em awaiting_size', async () => {
  const source = readSource(indexPath);
  const functionSource = extractNamedFunction(source, 'handlePurchaseFlowEvent');
  const parseSizeQtyEvent = require('../src/utils/event-extractor').parseSizeQtyEvent;
  const sent = [];
  const added = [];
  const product = { id: 7855, name: 'Pijama manga longa infantil', price: '60', salePrice: '', sizes: ['M', 'G', 'GG'] };

  const handlePurchaseFlowEvent = instantiateFunction(functionSource, 'handlePurchaseFlowEvent', {
    isStaleEvent: () => true,
    parseSizeQtyEvent,
    ensureProductStockData: async (value) => value,
    resolveProductById: async (_session, productId) => (String(productId) === String(product.id) ? product : null),
    getLoadedProductById: () => product,
    switchFsmFocus: () => ({ contextMessage: null }),
    addToCart: async (_phone, qty, session) => {
      added.push({ qty, productId: session.purchaseFlow.productId, size: session.purchaseFlow.selectedSize });
      return true;
    },
    sendStockAwareSizeQtyList: async () => sent.push(['sendStockAwareSizeQtyList']),
    handleQueueGuard: async () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    zapi: {
      sendText: async (...args) => sent.push(['sendText', ...args]),
      replyText: async (...args) => sent.push(['replyText', ...args]),
    },
    persistSession: () => {},
    Date,
    String,
    parseInt,
    parseFloat,
    isNaN,
  });

  const session = {
    currentProduct: product,
    purchaseFlow: {
      state: 'awaiting_size',
      productId: product.id,
      productName: product.name,
      price: 60,
      selectedSize: null,
      interactiveVersion: 2,
      addedSizes: [],
      buyQueue: [],
    },
    items: [],
  };

  await handlePurchaseFlowEvent('5585999999999', 'sizeqty_7855_G_3_v1', session);

  assert.deepEqual(added, [{ qty: 3, productId: 7855, size: 'G' }]);
  assert.equal(sent.some((entry) => entry[0] === 'sendText' && /expirou/i.test(entry[2] || '')), false);
});

test('index usa replyText nos pontos contextuais combinados pelo plano', () => {
  const source = readSource(indexPath);

  assert.match(source, /if \(replyMsg\) await zapi\.replyText\(from, replyMsg\.trim\(\), messageId\);/);
  assert.match(source, /if \(replyMsgQV\) await zapi\.replyText\(from, replyMsgQV\.trim\(\), messageId\);/);
  assert.match(source, /if \(gradeCtxMsg && !session\.items\?\.\length\) await zapi\.replyText\(from, gradeCtxMsg, messageId\);/);
  assert.match(source, /if \(sizeqtyCtxMsg && !session\.items\?\.\length\) await zapi\.replyText\(phone, sizeqtyCtxMsg, messageId\);/);
  assert.match(source, /if \(sizeCtxMsg\) await zapi\.replyText\(phone, sizeCtxMsg, messageId\);/);
  assert.match(source, /async function processNextInQueue\(phone, session, replyToMessageId = null\)/);
  assert.match(source, /if \(replyToMessageId\) \{\s*await zapi\.replyText\(phone, introText, replyToMessageId\);[\s\S]*?\} else \{\s*await zapi\.sendText\(phone, introText\);/);
});
