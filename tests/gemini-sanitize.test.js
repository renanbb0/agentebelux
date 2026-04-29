const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const geminiPath = require.resolve('../services/gemini');

function loadGeminiWithStubs() {
  delete require.cache[geminiPath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '@google/generative-ai') {
      return {
        GoogleGenerativeAI: class {
          getGenerativeModel() {
            return {};
          }
        },
      };
    }
    if (request === './learnings') {
      return { getActive: async () => [] };
    }
    if (request === './logger') {
      return { info() {}, debug() {}, warn() {}, error() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require('../services/gemini');
  } finally {
    Module._load = originalLoad;
  }
}

test('parseAction remove bloco think com tags antes de enviar texto visivel', () => {
  const { parseAction } = loadGeminiWithStubs();

  const parsed = parseAction('<think>analise interna</think>Oi Patricia! Quer ver mais opções?');

  assert.equal(parsed.cleanText, 'Oi Patricia! Quer ver mais opções?');
});

test('parseAction remove vazamento bare think ate a resposta final', () => {
  const { parseAction } = loadGeminiWithStubs();

  const leaked = `think
A cliente Patricia está dizendo "Não tem mais os outros".
Preciso interpretar o que ela quer dizer.
Minha resposta deve ser natural.

Resposta final:
Poxa Patricia! Você queria ver mais opções ou estava procurando alguma peça específica que não achou?`;

  const parsed = parseAction(leaked);

  assert.equal(
    parsed.cleanText,
    'Poxa Patricia! Você queria ver mais opções ou estava procurando alguma peça específica que não achou?'
  );
});
