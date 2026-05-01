const test = require('node:test');
const assert = require('node:assert/strict');
const { digitsOnly, normalizeWhatsAppPhone, isAdminPhone } = require('../../src/utils/phone');

test('digitsOnly remove caracteres não numéricos', () => {
  assert.equal(digitsOnly('+55 (61) 98266-3442'), '5561982663442');
  assert.equal(digitsOnly(''), '');
  assert.equal(digitsOnly(null), '');
  assert.equal(digitsOnly(undefined), '');
  assert.equal(digitsOnly('abc'), '');
  assert.equal(digitsOnly(123), '123');
});

test('normalizeWhatsAppPhone aceita formatos brasileiros e completa DDI 55', () => {
  assert.equal(normalizeWhatsAppPhone('61982663442'), '5561982663442');
  assert.equal(normalizeWhatsAppPhone('5561982663442'), '5561982663442');
  assert.equal(normalizeWhatsAppPhone('+55 61 98266-3442'), '5561982663442');
  assert.equal(normalizeWhatsAppPhone('00 55 61 98266-3442'), '5561982663442');
  assert.equal(normalizeWhatsAppPhone('061982663442'), '5561982663442');
});

test('normalizeWhatsAppPhone rejeita inputs inválidos', () => {
  assert.equal(normalizeWhatsAppPhone(''), null);
  assert.equal(normalizeWhatsAppPhone(null), null);
  assert.equal(normalizeWhatsAppPhone('123'), null);
  assert.equal(normalizeWhatsAppPhone('1234567890123456'), null); // 16 dígitos
  assert.equal(normalizeWhatsAppPhone('abc'), null);
});

test('isAdminPhone compara contra lista normalizada', () => {
  const admins = ['5585999988888'];
  assert.equal(isAdminPhone('(85) 99998-8888', admins), true);
  assert.equal(isAdminPhone('85999988888', admins), true);
  assert.equal(isAdminPhone('5585999988888', admins), true);
  assert.equal(isAdminPhone('85900001111', admins), false);
  assert.equal(isAdminPhone('5585999988888', []), false);
  assert.equal(isAdminPhone(null, admins), false);
});

test('isAdminPhone aceita múltiplos admins', () => {
  const admins = ['5585999988888', '+55 61 9 9999-7777'];
  assert.equal(isAdminPhone('5561999997777', admins), true);
  assert.equal(isAdminPhone('5585999988888', admins), true);
  assert.equal(isAdminPhone('5511999990000', admins), false);
});
