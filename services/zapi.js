const axios = require('axios');

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const ZAPI_BASE_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

const zapiClient = axios.create({
  baseURL: ZAPI_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
});

if (ZAPI_CLIENT_TOKEN && ZAPI_CLIENT_TOKEN !== 'seu_client_token') {
  zapiClient.defaults.headers.common['Client-Token'] = ZAPI_CLIENT_TOKEN;
}

async function readMessage(phone, messageId) {
  try {
    await zapiClient.post('/read-message', { phone, messageId });
  } catch (err) {
    console.error('[Z-API readMessage]', err.message);
  }
}

async function sendText(to, message) {
  const typingSeconds = Math.min(Math.max(Math.ceil(message.length / 80), 1), 5);
  const res = await zapiClient.post('/send-text', {
    phone: to,
    message,
    delayTyping: typingSeconds,
  });
  console.log(`[Z-API sendText → ${to}] typing:${typingSeconds}s`, res.data?.zaapId || 'sent');
  return res;
}

async function sendImage(to, imageUrl, caption) {
  const res = await zapiClient.post('/send-image', {
    phone: to,
    image: imageUrl,
    caption,
  });
  console.log(`[Z-API sendImage → ${to}]`, res.data?.zaapId || 'sent');
  return res;
}

async function sendAudio(to, audioBuffer, mimeType = 'audio/mp3') {
  const base64 = audioBuffer.toString('base64');
  const dataUri = `data:${mimeType};base64,${base64}`;
  const res = await zapiClient.post('/send-audio', {
    phone: to,
    audio: dataUri,
  });
  console.log(`[Z-API sendAudio → ${to}]`, res.data?.zaapId || 'sent');
  return res;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { readMessage, sendText, sendImage, sendAudio, delay };
