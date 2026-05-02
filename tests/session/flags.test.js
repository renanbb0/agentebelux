const test = require('node:test');
const assert = require('node:assert/strict');
const { HUMAN_PAUSE_MODES, isBotSuspendedForHuman, shouldSkipBotAutomation } = require('../../src/session/flags');

test('HUMAN_PAUSE_MODES contém human_pending e manual_human_pause', () => {
  assert.equal(HUMAN_PAUSE_MODES.has('human_pending'), true);
  assert.equal(HUMAN_PAUSE_MODES.has('manual_human_pause'), true);
  assert.equal(HUMAN_PAUSE_MODES.has('fechar_pedido_pending'), false);
});

test('isBotSuspendedForHuman detecta sessões com supportMode em pausa humana', () => {
  assert.equal(isBotSuspendedForHuman({ supportMode: 'human_pending' }), true);
  assert.equal(isBotSuspendedForHuman({ supportMode: 'manual_human_pause' }), true);
  assert.equal(isBotSuspendedForHuman({ supportMode: 'fechar_pedido_pending' }), false);
  assert.equal(isBotSuspendedForHuman({ supportMode: null }), false);
  assert.equal(isBotSuspendedForHuman({}), false);
  assert.equal(isBotSuspendedForHuman(null), false);
});

test('shouldSkipBotAutomation hoje delega a isBotSuspendedForHuman', () => {
  assert.equal(shouldSkipBotAutomation({ supportMode: 'human_pending' }), true);
  assert.equal(shouldSkipBotAutomation({ supportMode: 'manual_human_pause' }), true);
  assert.equal(shouldSkipBotAutomation({ supportMode: 'fechar_pedido_pending' }), false);
  assert.equal(shouldSkipBotAutomation({ supportMode: null }), false);
});
