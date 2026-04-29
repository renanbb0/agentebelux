const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'index.js');

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

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('flushBuyDebounce inicia o primeiro produto e enfileira os demais em silencio', async () => {
  const source = readSource(indexPath);
  const functionSource = extractNamedFunction(source, 'flushBuyDebounce');
  const buyDebounceBuffer = new Map();
  const sentTexts = [];
  const started = [];
  const persisted = [];
  const session = {
    items: [],
    purchaseFlow: {
      state: 'idle',
      productId: null,
      buyQueue: [],
    },
  };

  buyDebounceBuffer.set('5585999999999', {
    products: [
      { id: 101, name: 'Produto um' },
      { id: 202, name: 'Produto dois' },
    ],
    timer: null,
  });

  const flushBuyDebounce = instantiateFunction(functionSource, 'flushBuyDebounce', {
    buyDebounceBuffer,
    getSession: async () => session,
    persistSession: (phone) => persisted.push(phone),
    startInteractivePurchase: async (_phone, product) => started.push(product.id),
    zapi: {
      sendText: async (_phone, message) => sentTexts.push(message),
    },
    logger: {
      info() {},
      error() {},
    },
  });

  await flushBuyDebounce('5585999999999');

  assert.deepEqual(started, [101]);
  assert.deepEqual(plain(session.purchaseFlow.buyQueue), [
    { productId: 202, productName: 'Produto dois', productSnapshot: { id: 202, name: 'Produto dois' } },
  ]);
  assert.deepEqual(sentTexts, []);
  assert.deepEqual(persisted, ['5585999999999']);
});

test('addToBuyDebounce apenas agenda o processamento para depois de 15 segundos', async () => {
  const source = readSource(indexPath);
  const functionSource = extractNamedFunction(source, 'addToBuyDebounce');
  const buyDebounceBuffer = new Map();
  const scheduled = [];
  const sentTexts = [];

  const addToBuyDebounce = instantiateFunction(functionSource, 'addToBuyDebounce', {
    buyDebounceBuffer,
    resolveProductById: async () => ({ id: 101, name: 'Produto um' }),
    setTimeout: (callback, ms) => {
      scheduled.push({ callback, ms });
      return { id: 'timer' };
    },
    clearTimeout: () => {},
    zapi: {
      sendText: async (_phone, message) => sentTexts.push(message),
    },
    logger: {
      info() {},
      error() {},
    },
  });

  await addToBuyDebounce('5585999999999', 'buy_101_v1', { purchaseFlow: {} });

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 15_000);
  assert.deepEqual(sentTexts, []);
  assert.equal(buyDebounceBuffer.get('5585999999999').products.length, 1);
});

test('addToBuyDebounce tambem atrasa clique de variante', async () => {
  const source = readSource(indexPath);
  const functionSource = extractNamedFunction(source, 'addToBuyDebounce');
  const buyDebounceBuffer = new Map();
  const scheduled = [];
  const sentTexts = [];

  const addToBuyDebounce = instantiateFunction(functionSource, 'addToBuyDebounce', {
    buyDebounceBuffer,
    resolveProductById: async () => ({ id: 615, name: 'Pijama mae e filha' }),
    setTimeout: (callback, ms) => {
      scheduled.push({ callback, ms });
      return { id: 'timer' };
    },
    clearTimeout: () => {},
    zapi: {
      sendText: async (_phone, message) => sentTexts.push(message),
    },
    logger: {
      info() {},
      error() {},
    },
  });

  await addToBuyDebounce('5585999999999', 'buy_variant_615_Mae (Ref 615S)', { purchaseFlow: {} });

  const buffered = buyDebounceBuffer.get('5585999999999').products[0];
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 15_000);
  assert.equal(buffered._showcaseVariantOpt, 'Mae (Ref 615S)');
  assert.deepEqual(sentTexts, []);
});

test('flushBuyDebounce so pergunta tamanho de variante depois do debounce', async () => {
  const source = readSource(indexPath);
  const functionSource = extractNamedFunction(source, 'flushBuyDebounce');
  const buyDebounceBuffer = new Map();
  const started = [];
  const advanced = [];
  const session = {
    items: [],
    purchaseFlow: {
      state: 'idle',
      productId: null,
      buyQueue: [],
    },
  };

  buyDebounceBuffer.set('5585999999999', {
    products: [{ id: 615, name: 'Pijama mae e filha', _showcaseVariantOpt: 'Mae (Ref 615S)' }],
    timer: null,
  });

  const flushBuyDebounce = instantiateFunction(functionSource, 'flushBuyDebounce', {
    buyDebounceBuffer,
    getSession: async () => session,
    persistSession: () => {},
    startInteractivePurchase: async (...args) => started.push(args),
    tryAdvanceToSize: async (...args) => advanced.push(args),
    zapi: {
      sendText: async () => {},
    },
    logger: {
      info() {},
      error() {},
    },
  });

  await flushBuyDebounce('5585999999999');

  assert.equal(started.length, 1);
  assert.equal(started[0][4], true);
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0][2], 'Mae (Ref 615S)');
});

test('flushBuyDebounce enfileira durante compra ativa sem mensagem de fila', async () => {
  const source = readSource(indexPath);
  const functionSource = extractNamedFunction(source, 'flushBuyDebounce');
  const buyDebounceBuffer = new Map();
  const sentTexts = [];
  const session = {
    items: [],
    purchaseFlow: {
      state: 'awaiting_size',
      productId: 101,
      buyQueue: [],
    },
  };

  buyDebounceBuffer.set('5585999999999', {
    products: [{ id: 202, name: 'Produto dois' }],
    timer: null,
  });

  const flushBuyDebounce = instantiateFunction(functionSource, 'flushBuyDebounce', {
    buyDebounceBuffer,
    getSession: async () => session,
    persistSession: () => {},
    startInteractivePurchase: async () => {
      throw new Error('nao deveria iniciar outro produto durante compra ativa');
    },
    zapi: {
      sendText: async (_phone, message) => sentTexts.push(message),
    },
    logger: {
      info() {},
      error() {},
    },
  });

  await flushBuyDebounce('5585999999999');

  assert.deepEqual(plain(session.purchaseFlow.buyQueue), [
    { productId: 202, productName: 'Produto dois', productSnapshot: { id: 202, name: 'Produto dois' } },
  ]);
  assert.deepEqual(sentTexts, []);
});
