const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const indexSource = fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');

test('servidor expoe imagem educativa como asset publico', () => {
  assert.match(indexSource, /const path = require\('path'\);/);
  assert.match(indexSource, /const ORDER_GUIDE_IMAGE_PATH = '\/assets\/order-guide\.png';/);
  assert.match(indexSource, /app\.use\('\/assets', express\.static\(path\.join\(__dirname, 'assets'\)\)\);/);
});

test('fluxo Fechar Pedido envia imagem educativa antes da instrucao textual', () => {
  const buttonBlockStart = indexSource.indexOf("if (text === 'BTN_FECHAR_PEDIDO')");
  assert.ok(buttonBlockStart > 0, 'BTN_FECHAR_PEDIDO block not found');

  const buttonBlock = indexSource.slice(buttonBlockStart, indexSource.indexOf('return;', buttonBlockStart));
  assert.match(buttonBlock, /getOrderGuideImageDataUri\(\)/);
  assert.match(buttonBlock, /zapi\.sendImage\(from, orderGuideImage,/);
  assert.ok(
    buttonBlock.indexOf('zapi.sendImage(from, orderGuideImage') < buttonBlock.indexOf('zapi.sendText(from, pedidoMsg)'),
    'order guide image should be sent before pedidoMsg'
  );
});

test('imagem educativa e enviada como data URI para evitar pagina HTML do ngrok', () => {
  assert.match(indexSource, /const fs = require\('fs'\);/);
  assert.match(indexSource, /const ORDER_GUIDE_IMAGE_FILE = path\.join\(__dirname, 'assets', 'order-guide\.png'\);/);
  assert.match(indexSource, /data:image\/png;base64,/);
});
