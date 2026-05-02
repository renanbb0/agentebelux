const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSizeValue,
  normalizeVariantText,
  matchVariant,
  parseGradeText,
  parseMultiVariantGrade,
} = require('../../src/utils/variant-text');

test('normalizeSizeValue normaliza strings de tamanho', () => {
  assert.equal(normalizeSizeValue('  p  '), 'P');
  assert.equal(normalizeSizeValue('gg'), 'GG');
  assert.equal(normalizeSizeValue('M'), 'M');
  assert.equal(normalizeSizeValue(''), '');
  assert.equal(normalizeSizeValue(null), '');
});

test('normalizeVariantText remove acentos e coloca em minúsculas', () => {
  assert.equal(normalizeVariantText('Mãe'), 'mae');
  assert.equal(normalizeVariantText('FILHA'), 'filha');
  assert.equal(normalizeVariantText('Adulto'), 'adulto');
  assert.equal(normalizeVariantText(''), '');
  assert.equal(normalizeVariantText(null), '');
});

test('matchVariant casa por nome normalizado', () => {
  const opts = ['Mãe', 'Filha'];
  assert.equal(matchVariant('Mãe', opts), 'Mãe');
  assert.equal(matchVariant('mae', opts), 'Mãe');
  assert.equal(matchVariant('filha', opts), 'Filha');
  assert.equal(matchVariant('FILHA', opts), 'Filha');
  assert.equal(matchVariant('outro', opts), null);
  assert.equal(matchVariant(null, opts), null);
});

test('matchVariant casa por índice numérico base-1', () => {
  const opts = ['Mãe', 'Filha'];
  assert.equal(matchVariant('1', opts), 'Mãe');
  assert.equal(matchVariant('2', opts), 'Filha');
  assert.equal(matchVariant('3', opts), null);
});

test('parseGradeText extrai grade de texto qty+tamanho', () => {
  const r = parseGradeText('2P 3M 1G', ['P', 'M', 'G', 'GG']);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), [
    { size: 'P', qty: 2 },
    { size: 'M', qty: 3 },
    { size: 'G', qty: 1 },
  ]);
});

test('parseGradeText reconhece "1 de cada" e distribui para todos os tamanhos', () => {
  const r = parseGradeText('1 de cada', ['P', 'M', 'G']);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), [
    { size: 'P', qty: 1 },
    { size: 'M', qty: 1 },
    { size: 'G', qty: 1 },
  ]);
});

test('parseGradeText reconhece "manda toda a grade"', () => {
  const r = parseGradeText('manda toda a grade', ['M', 'G']);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), [
    { size: 'M', qty: 1 },
    { size: 'G', qty: 1 },
  ]);
});

test('parseGradeText retorna null para input sem tamanhos válidos', () => {
  assert.equal(parseGradeText('', ['P', 'M']), null);
  assert.equal(parseGradeText(null, ['P', 'M']), null);
  assert.equal(parseGradeText('oi tudo bem', ['P', 'M']), null);
  assert.equal(parseGradeText('2P', null), null);
});

test('parseGradeText detecta tamanhos órfãos (digitou P mas produto só tem M/G)', () => {
  const r = parseGradeText('1P', ['M', 'G']);
  assert.equal(r.length, 0);
  assert.deepEqual(r._orphanSizes, ['P']);
});

test('parseGradeText aceita produto de tamanho único com quantidade solta', () => {
  const r = parseGradeText('5', ['M']);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), [{ size: 'M', qty: 5 }]);
});

test('parseMultiVariantGrade extrai pares variante+grade (variante antes da grade)', () => {
  const r = parseMultiVariantGrade('mae 2G filha 1P', ['Mãe', 'Filha'], ['P', 'G']);
  const clean = JSON.parse(JSON.stringify(r));
  assert.equal(clean.length, 2);
  assert.equal(clean[0].variant, 'Mãe');
  assert.deepEqual(clean[0].grade, [{ size: 'G', qty: 2 }]);
  assert.equal(clean[1].variant, 'Filha');
  assert.deepEqual(clean[1].grade, [{ size: 'P', qty: 1 }]);
});

test('parseMultiVariantGrade retorna null para texto sem variantes reconhecidas', () => {
  assert.equal(parseMultiVariantGrade('2G 1P', ['Mãe', 'Filha'], ['P', 'G']), null);
  assert.equal(parseMultiVariantGrade('', ['Mãe', 'Filha'], ['P', 'G']), null);
  assert.equal(parseMultiVariantGrade(null, ['Mãe', 'Filha'], ['P', 'G']), null);
});
