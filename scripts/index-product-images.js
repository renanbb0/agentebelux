#!/usr/bin/env node
/**
 * index-product-images.js
 *
 * Script de indexação em lote — percorre todo o catálogo WooCommerce
 * e popula a tabela `product_embeddings` no Supabase via Gemini Vision + embeddings.
 *
 * Uso:
 *   node scripts/index-product-images.js              # indexa tudo
 *   node scripts/index-product-images.js --only=123   # só produto 123
 *   node scripts/index-product-images.js --limit=20   # máx 20 produtos (teste)
 *
 * Idempotente (upsert por product_id). Rate-limit de 1s/produto para respeitar Gemini.
 */

require('dotenv').config();
const axios = require('axios');
const imageMatcher = require('../services/image-matcher');
const logger       = require('../services/logger');

const args  = process.argv.slice(2);
const only  = args.find((a) => a.startsWith('--only='))?.split('=')[1];
const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const since = args.find((a) => a.startsWith('--since='))?.split('=')[1];  // ISO date, ex: 2026-04-20T00:00:00

const SLEEP_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wooApi = axios.create({
  baseURL: process.env.WC_BASE_URL?.trim(),
  auth: {
    username: process.env.WC_CONSUMER_KEY?.trim(),
    password: process.env.WC_CONSUMER_SECRET?.trim(),
  },
  timeout: 30_000,
});

/** Normaliza produto WooCommerce para o shape que `indexProduct` espera. */
function normalize(p) {
  const imageUrl = p.images?.[0]?.src || null;
  return {
    id:       p.id,
    name:     p.name,
    price:    p.price || p.regular_price || 0,
    imageUrl,
  };
}

async function fetchOne(id) {
  const { data } = await wooApi.get(`/products/${id}`);
  return normalize(data);
}

async function fetchAll() {
  const all = [];
  let page = 1;
  const perPage = 50;
  while (true) {
    const params = { per_page: perPage, page, status: 'publish' };
    if (since) params.modified_after = since;
    const { data } = await wooApi.get('/products', { params });
    if (!data || data.length === 0) break;
    all.push(...data.map(normalize));
    if (data.length < perPage) break;
    page += 1;
  }
  return all;
}

(async () => {
  console.log('[Indexer] Buscando produtos do WooCommerce...');

  let products;
  if (only) {
    products = [await fetchOne(parseInt(only, 10))];
  } else {
    products = await fetchAll();
  }

  if (limit > 0) products = products.slice(0, limit);

  console.log(`[Indexer] Total a indexar: ${products.length}`);

  let ok = 0;
  let skip = 0;
  let fail = 0;

  for (const [i, p] of products.entries()) {
    const idx = `${i + 1}/${products.length}`;
    if (!p.imageUrl) {
      console.log(`[${idx}] SKIP ${p.id} ${p.name} (sem imagem)`);
      skip += 1;
      continue;
    }
    try {
      await imageMatcher.indexProduct(p);
      console.log(`[${idx}] OK   ${p.id} ${p.name}`);
      ok += 1;
    } catch (err) {
      console.error(`[${idx}] FAIL ${p.id} ${p.name} — ${err.message}`);
      fail += 1;
    }
    await sleep(SLEEP_MS);
  }

  console.log(`\n[Indexer] Done. OK=${ok} SKIP=${skip} FAIL=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  logger.error({ err }, '[Indexer] Erro fatal');
  console.error(err);
  process.exit(1);
});
