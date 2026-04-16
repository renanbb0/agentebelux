const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const ttsPath = require.resolve('../services/tts');

function loadTtsWithAxiosStub(axiosStub) {
  delete require.cache[ttsPath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'axios') {
      return axiosStub;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require('../services/tts');
  } finally {
    Module._load = originalLoad;
  }
}

test('textToSpeech envia para Gemini TTS e retorna WAV', async () => {
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.TTS_MODEL = 'gemini-2.5-flash-preview-tts';
  process.env.TTS_VOICE = 'Aoede';

  let capturedUrl = null;
  let capturedBody = null;
  let capturedConfig = null;

  const pcmChunk = Buffer.from([0x00, 0x00, 0xff, 0x7f]);
  const axiosStub = {
    post: async (url, body, config) => {
      capturedUrl = url;
      capturedBody = body;
      capturedConfig = config;
      return {
        data: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      data: pcmChunk.toString('base64'),
                    },
                  },
                ],
              },
            },
          ],
        },
      };
    },
  };

  const { textToSpeech } = loadTtsWithAxiosStub(axiosStub);
  const result = await textToSpeech('Fala com carinho: oi amor');

  assert.equal(capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent');
  assert.equal(capturedConfig.headers['x-goog-api-key'], 'test-key');
  assert.equal(capturedBody.contents[0].parts[0].text, 'Fala com carinho: oi amor');
  assert.deepEqual(capturedBody.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(capturedBody.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
  assert.equal(result.mimeType, 'audio/wav');
  assert.ok(Buffer.isBuffer(result.buffer));
  assert.equal(result.buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(result.buffer.toString('ascii', 8, 12), 'WAVE');
});

test('textToSpeech falha sem GEMINI_API_KEY', async () => {
  delete process.env.GEMINI_API_KEY;

  const { textToSpeech } = loadTtsWithAxiosStub({ post: async () => ({}) });

  await assert.rejects(
    () => textToSpeech('teste'),
    /GEMINI_API_KEY nao configurada/
  );
});
