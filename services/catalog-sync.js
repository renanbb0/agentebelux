/**
 * catalog-sync.js — Sincronizador automático do catálogo WooCommerce → Supabase.
 *
 * Três mecanismos trabalhando juntos:
 *   1. BOOT SYNC          → 30s após o servidor subir, roda um incremental para
 *                            capturar o que ficou fora do ar durante o downtime.
 *   2. INCREMENTAL (1h)   → pull do WooCommerce filtrando por `modified_after`
 *                            (só produtos alterados desde a última indexação).
 *   3. RECONCILIAÇÃO (24h)→ compara IDs do Woo com IDs do Supabase e remove
 *                            órfãos (produtos deletados/despublicados).
 *
 * Opcionalmente aceita eventos via webhook (`handleWebhook`) para sync em
 * tempo real sem esperar o ciclo de 1h.
 *
 * Rate-limit: 1s entre produtos para não estourar cota do Gemini.
 * Idempotente: `indexProduct` usa upsert; múltiplos ciclos não causam dano.
 */

const axios          = require('axios');
const { createClient } = require('@supabase/supabase-js');
const imageMatcher   = require('./image-matcher');
const logger         = require('./logger');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const wooApi = axios.create({
  baseURL: process.env.WC_BASE_URL?.trim(),
  auth: {
    username: process.env.WC_CONSUMER_KEY?.trim(),
    password: process.env.WC_CONSUMER_SECRET?.trim(),
  },
  timeout: 30_000,
});

const BOOT_DELAY_MS          = 30_000;            // 30s
const INCREMENTAL_INTERVAL_MS = 60 * 60 * 1000;   // 1h
const RECONCILE_INTERVAL_MS   = 24 * 60 * 60 * 1000; // 24h
const PRODUCT_RATE_LIMIT_MS   = 1000;             // 1s por produto (Gemini)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normaliza produto WooCommerce para o shape que indexProduct espera. */
function normalizeProduct(p) {
  return {
    id:       p.id,
    name:     p.name,
    price:    p.price || p.regular_price || 0,
    imageUrl: p.images?.[0]?.src || null,
  };
}

/**
 * Descobre a data do último produto indexado (timestamp do produto mais recente).
 * Retorna null se a tabela está vazia (primeira execução).
 */
async function getLastSyncAt() {
  const { data, error } = await supabase
    .from('product_embeddings')
    .select('updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn({ err: error.message }, '[CatalogSync] Falha ao ler lastSyncAt');
    return null;
  }
  return data?.updated_at || null;
}

/**
 * Conta produtos publicados no WooCommerce (só olha o header x-wp-total).
 */
async function getWooTotalProducts() {
  try {
    const { headers } = await wooApi.get('/products', {
      params: { per_page: 1, status: 'publish', _fields: 'id' },
    });
    return parseInt(headers['x-wp-total'] || '0', 10);
  } catch (err) {
    logger.warn({ err: err.message }, '[CatalogSync] Falha ao contar produtos Woo');
    return null;
  }
}

/**
 * Sincronização incremental: busca produtos modificados desde a última indexação
 * e reindexa (upsert). Primeira execução (tabela vazia) baixa tudo.
 *
 * Proteção contra bootstrap gap: se o Supabase tem significativamente menos
 * produtos que o Woo (diff > 5% ou tabela vazia), força sync completo para
 * popular o que ficou faltando. Steady-state é rápido (poucos produtos/hora).
 */
async function syncIncremental({ force = false } = {}) {
  let lastSyncAt = force ? null : await getLastSyncAt();

  // Detecta bootstrap incompleto: compara contagens Woo vs Supabase
  if (!force && lastSyncAt) {
    const wooTotal = await getWooTotalProducts();
    let indexedTotal = 0;
    try {
      indexedTotal = (await imageMatcher.listIndexedIds()).length;
    } catch (_) { /* tolera */ }

    if (wooTotal !== null && indexedTotal < wooTotal * 0.95) {
      logger.warn(
        { wooTotal, indexedTotal },
        '[CatalogSync] Bootstrap incompleto detectado — forçando sync completo',
      );
      lastSyncAt = null;
    }
  }

  logger.info({ lastSyncAt }, '[CatalogSync] Iniciando sync incremental');

  let page = 1;
  let indexed = 0;
  let failed = 0;
  let skipped = 0;

  while (true) {
    const params = { per_page: 50, page, status: 'publish' };
    if (lastSyncAt) params.modified_after = lastSyncAt;

    let batch;
    try {
      const { data } = await wooApi.get('/products', { params });
      batch = data || [];
    } catch (err) {
      logger.error({ err: err.message, page }, '[CatalogSync] Falha ao buscar produtos do Woo');
      break;
    }
    if (batch.length === 0) break;

    for (const raw of batch) {
      const p = normalizeProduct(raw);
      if (!p.imageUrl) { skipped++; continue; }
      try {
        await imageMatcher.indexProduct(p);
        indexed++;
      } catch (err) {
        failed++;
        logger.warn({ productId: p.id, err: err.message }, '[CatalogSync] Falha ao indexar');
      }
      await sleep(PRODUCT_RATE_LIMIT_MS);
    }

    if (batch.length < 50) break;
    page++;
  }

  logger.info({ indexed, skipped, failed, since: lastSyncAt }, '[CatalogSync] Sync incremental concluído');
  return { indexed, skipped, failed, since: lastSyncAt };
}

