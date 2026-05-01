const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBelaPauseCommand, parseTrackingCommand } = require('../../src/inbound/command-parsers');

// ── parseBelaPauseCommand ───────────────────────────────────────────────

test('parseBelaPauseCommand aceita PAUSAR BELA com número local e normaliza', () => {
  const r = parseBelaPauseCommand('PAUSAR BELA (85) 99999-7777');
  assert.equal(r.action, 'pause');
  assert.equal(r.targetPhone, '5585999997777');
});

test('parseBelaPauseCommand aceita ATIVAR BELA com número já normalizado', () => {
  const r = parseBelaPauseCommand('ativar bela 5585999997777');
  assert.equal(r.action, 'resume');
  assert.equal(r.targetPhone, '5585999997777');
});

test('parseBelaPauseCommand aceita REATIVAR como sinônimo de ativar', () => {
  const r = parseBelaPauseCommand('reativar bela 5585999997777');
  assert.equal(r.action, 'resume');
});

test('parseBelaPauseCommand retorna null sem telefone', () => {
  assert.equal(parseBelaPauseCommand('PAUSAR BELA'), null);
});

test('parseBelaPauseCommand retorna null para texto não-comando', () => {
  assert.equal(parseBelaPauseCommand('oi tudo bem'), null);
  assert.equal(parseBelaPauseCommand(''), null);
  assert.equal(parseBelaPauseCommand(null), null);
});

// ── parseTrackingCommand ────────────────────────────────────────────────

test('parseTrackingCommand aceita formato slash', () => {
  const r = parseTrackingCommand('/rastreio 5585999997777 BR123456789BR');
  assert.equal(r.targetPhone, '5585999997777');
  assert.equal(r.trackingCode, 'BR123456789BR');
});

test('parseTrackingCommand normaliza telefone com máscara local no formato slash', () => {
  const r = parseTrackingCommand('/rastreio (85) 99999-7777 br123456789br');
  assert.equal(r.targetPhone, '5585999997777');
  assert.equal(r.trackingCode, 'BR123456789BR');
});

test('parseTrackingCommand aceita linguagem natural com palavra rastreio', () => {
  const r = parseTrackingCommand('rastreio 5585999997777 BR123456789BR');
  assert.equal(r.targetPhone, '5585999997777');
  assert.equal(r.trackingCode, 'BR123456789BR');
});

test('parseTrackingCommand aceita frases naturais com preposições', () => {
  const r = parseTrackingCommand('envia rastreio pro 85999997777: BR123456789BR');
  assert.equal(r.targetPhone, '5585999997777');
  assert.equal(r.trackingCode, 'BR123456789BR');
});

test('parseTrackingCommand aceita verbo rastrear', () => {
  const r = parseTrackingCommand('rastrear 85999997777 codigo BR123456789BR');
  assert.equal(r.targetPhone, '5585999997777');
  assert.equal(r.trackingCode, 'BR123456789BR');
});

test('parseTrackingCommand ignora comando de pausa (sem conflito)', () => {
  assert.equal(parseTrackingCommand('pausar bela 11999999999'), null);
});

test('parseTrackingCommand retorna null para frase sem código', () => {
  assert.equal(parseTrackingCommand('quero saber o rastreio do meu pedido'), null);
});

test('parseTrackingCommand retorna null para texto sem palavra-chave nem slash', () => {
  assert.equal(parseTrackingCommand('5585999997777 BR123456789BR'), null);
});

test('parseTrackingCommand sinaliza telefone inválido no formato slash', () => {
  const r = parseTrackingCommand('/rastreio xyz BR123456789BR');
  assert.equal(r.error, 'invalid_phone');
  assert.equal(r.targetPhone, undefined);
});

test('parseTrackingCommand sinaliza código inválido (curto demais)', () => {
  const r = parseTrackingCommand('/rastreio 5585999997777 ABC');
  assert.equal(r.error, 'invalid_code');
  assert.equal(r.trackingCode, undefined);
});

test('parseTrackingCommand sempre normaliza código para uppercase', () => {
  const r = parseTrackingCommand('/rastreio 5585999997777 br123abc456cd');
  assert.equal(r.trackingCode, 'BR123ABC456CD');
});
