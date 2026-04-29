const test = require('node:test');
const assert = require('node:assert/strict');

const semantic = require('../services/semantic');

test('analyzeUserMessage reconhece reposicao como busca de produto', () => {
  const result = semantic.analyzeUserMessage('vai repor os pijamas longos de ontem?');

  assert.equal(result.wantsProductSearch, true);
  assert.equal(result.wantsLaunches, true);
});

test('analyzeUserMessage reconhece estampa/personagem como busca sem palavra buscar', () => {
  const result = semantic.analyzeUserMessage('tem aquela estampa do homem aranha?');

  assert.equal(result.wantsProductSearch, true);
});