/**
 * Reconciliação: busca todos os IDs do WooCommerce e remove do Supabase
 * qualquer ID que não exista mais (deletado ou despublicado).
 */
async function reconcileDeletions() {
  logger.info('[CatalogSync] Iniciando reconciliação de deleções');

  // 1) IDs atuais no WooCommerce (só o campo id, bem leve)
  const wcIds = new Set();
  let page = 1;
  while (true) {
    let batch;
    try {
      const { data } = await wooApi.get('/products', {
        params: { per_page: 100, page, status: 'publish', _fields: 'id' },
      });
      batch = data || [];
    } catch (err) {
      logger.error({ err: err.message }, '[CatalogSync] Falha ao listar IDs do Woo');
      return { error: err.message };
    }
    if (batch.length === 0) break;
    batch.forEach((p) => wcIds.add(p.id));
    if (batch.length < 100) break;
    page++;
  }

  // 2) IDs indexados no Supabase
  let indexedIds;
  try {
    indexedIds = await imageMatcher.listIndexedIds();
  } catch (err) {
    logger.error({ err: err.message }, '[CatalogSync] Falha ao listar IDs do Supabase');
    return { error: err.message };
  }

  // 3) Diferença: órfãos
  const orphans = indexedIds.filter((id) => !wcIds.has(id));
  if (orphans.length > 0) {
    try {
      const { error } = await supabase
        .from('product_embeddings')
        .delete()
        .in('product_id', orphans);
      if (error) throw error;
    } catch (err) {
      logger.error({ err: err.message }, '[CatalogSync] Falha ao remover órfãos');
      return { error: err.message };
    }
  }

  logger.info(
    { wcTotal: wcIds.size, indexedTotal: indexedIds.length, orphansRemoved: orphans.length },
    '[CatalogSync] Reconciliação concluída',
  );
  return { wcTotal: wcIds.size, indexedTotal: indexedIds.length, orphansRemoved: orphans.length };
}

/**
 * Handler opcional para webhook WooCommerce.
 * Eventos: product.created, product.updated, product.deleted, product.restored.
 * Retorna ação tomada (útil para logs).
 */
async function handleWebhook({ event, product }) {
  if (!event || !product?.id) {
    return { skipped: true, reason: 'payload inválido' };
  }

  if (event === 'deleted' || product.status === 'trash') {
    await imageMatcher.removeProduct(product.id);
    logger.info({ productId: product.id }, '[CatalogSync/Webhook] Produto removido');
    return { action: 'removed', productId: product.id };
  }

  // created / updated / restored — (re)indexa
  const normalized = normalizeProduct(product);
  if (!normalized.imageUrl) {
    return { action: 'skipped', reason: 'sem imagem', productId: product.id };
  }
  // Dispara async para responder ao webhook rapidamente (não bloqueia o Woo)
  imageMatcher.indexProduct(normalized)
    .then(() => logger.info({ productId: product.id, event }, '[CatalogSync/Webhook] Produto indexado'))
    .catch((err) => logger.error({ productId: product.id, err: err.message }, '[CatalogSync/Webhook] Falha ao indexar'));
  return { action: 'indexing', productId: product.id };
}

// -------- Agendadores --------
let incrementalTimer = null;
let reconcileTimer   = null;
let bootTimeout      = null;

function start() {
  // Boot sync (30s após start — deixa warmup terminar)
  bootTimeout = setTimeout(() => {
    syncIncremental().catch((err) => logger.error({ err: err.message }, '[CatalogSync] Boot sync falhou'));
  }, BOOT_DELAY_MS);

  // Incremental a cada 1h
  incrementalTimer = setInterval(() => {
    syncIncremental().catch((err) => logger.error({ err: err.message }, '[CatalogSync] Sync periódico falhou'));
  }, INCREMENTAL_INTERVAL_MS);

  // Reconciliação a cada 24h
  reconcileTimer = setInterval(() => {
    reconcileDeletions().catch((err) => logger.error({ err: err.message }, '[CatalogSync] Reconciliação falhou'));
  }, RECONCILE_INTERVAL_MS);

  logger.info(
    { boot_in_ms: BOOT_DELAY_MS, incremental_h: 1, reconcile_h: 24 },
    '[CatalogSync] Agendadores iniciados',
  );
}

function stop() {
  if (bootTimeout)     clearTimeout(bootTimeout);
  if (incrementalTimer) clearInterval(incrementalTimer);
  if (reconcileTimer)   clearInterval(reconcileTimer);
  bootTimeout = incrementalTimer = reconcileTimer = null;
}

module.exports = {
  start,
  stop,
  syncIncremental,
  reconcileDeletions,
  handleWebhook,
};
