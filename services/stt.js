'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const logger = require('./logger');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Downloads audio from a URL and returns a Buffer.
 * Z-API provides a temporary audioUrl when an audio message is received.
 * @param {string} audioUrl
 * @returns {Promise<Buffer>}
 */
async function downloadAudio(audioUrl) {
  const response = await axios.get(audioUrl, {
    responseType: 'arraybuffer',
    timeout: 15000,
  });
  return Buffer.from(response.data);
}

/**
 * Transcribes audio using Gemini 2.5 Flash multimodal.
 * Accepts raw audio buffer and sends it as inline data.
 *
 * @param {string} audioUrl - URL of the audio file (from Z-API webhook)
 * @returns {Promise<string|null>} - Transcribed text, or null on failure
 */
async function transcribe(audioUrl) {
  if (!audioUrl) {
    logger.warn('[STT] audioUrl vazio — ignorando');
    return null;
  }

  try {
    const audioBuffer = await downloadAudio(audioUrl);

    if (audioBuffer.length < 500) {
      logger.info({ bytes: audioBuffer.length }, '[STT] Áudio muito curto — ignorando');
      return null;
    }

    const base64Audio = audioBuffer.toString('base64');

    // Detect MIME type from URL or default to ogg (WhatsApp standard)
    let mimeType = 'audio/ogg';
    if (audioUrl.includes('.mp3') || audioUrl.includes('audio/mpeg')) {
      mimeType = 'audio/mpeg';
    } else if (audioUrl.includes('.mp4') || audioUrl.includes('audio/mp4')) {
      mimeType = 'audio/mp4';
    } else if (audioUrl.includes('.wav')) {
      mimeType = 'audio/wav';
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 500,
      },
    });

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType,
          data: base64Audio,
        },
      },
      {
        text: 'Transcreva exatamente o que a pessoa disse neste áudio em português brasileiro. Retorne APENAS a transcrição, sem comentários, sem aspas, sem prefixos como "Transcrição:". Se não conseguir entender o áudio, retorne exatamente a palavra INAUDIVEL.',
      },
    ]);

    const transcription = result.response.text().trim();

    if (!transcription || transcription === 'INAUDIVEL') {
      logger.info('[STT] Áudio inaudível ou vazio');
      return null;
    }

    logger.info({ chars: transcription.length, preview: transcription.substring(0, 80) }, '[STT] Transcrição OK');
    return transcription;
  } catch (err) {
    logger.error({ err: err.message, audioUrl: audioUrl?.substring(0, 80) }, '[STT] Falha na transcrição');
    return null;
  }
}

module.exports = { transcribe };
