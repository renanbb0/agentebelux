const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'index.js');

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

function instantiateInboundBufferHelpers(context = {}) {
  const source = readSource(indexPath);
  const script = new vm.Script(`
    ${extractBetween(source, 'const inboundTextDebounceBuffer =', '// -- Sessions')}
    ({
      shouldDebounceInboundText,
      formatBufferedInboundMessages,
      enqueueInboundTextDebounce,
    });
  `);
  const sandbox = {
    Map,
    Promise,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Number,
    process: { env: {} },
    ...context,
  };
  vm.createContext(sandbox);
  return script.runInContext(sandbox);
}

test('shouldDebounceInboundText aceita apenas texto livre seguro para agrupar', () => {
  const { shouldDebounceInboundText } = instantiateInboundBufferHelpers();

  assert.equal(shouldDebounceInboundText({ text: { message: 'Bom dia' } }, 'Bom dia'), true);
  assert.equal(shouldDebounceInboundText({ text: { message: 'Tem como me enviar?' } }, 'Tem como me enviar?'), true);

  assert.equal(shouldDebounceInboundText({ image: { imageUrl: 'https://img' }, text: { message: '2M' } }, '2M'), false);
  assert.equal(shouldDebounceInboundText({ listResponseMessage: { selectedRowId: 'x' } }, 'gate_catalog'), false);
  assert.equal(shouldDebounceInboundText({ buttonsResponseMessage: { buttonId: 'CART_VIEW' } }, 'CART_VIEW'), false);
  assert.equal(shouldDebounceInboundText({ quotedMessage: { messageId: 'old' }, text: { message: '2M' } }, '2M'), false);
  assert.equal(shouldDebounceInboundText({ text: { message: '[Audio_STT]' } }, '[Audio_STT]'), false);
});

test('enqueueInboundTextDebounce agrupa rajada em uma unica mensagem contextual', async () => {
  const { enqueueInboundTextDebounce } = instantiateInboundBufferHelpers();
  const bufferMap = new Map();

  const firstFlush = enqueueInboundTextDebounce('5585999999999', {
    messageId: 'msg-1',
    text: { message: 'Bom dia' },
  }, 'Bom dia', { bufferMap, debounceMs: 10 });

  const secondFlush = enqueueInboundTextDebounce('5585999999999', {
    messageId: 'msg-2',
    text: { message: 'Ficaram de postar ontem no grupo o catalogo atualizado mas nao foi' },
  }, 'Ficaram de postar ontem no grupo o catalogo atualizado mas nao foi', { bufferMap, debounceMs: 10 });

  const thirdFlush = enqueueInboundTextDebounce('5585999999999', {
    messageId: 'msg-3',
    text: { message: 'Tem como me enviar?' },
  }, 'Tem como me enviar?', { bufferMap, debounceMs: 10 });

  assert.equal(secondFlush, null);
  assert.equal(thirdFlush, null);

  const flushed = await firstFlush;

  assert.equal(flushed.messageId, 'msg-3');
  assert.equal(JSON.stringify(flushed.messageIds), JSON.stringify(['msg-1', 'msg-2', 'msg-3']));
  assert.match(flushed.text, /Cliente enviou 3 mensagens em sequencia/);
  assert.match(flushed.text, /- Bom dia/);
  assert.match(flushed.text, /- Ficaram de postar ontem no grupo/);
  assert.match(flushed.text, /- Tem como me enviar\?/);
  assert.equal(flushed.body.text.message, flushed.text);
  assert.equal(bufferMap.has('5585999999999'), false);
});
