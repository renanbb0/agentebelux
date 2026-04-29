const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function extractNamedFunction(source, functionName) {
  const asyncNeedle = `async function ${functionName}(`;
  const syncNeedle = `function ${functionName}(`;
  const start = source.indexOf(asyncNeedle) >= 0
    ? source.indexOf(asyncNeedle)
    : source.indexOf(syncNeedle);

  if (start < 0) throw new Error(`Function ${functionName} not found`);

  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Function ${functionName} body not closed`);
}

function instantiateFunction(functionSource, functionName, context = {}) {
  const vm = require('node:vm');
  const sandbox = { ...context };
  vm.createContext(sandbox);
  return new vm.Script(`(() => { ${functionSource}; return ${functionName}; })()`).runInContext(sandbox);
}

test('index.js possui kill switch e caminho deterministico para busca comercial', () => {
  assert.match(indexSource, /catalogQueryResolver/);
  assert.match(indexSource, /catalogSearch/);
  assert.match(indexSource, /CATALOG_RESOLVER_ENABLED/);
  assert.match(indexSource, /tryHandleCommercialCatalogQuery/);
});

test('sendCatalogProductImageOnly salva messageId para listas responderem ao card', async () => {
  const fnSource = extractNamedFunction(indexSource, 'sendCatalogProductImageOnly');
  const registered = [];
  const sendCatalogProductImageOnly = instantiateFunction(fnSource, 'sendCatalogProductImageOnly', {
    woocommerce: { buildCaption: () => 'caption' },
    zapi: {
      sendImage: async () => ({ data: { zaapId: 'zaap-1', messageId: 'msg-1' } }),
      sendText: async () => ({ data: { zaapId: 'text-1', messageId: 'text-msg-1' } }),
    },
    registerMessageProduct: (session, zaapId, messageId, product) => {
      registered.push({ zaapId, messageId, productId: product.id });
    },
  });
  const session = {};

  await sendCatalogProductImageOnly('5585999999999', { id: 123, imageUrl: 'https://example.test/p.jpg' }, session, 1);

  assert.deepEqual(registered, [{ zaapId: 'zaap-1', messageId: 'msg-1', productId: 123 }]);
  assert.equal(session.productShowcaseMessageId[123], 'msg-1');
});
