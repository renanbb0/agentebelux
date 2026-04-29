const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const indexPath = path.join(__dirname, '..', 'index.js');

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
    const ch = source[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }

  throw new Error(`Function ${functionName} body not closed`);
}

function instantiateFunction(functionSource, functionName, context = {}) {
  const sandbox = { ...context };
  vm.createContext(sandbox);
  return new vm.Script(`(() => { ${functionSource}; return ${functionName}; })()`).runInContext(sandbox);
}

test('sendStockAwareSizeQtyList responde ao card do produto quando ha messageId salvo', async () => {
  const source = fs.readFileSync(indexPath, 'utf8');
  const functionSource = [
    extractNamedFunction(source, 'getProductShowcaseMessageId'),
    extractNamedFunction(source, 'sendStockAwareSizeQtyList'),
  ].join('\n');
  const calls = [];
  const product = { id: 7855, name: 'Pijama manga longa infantil' };
  const session = {
    productShowcaseMessageId: { 7855: 'CARD_MESSAGE_ID' },
    purchaseFlow: { productId: 7855 },
  };

  const sendStockAwareSizeQtyList = instantiateFunction(functionSource, 'sendStockAwareSizeQtyList', {
    ensureProductStockData: async (p) => p,
    getVariantFilter: () => null,
    buildSessionSizeDetails: () => [{ size: 'M', isAvailable: true, availableQuantity: 3 }],
    zapi: {
      sendSizeQuantityList: async (...args) => calls.push(args),
    },
  });

  await sendStockAwareSizeQtyList('5585981244025', session, product, 1);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][4], 'CARD_MESSAGE_ID');
});
