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

function loadPauseHelpers() {
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
      isAdminPhone,
      normalizeWhatsAppPhone,
      parseBelaPauseCommand,
      shouldSkipBotAutomation,
      isHumanPauseResumeIntent,
    });
  `);
  const sandbox = {};
  vm.createContext(sandbox);
  return script.runInContext(sandbox);
}

test('parseBelaPauseCommand aceita PAUSAR BELA com numero local e normaliza para WhatsApp BR', () => {
  const { parseBelaPauseCommand } = loadPauseHelpers();

  const command = parseBelaPauseCommand('PAUSAR BELA (85) 99999-7777');

  assert.equal(command.action, 'pause');
  assert.equal(command.targetPhone, '5585999997777');
});

test('parseBelaPauseCommand aceita ATIVAR BELA para reativar atendimento do bot', () => {
  const { parseBelaPauseCommand } = loadPauseHelpers();

  const command = parseBelaPauseCommand('ativar bela 5585999997777');

  assert.equal(command.action, 'resume');
  assert.equal(command.targetPhone, '5585999997777');
});

test('parseBelaPauseCommand ignora PAUSAR BELA sem telefone alvo', () => {
  const { parseBelaPauseCommand } = loadPauseHelpers();

  assert.equal(parseBelaPauseCommand('PAUSAR BELA'), null);
});

test('isAdminPhone compara numeros normalizados', () => {
  const { isAdminPhone } = loadPauseHelpers();

  assert.equal(isAdminPhone('(85) 99998-8888'), true);
  assert.equal(isAdminPhone('85900001111'), false);
});

test('shouldSkipBotAutomation bloqueia automacoes em handoff humano ou pausa manual', () => {
  const { shouldSkipBotAutomation } = loadPauseHelpers();

  assert.equal(shouldSkipBotAutomation({ supportMode: 'human_pending' }), true);
  assert.equal(shouldSkipBotAutomation({ supportMode: 'manual_human_pause' }), true);
  assert.equal(shouldSkipBotAutomation({ supportMode: 'fechar_pedido_pending' }), false);
  assert.equal(shouldSkipBotAutomation({ supportMode: null }), false);
});

test('isHumanPauseResumeIntent reconhece interesse em novas pecas', () => {
  const { isHumanPauseResumeIntent } = loadPauseHelpers();

  assert.equal(isHumanPauseResumeIntent({}, 'quero ver novas pecas'), true);
  assert.equal(isHumanPauseResumeIntent({ wantsLaunches: true }, 'bom dia'), true);
  assert.equal(isHumanPauseResumeIntent({}, 'bom dia'), false);
});
