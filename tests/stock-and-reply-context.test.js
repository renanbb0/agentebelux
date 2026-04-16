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
