'use strict';

const { ElevenLabsClient } = require('elevenlabs');

const API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';
const STABILITY = parseFloat(process.env.ELEVENLABS_STABILITY || '0.5');
const SIMILARITY_BOOST = parseFloat(process.env.ELEVENLABS_SIMILARITY_BOOST || '0.75');
const STYLE = parseFloat(process.env.ELEVENLABS_STYLE || '0');
const SPEED = parseFloat(process.env.ELEVENLABS_SPEED || '1');
const USE_SPEAKER_BOOST = (process.env.ELEVENLABS_USE_SPEAKER_BOOST || 'true') === 'true';

const client = new ElevenLabsClient({
  apiKey: API_KEY,
});

/**
 * Converts text to speech using ElevenLabs TTS API.
 * Returns a Buffer (mp3) and the MIME type for Z-API sendAudio.
 *
 * @param {string} text
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
async function textToSpeech(text) {
  if (!API_KEY) {
    throw new Error('ELEVENLABS_API_KEY nao configurada');
  }

  if (!VOICE_ID) {
    throw new Error('ELEVENLABS_VOICE_ID nao configurada');
  }

  const stream = await client.textToSpeech.convert(VOICE_ID, {
    text,
    model_id:      MODEL_ID,
    output_format: OUTPUT_FORMAT,
    voice_settings: {
      stability: STABILITY,
      similarity_boost: SIMILARITY_BOOST,
      style: STYLE,
      speed: SPEED,
      use_speaker_boost: USE_SPEAKER_BOOST,
    },
  });

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);

  return { buffer, mimeType: 'audio/mpeg' };
}

module.exports = { textToSpeech };
