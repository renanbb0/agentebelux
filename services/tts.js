'use strict';

const axios = require('axios');
const logger = require('./logger');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TTS_MODEL = process.env.TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const TTS_VOICE = process.env.TTS_VOICE || 'Aoede';
const TTS_SAMPLE_RATE = 24000;

// Debug: log TTS config at startup
logger.info({
  ttsEnabled: !!GEMINI_API_KEY,
  model: TTS_MODEL,
  voice: TTS_VOICE
}, '[TTS] Config carregada');

const TTS_PERSONA = `Você é a Bela, consultora calorosa e animada da Belux Moda Íntima.
Fale em português brasileiro com tom alegre, próximo e encorajador — como uma vendedora humana experiente que quer genuinamente ajudar.
Use entonação natural com pausas leves entre frases e uma pausa ligeiramente mais longa entre tópicos diferentes.
Ao mencionar valores monetários, fale por extenso: "cento e cinquenta reais" em vez de "R$ 150".
Ao dar instruções em lista, use entonação que sugira sequência: "primeiro... segundo... terceiro...".
Nunca leia símbolos de formatação: asteriscos, underlines, emojis ou hashtags.
Varie a entonação para soar expressiva e humana. Nunca soe robótica ou monocórdio.`;
const TTS_CHANNELS = 1;
const TTS_SAMPLE_WIDTH = 2;

function buildWaveHeader(dataLength, sampleRate = TTS_SAMPLE_RATE, channels = TTS_CHANNELS, sampleWidth = TTS_SAMPLE_WIDTH) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * sampleWidth;
  const blockAlign = channels * sampleWidth;

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(sampleWidth * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);

  return header;
}

function pcmToWave(pcmBuffer) {
  return Buffer.concat([buildWaveHeader(pcmBuffer.length), pcmBuffer]);
}

function getInlineAudioData(payload) {
  return payload?.candidates?.[0]?.content?.parts?.find((part) => part?.inlineData?.data)?.inlineData?.data || null;
}

/**
 * Converts text to speech using Gemini TTS REST API.
 * Returns a WAV buffer and the MIME type for Z-API sendAudio.
 *
 * @param {string} text
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
async function textToSpeech(text) {
  if (!GEMINI_API_KEY) {
    const err = 'GEMINI_API_KEY nao configurada';
    logger.error({}, `[textToSpeech] ${err}`);
    throw new Error(err);
  }

  if (!text || !text.trim()) {
    const err = 'Texto para TTS nao pode ser vazio';
    logger.error({}, `[textToSpeech] ${err}`);
    throw new Error(err);
  }

  logger.info({ textLength: text.length }, '[textToSpeech] Iniciando síntese');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`;
  logger.debug({ endpoint }, '[textToSpeech] Chamando API Gemini TTS');

  const body = {
    contents: [{
      parts: [{ text }],
    }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: TTS_VOICE,
          },
        },
      },
    },
    model: TTS_MODEL,
  };

  let response;
  try {
    response = await axios.post(endpoint, body, {
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      timeout: 90000, // 90s — textos longos (~700 chars) podem levar mais de 30s
    });
    logger.info({ statusCode: response.status }, '[textToSpeech] Resposta recebida da API Gemini');
  } catch (axiosErr) {
    logger.error({
      status: axiosErr.response?.status,
      statusText: axiosErr.response?.statusText,
      message: axiosErr.message
    }, '[textToSpeech] Erro na chamada axios');
    throw axiosErr;
  }

  const inlineAudio = getInlineAudioData(response.data);
  if (!inlineAudio) {
    logger.error({ candidates: response.data.candidates?.length }, '[textToSpeech] Nenhum audio inline na resposta');
    throw new Error('Gemini TTS nao retornou audio inline');
  }

  logger.info({}, '[textToSpeech] Audio inline encontrado, convertendo PCM para WAV');
  const pcmBuffer = Buffer.from(inlineAudio, 'base64');
  logger.info({ pcmLength: pcmBuffer.length }, '[textToSpeech] Buffer WAV criado');

  return {
    buffer: pcmToWave(pcmBuffer),
    mimeType: 'audio/wav',
  };
}

module.exports = {
  textToSpeech,
  __private: {
    buildWaveHeader,
    pcmToWave,
    getInlineAudioData,
  },
};
