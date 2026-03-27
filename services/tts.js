const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TTS_MODEL = 'gemini-2.5-pro-preview-tts';
const TTS_VOICE = process.env.TTS_VOICE || 'Aoede'; // Aoede = voz quente e expressiva, ideal para a Bela

/**
 * Converts text to speech using Gemini 2.5 Pro TTS.
 * Returns { buffer: Buffer, mimeType: string } or throws on failure.
 */
async function textToSpeech(text) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY não configurada');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const response = await axios.post(url, {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: TTS_VOICE },
        },
      },
    },
  }, { timeout: 30000 });

  const inlineData = response.data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;

  if (!inlineData?.data) {
    throw new Error('Gemini TTS não retornou dados de áudio');
  }

  return {
    buffer: Buffer.from(inlineData.data, 'base64'),
    mimeType: inlineData.mimeType || 'audio/mp3',
  };
}

module.exports = { textToSpeech };
