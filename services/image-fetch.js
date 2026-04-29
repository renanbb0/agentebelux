const axios = require('axios');
const logger = require('./logger');

const CACHE_MAX = 64;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10min
const DOWNLOAD_TIMEOUT_MS = 15_000;

const cache = new Map(); // url → { data, mimeType, storedAt }

function evictIfNeeded() {
  while (cache.size > CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

function isFresh(entry) {
  return entry && (Date.now() - entry.storedAt) < CACHE_TTL_MS;
}

/**
 * Baixa uma imagem e retorna { data (base64), mimeType }.
 * Cacheia por URL (LRU simples) — a mesma URL baixada 2x no mesmo turno
 * é reaproveitada do cache.
 */
async function fetchImageBase64(imageUrl) {
  if (!imageUrl) throw new Error('fetchImageBase64: imageUrl obrigatório');

  const cached = cache.get(imageUrl);
  if (isFresh(cached)) {
    // re-insere no fim para virar "mais recente" no Map (LRU)
    cache.delete(imageUrl);
    cache.set(imageUrl, cached);
    return { data: cached.data, mimeType: cached.mimeType };
  }

  const res = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: DOWNLOAD_TIMEOUT_MS,
  });
  const mimeType = res.headers['content-type'] || 'image/jpeg';
  const data = Buffer.from(res.data).toString('base64');

  cache.set(imageUrl, { data, mimeType, storedAt: Date.now() });
  evictIfNeeded();

  logger.info(
    { imageUrl, mimeType, sizeKb: Math.round(data.length * 0.75 / 1024) },
    '[IMAGE-FETCH] downloaded'
  );

  return { data, mimeType };
}

/**
 * Baixa N imagens em paralelo, tolerando falhas individuais.
 * Retorna array com a mesma ordem; entradas que falharam vêm como null.
 */
async function fetchImageBase64Batch(imageUrls) {
  return Promise.all(
    imageUrls.map(async (url) => {
      try {
        return await fetchImageBase64(url);
      } catch (err) {
        logger.warn({ url, err: err.message }, '[IMAGE-FETCH] falha no batch');
        return null;
      }
    })
  );
}

module.exports = { fetchImageBase64, fetchImageBase64Batch };
