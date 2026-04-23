const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const zapiPath = require.resolve('../services/zapi');

function loadZapiWithAxiosStub(postStub) {
  delete require.cache[zapiPath];

  const axiosStub = {
    create: () => ({
      post: postStub,
      get: async () => ({}),
      defaults: { headers: { common: {} } },
    }),
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'axios') return axiosStub;
    return originalLoad.call(this, request, parent, isMain);
  };

  process.env.ZAPI_INSTANCE_ID = 'instance';
  process.env.ZAPI_TOKEN = 'token';
  process.env.ZAPI_CLIENT_TOKEN = 'client-token';

  try {
    return require('../services/zapi');
  } finally {
    Module._load = originalLoad;
  }
}

test('sendDocument envia PDF em data URI para o endpoint correto com extensão no path', async () => {
  let capturedPath = null;
  let capturedPayload = null;

  const zapi = loadZapiWithAxiosStub(async (path, payload) => {
    capturedPath = path;
    capturedPayload = payload;
    return { data: { zaapId: 'abc123' } };
  });

  const pdfBuffer = Buffer.from('%PDF-1.7 fake');
  await zapi.sendDocument('5585981244025', pdfBuffer, 'pedido.pdf');

  // Z-API exige extensão no path: /send-document/pdf (não /send-document)
  assert.equal(capturedPath, '/send-document/pdf');
  assert.equal(capturedPayload.phone, '5585981244025');
  assert.equal(capturedPayload.fileName, 'pedido.pdf');
  assert.ok(capturedPayload.document.startsWith('data:application/pdf;base64,'));
  assert.equal(
    capturedPayload.document,
    `data:application/pdf;base64,${pdfBuffer.toString('base64')}`
  );
});

test('sendDocument aceita extensão customizada', async () => {
  let capturedPath = null;
  let capturedPayload = null;

  const zapi = loadZapiWithAxiosStub(async (path, payload) => {
    capturedPath = path;
    capturedPayload = payload;
    return { data: { zaapId: 'xyz789' } };
  });

  const buffer = Buffer.from('fake-xlsx-bytes');
  await zapi.sendDocument('5585981244025', buffer, 'planilha.xlsx', 'xlsx');

  assert.equal(capturedPath, '/send-document/xlsx');
  assert.ok(capturedPayload.document.startsWith('data:application/xlsx;base64,'));
});
