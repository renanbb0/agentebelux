const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const indexPath = path.join(path.resolve(__dirname, '..'), 'index.js');

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

function loadTrackingHelpers() {
  const source = readSource(indexPath);
  const helperSource = extractBetween(
    source,
    '// -- Manual Bela pause helpers --',
    '// -- End Manual Bela pause helpers --'
  );
  const script = new vm.Script(`
    const ADMIN_PHONES = ['5585999988888'];
    ${helperSource}
    ({
      parseTrackingCommand,
      normalizeWhatsAppPhone,
      isAdminPhone,
    });
  `);
  const sandbox = {};
  vm.createContext(sandbox);
  return script.runInContext(sandbox);
}

test('parseTrackingCommand aceita formato slash com telefone normalizado', () => {
  const { parseTrackingCommand } = loadTrackingHelpers();

  const result = parseTrackingCommand('/rastreio 5585999997777 BR123456789BR');

  assert.equal(result.targetPhone, '5585999997777');
  assert.equal(result.trackingCode, 'BR123456789BR');
});

test('parseTrackingCommand normaliza telefone com mascara local no formato slash', () => {
  const { parseTrackingCommand } = loadTrackingHelpers();

  const result = parseTrackingCommand('/rastreio (85) 99999-7777 br123456789br');

  assert.equal(result.targetPhone, '5585999997777');
  assert.equal(result.trackingCode, 'BR123456789BR');
});

test('parseTrackingCommand aceita linguagem natural com palavra rastreio', () => {
  const { parseTrackingCommand } = loadTrackingHelpers();

  const result = parseTrackingCommand('rastreio 5585999997777 BR123456789BR');

  assert.equal(result.targetPhone, '5585999997777');
  assert.equal(result.trackingCode, 'BR123456789BR');
});

test('parseTrackingCommand aceita frases naturais com preposicoes', () => {
  const { parseTrackingCommand } = loadTrackingHelpers();

  const result = parseTrackingCommand('envia rastreio pro 85999997777: BR123456789BR');

  assert.equal(result.targetPhone, '5585999997777');
  assert.equal(result.trackingCode, 'BR123456789BR');
});

test('parseTrackingCommand aceita verbo rastrear', () => {
  const { parseTrackingCommand } = loadTrackingHelpers();

  const result = parseTrackingCommand('rastrear 85999997777 codigo BR123456789BR');

  assert.equal(result.targetPhone, '5585999997777');
  assert.equal(result.trackingCode, 'BR123456789BR');
});

test('parseTrackingCommand ignora comando de pausa (sem conflito)', () => {
  const { parseTrackingCommand } = loadTrackingHelpers();

  assert.equal(parseTrackingCommand('pausar bela 11999999999'), null);
});

test('parseTrackingCommand retorna null para frase sem codigo', () => {
  const { parseTrackingCommand } = loadTrackingHelpers();

  assert.equal(parseTrackingCommand('quero saber o rastreio do meu pedido'), null);
});

test('parseTrackingCommand retorna null para texto sem palavra-chave nem slash', () => {
  const { parseTrackingCommand } = loadTrackingHelpers();

  assert.equal(parseTrackingCommand('5585999997777 BR123456789BR'), null);
});

test('parseTrackingCommand sinaliza telefone invalido no formato slash', () => {
  const { parseTrackingCommand } = loadTrackingHelpers();

  const result = parseTrackingCommand('/rastreio xyz BR123456789BR');

  assert.equal(result.error, 'invalid_phone');
  assert.equal(result.targetPhone, undefined);
});

test('parseTrackingCommand sinaliza codigo invalido (curto demais)', () => {
  const { parseTrackingCommand } = loadTrackingHelpers();

  const result = parseTrackingCommand('/rastreio 5585999997777 ABC');

  assert.equal(result.error, 'invalid_code');
  assert.equal(result.trackingCode, undefined);
});

test('parseTrackingCommand sempre normaliza codigo para uppercase', () => {
  const { parseTrackingCommand } = loadTrackingHelpers();

  const result = parseTrackingCommand('/rastreio 5585999997777 br123abc456cd');

  assert.equal(result.trackingCode, 'BR123ABC456CD');
});
