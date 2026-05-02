const test = require('node:test');
const assert = require('node:assert/strict');
const { isHumanPauseResumeIntent } = require('../../src/ai/intent');

test('isHumanPauseResumeIntent reconhece interesse explícito em peças/produtos no texto', () => {
  assert.equal(isHumanPauseResumeIntent({}, 'quero ver novas peças'), true);
  assert.equal(isHumanPauseResumeIntent({}, 'me mostra os lançamentos'), true);
  assert.equal(isHumanPauseResumeIntent({}, 'ver mais produtos'), true);
  assert.equal(isHumanPauseResumeIntent({}, 'fechar pedido agora'), true);
  assert.equal(isHumanPauseResumeIntent({}, 'fazer pedido'), true);
});

test('isHumanPauseResumeIntent reconhece flags de análise semântica', () => {
  assert.equal(isHumanPauseResumeIntent({ wantsLaunches: true }, 'bom dia'), true);
  assert.equal(isHumanPauseResumeIntent({ wantsBrowse: true }, 'qq'), true);
  assert.equal(isHumanPauseResumeIntent({ wantsCheckout: true }, ''), true);
  assert.equal(isHumanPauseResumeIntent({ wantsPhotosExplicit: true }, ''), true);
  assert.equal(isHumanPauseResumeIntent({ categories: ['feminino'] }, ''), true);
});

test('isHumanPauseResumeIntent retorna false para saudações puras sem intent', () => {
  assert.equal(isHumanPauseResumeIntent({}, 'bom dia'), false);
  assert.equal(isHumanPauseResumeIntent({}, 'oi'), false);
  assert.equal(isHumanPauseResumeIntent({}, ''), false);
  assert.equal(isHumanPauseResumeIntent(null, 'oi'), false);
});

test('isHumanPauseResumeIntent normaliza acentos antes de matchar', () => {
  assert.equal(isHumanPauseResumeIntent({}, 'lançamentos'), true);
  assert.equal(isHumanPauseResumeIntent({}, 'lancamentos'), true);
  assert.equal(isHumanPauseResumeIntent({}, 'PEÇAS NOVAS'), true);
});
