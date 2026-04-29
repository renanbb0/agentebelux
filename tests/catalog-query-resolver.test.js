const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveCatalogQuery,
  shouldUseCatalogResolver,
} = require('../services/catalog-query-resolver');

test('resolveCatalogQuery extrai referencia exata', () => {
  const intent = resolveCatalogQuery('tem a ref 615S?');

  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.intentType, 'reference');
  assert.equal(intent.reference, '615S');
  assert.equal(intent.query, '615S');
  assert.equal(intent.isStockQuestion, true);
});

test('resolveCatalogQuery entende estampa/personagem sem exigir palavra buscar', () => {
  const intent = resolveCatalogQuery('tem aquela estampa do homem aranha?');

  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.intentType, 'theme');
  assert.equal(intent.theme, 'homem aranha');
  assert.equal(intent.query, 'homem aranha');
  assert.equal(intent.isStockQuestion, true);
});

test('resolveCatalogQuery entende pijama longo lancado ontem', () => {
  const intent = resolveCatalogQuery('pijamas longos lançados ontem');

  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.intentType, 'product');
  assert.equal(intent.recency?.type, 'yesterday');
  assert.match(intent.query, /pijama/);
  assert.match(intent.query, /longo/);
});

test('resolveCatalogQuery trata reposicao como pergunta de estoque atual', () => {
  const intent = resolveCatalogQuery('vai repor os pijamas longos de ontem?');

  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.isRestockQuestion, true);
  assert.equal(intent.isStockQuestion, true);
  assert.equal(intent.recency?.type, 'yesterday');
  assert.match(intent.query, /pijama/);
  assert.match(intent.query, /longo/);
});

test('resolveCatalogQuery reconhece categoria ampla', () => {
  const intent = resolveCatalogQuery('quero ver feminino');

  assert.equal(intent.shouldHandle, true);
  assert.equal(intent.intentType, 'category');
  assert.equal(intent.categorySlug, 'feminino');
});

test('shouldUseCatalogResolver respeita kill switch e FSM ativa', () => {
  const idleSession = { purchaseFlow: { state: 'idle' } };
  const busySession = { purchaseFlow: { state: 'awaiting_size' } };

  assert.equal(
    shouldUseCatalogResolver({ text: 'tem a ref 615S?', session: idleSession, env: {} }),
    true
  );
  assert.equal(
    shouldUseCatalogResolver({ text: 'tem a ref 615S?', session: idleSession, env: { CATALOG_RESOLVER_ENABLED: 'false' } }),
    false
  );
  assert.equal(
    shouldUseCatalogResolver({ text: 'tem a ref 615S?', session: busySession, env: {} }),
    false
  );
});
