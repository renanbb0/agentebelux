const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCompoundSpec } = require('../../src/utils/compound-parser');

test('parseCompoundSpec reconhece "N de cada estampa" como perVariant', () => {
  assert.deepEqual(parseCompoundSpec('quero 6 de cada estampa'), {
    perVariant: 6, perSize: null, perVariantGrade: null,
  });
});

test('parseCompoundSpec reconhece "N de cada modelo/cor/desenho"', () => {
  assert.deepEqual(parseCompoundSpec('dois de cada modelo'), {
    perVariant: 2, perSize: null, perVariantGrade: null,
  });
  assert.deepEqual(parseCompoundSpec('3 de cada cor'), {
    perVariant: 3, perSize: null, perVariantGrade: null,
  });
});

test('parseCompoundSpec reconhece "N de cada tamanho" como perSize', () => {
  assert.deepEqual(parseCompoundSpec('2 de cada tamanho'), {
    perVariant: null, perSize: 2, perVariantGrade: null,
  });
});

test('parseCompoundSpec reconhece "N de cada no TAM X,Y,Z" como perVariantGrade', () => {
  const spec = parseCompoundSpec('1 de cada no TAM P, M, g gg');
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

test('parseCompoundSpec retorna null para texto sem spec composta', () => {
  assert.equal(parseCompoundSpec('quero 3P 2M'), null);
  assert.equal(parseCompoundSpec('oi tudo bem'), null);
  assert.equal(parseCompoundSpec(''), null);
  assert.equal(parseCompoundSpec(null), null);
});
