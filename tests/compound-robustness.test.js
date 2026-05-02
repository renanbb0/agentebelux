const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'index.js');
const imageMatcherPath = path.join(repoRoot, 'services', 'image-matcher.js');

const { parseCompoundSpec } = require('../src/utils/compound-parser');
const { normalizeVariantText, matchVariant, parseGradeText, parseMultiVariantGrade } = require('../src/utils/variant-text');

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

function instantiateIndexHelpers(context = {}) {
  const source = readSource(indexPath);
  const script = new vm.Script(`
    ${extractBetween(source, 'function detectCompoundCase', '/**\r\n * Classifica resposta')}
    ${extractBetween(source, 'function clearCompoundState', '/**\r\n * Agenda')}
    ${extractBetween(source, 'function detectCompoundInconsistencies', 'async function runCompoundConfirmation')}
    ${extractBetween(source, 'async function runCompoundConfirmation', '// ── Handoff humano')}
    ({
      parseCompoundSpec,
      detectCompoundCase,
      runCompoundConfirmation,
    });
  `);
  const sandbox = {
    console,
    Date,
    String,
    Number,
    Array,
    Object,
    RegExp,
    parseInt,
    parseFloat,
    parseCompoundSpec,
    normalizeVariantText,
    matchVariant,
    parseGradeText,
    parseMultiVariantGrade,
    ...context,
  };
  vm.createContext(sandbox);
  return script.runInContext(sandbox);
}

test('parseCompoundSpec reconhece "N de cada no TAM P, M, G, GG" como grade por produto', () => {
  const spec = parseCompoundSpec('Eu quero 1 de cada no TAM P, M, g gg');

  assert.deepEqual(JSON.parse(JSON.stringify(spec)), {
    perVariant: null,
    perSize: null,
    perVariantGrade: [
      { size: 'P', qty: 1 },
      { size: 'M', qty: 1 },
      { size: 'G', qty: 1 },
      { size: 'GG', qty: 1 },
    ],
  });
});

test('runCompoundConfirmation usa plano deterministico e nao chama Gemini compoundMode', async () => {
  let aiCalled = false;
  const sent = [];
  const history = [];
  let persistedPhone = null;

  const { runCompoundConfirmation } = instantiateIndexHelpers({
    COMPOUND_CONFIRMATION_TTL_MS: 5 * 60 * 1000,
    distributeCompoundGrade: (products, spec) => ({
      items: products.map((product) => ({ productId: product.productId, name: product.name, grade: spec.perVariantGrade })),
      totalPieces: products.length * spec.perVariantGrade.reduce((acc, entry) => acc + entry.qty, 0),
      inconsistencies: [],
    }),
    logger: { info() {}, warn() {}, error() {} },
    zapi: { sendText: async (phone, message) => sent.push({ phone, message }) },
    ai: { chat: async () => { aiCalled = true; return '{}'; } },
    appendHistory: (_session, role, content) => history.push({ role, content }),
    conversationMemory: { refreshConversationMemory() {} },
    persistSession: (phone) => { persistedPhone = phone; },
    scheduleFecharPedidoHandoff() {},
  });

  const session = {
    pendingSizeTexts: [{ text: '1 de cada no TAM P, M' }],
    matchedProducts: [
      { productId: 101, name: 'Pijama A', sizes: ['P', 'M'], confidence: 0.91 },
      { productId: 202, name: 'Pijama B', sizes: ['P', 'M'], confidence: 0.89 },
    ],
    history: [],
  };

  await runCompoundConfirmation('5599999999999', session);

  assert.equal(aiCalled, false);
  assert.equal(session.awaitingCompoundConfirmation, true);
  assert.equal(session.pendingCompoundGrade.totalPieces, 4);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Pijama A/);
  assert.match(sent[0].message, /Total: \*4 peças\*/);
  assert.equal(history[0].role, 'assistant');
  assert.equal(persistedPhone, '5599999999999');
});

test('image matcher protege chamadas Gemini com semaforo e retry 503/429', () => {
  const source = readSource(imageMatcherPath);

  assert.match(source, /function withVisionSemaphore/);
  assert.match(source, /function withRetry503/);
  assert.match(source, /429/);
  assert.match(source, /describeImage[\s\S]*withVisionSemaphore[\s\S]*withRetry503/);
  assert.match(source, /confirmMatch[\s\S]*withVisionSemaphore[\s\S]*withRetry503/);
  assert.match(source, /embedText[\s\S]*withRetry503/);
});

test('compound timers aguardam fila de ImageMatch antes de confirmar', () => {
  const source = readSource(indexPath);

  assert.match(source, /MAX_WAIT_FOR_FLIGHT\s*=\s*30_000/);
  assert.match(source, /Aguardando fila ImageMatch/);
  assert.match(source, /Timeout esperando fila/);
  assert.match(source, /schedulePendingCompoundConfirmation[\s\S]*pendingImageMatches[\s\S]*runCompoundConfirmation/);
  assert.match(source, /scheduleNormalCompoundCheck[\s\S]*pendingImageMatches[\s\S]*runCompoundConfirmation/);
});
