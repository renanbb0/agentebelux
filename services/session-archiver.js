/**
 * Session Archiver — arquiva sessões que expiram em `session_archives` + JSONL local.
 *
 * Pilha única de classificação de outcome para todo o projeto. Se mudar a regra de
 * "o que é um sucesso", muda aqui e propaga pra todos os consumidores (runtime, extrator, etc.).
 *
 * Outcomes:
 *   - success:   handoffDone=true (order persistida em `orders` via executeHandoff)
 *   - handoff:   support_mode='human_pending' sem handoffDone
 *   - abandoned: items.length>0 AND cartNotified=true AND inativo >2h
 *   - null:      navegando sem carrinho (não arquivar)
 */

const fs = require('fs');
const path = require('path');
const db = require('./supabase');
const logger = require('./logger');

const CART_ABANDON_MS = 2 * 60 * 60 * 1000;
const JSONL_DIR = path.join(process.cwd(), 'training_data');
const JSONL_FILE = path.join(JSONL_DIR, 'events.jsonl');

// ─────────────────────────────────────────────────────────────────────────
// Normalização: converte tanto "memory session" (camelCase) quanto "DB row"
// (snake_case) para um shape canônico usado internamente.
// ─────────────────────────────────────────────────────────────────────────
function normalize(source) {
  // Detecta shape: DB row tem last_activity, memory session tem lastActivity
  const isDbRow = source && Object.prototype.hasOwnProperty.call(source, 'last_activity');

  if (isDbRow) {
    return {
      phone:              source.phone,
      customerName:       source.customer_name || null,
      history:            Array.isArray(source.history) ? source.history : [],
      items:              Array.isArray(source.items) ? source.items : [],
      purchaseFlow:       source.purchase_flow || {},
      conversationMemory: source.conversation_memory || null,
      supportMode:        source.support_mode || null,
      cartNotified:       !!source.cart_notified,
      lastActivity:       typeof source.last_activity === 'number'
        ? source.last_activity
        : Number(source.last_activity) || 0,
      handoffDone:        !!(source.purchase_flow && source.purchase_flow.handoffDone),
    };
  }

  // memory session
  return {
    phone:              source.phone || null, // normalmente não tem phone no objeto
    customerName:       source.customerName || null,
    history:            Array.isArray(source.history) ? source.history : [],
    items:              Array.isArray(source.items) ? source.items : [],
    purchaseFlow:       source.purchaseFlow || {},
    conversationMemory: source.conversationMemory || null,
    supportMode:        source.supportMode || null,
    cartNotified:       !!source.cartNotified,
    lastActivity:       source.lastActivity || 0,
    handoffDone:        !!source.handoffDone,
  };
}

function classifyOutcome(source) {
  const s = normalize(source);
  const now = Date.now();

  if (s.handoffDone === true) return 'success';
  if (s.supportMode === 'human_pending') return 'handoff';
  if (
    Array.isArray(s.items) && s.items.length > 0 &&
    s.cartNotified === true &&
    (now - s.lastActivity) > CART_ABANDON_MS
  ) {
    return 'abandoned';
  }
  return null;
}

function firstHistoryTs(history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const first = history.find(m => typeof m?.ts === 'number');
  return first ? first.ts : null;
}

function lastHistoryTs(history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (typeof history[i]?.ts === 'number') return history[i].ts;
  }
  return null;
}

function computeOrderTotal(items) {
  if (!Array.isArray(items)) return null;
  let total = 0;
  let count = 0;
  for (const it of items) {
    const price = typeof it?.price === 'number'
      ? it.price
      : typeof it?.unitPrice === 'number' ? it.unitPrice : null;
    const qty = typeof it?.quantity === 'number' ? it.quantity : 1;
    if (price !== null) { total += price * qty; count++; }
  }
  return count > 0 ? Number(total.toFixed(2)) : null;
}

function buildArchive(phone, source, outcome) {
  const s = normalize(source);
  const startTs = firstHistoryTs(s.history);
  const endTs   = lastHistoryTs(s.history) || s.lastActivity || Date.now();
  const startedAt = startTs ? new Date(startTs).toISOString() : null;
  const endedAt   = new Date(endTs).toISOString();
  const durationMs = startTs ? (endTs - startTs) : null;

  return {
    phone:                phone || s.phone,
    customer_name:        s.customerName,
    outcome,
    archived_at:          new Date().toISOString(),
    session_started_at:   startedAt,
    session_ended_at:     endedAt,
    duration_ms:          durationMs,
    turn_count:           s.history.length,
    final_fsm_state:      s.purchaseFlow?.state || null,
    items_count:          s.items.length,
    order_total:          outcome === 'success' ? computeOrderTotal(s.items) : null,
    history:              s.history,
    conversation_memory:  s.conversationMemory,
    purchase_flow:        s.purchaseFlow,
    metadata: {
      handoff_done:   s.handoffDone,
      support_mode:   s.supportMode,
      cart_notified:  s.cartNotified,
      last_activity:  s.lastActivity,
    },
  };
}

function appendJsonl(archive) {
  try {
    if (!fs.existsSync(JSONL_DIR)) fs.mkdirSync(JSONL_DIR, { recursive: true });
    fs.appendFileSync(JSONL_FILE, JSON.stringify(archive) + '\n', 'utf8');
  } catch (err) {
    logger.warn({ err: err.message, file: JSONL_FILE }, '[Archiver] Falha ao gravar JSONL');
  }
}

async function archiveSession(phone, session) {
  const outcome = classifyOutcome(session);
  if (!outcome) return { skipped: true, reason: 'no_outcome' };

  const archive = buildArchive(phone, session, outcome);

  // Idempotência: evita duplicar se já foi arquivado antes
  if (archive.session_started_at) {
    const exists = await db.hasArchiveFor(archive.phone, archive.session_started_at);
    if (exists) return { skipped: true, reason: 'already_archived' };
  }

  await db.archiveSession(archive);
  appendJsonl(archive);
  logger.info({ phone, outcome, turns: archive.turn_count }, '[Archiver] Sessão arquivada');
  return { archived: true, outcome };
}

async function archiveSupabaseRow(row) {
  return archiveSession(row.phone, row);
}

module.exports = {
  classifyOutcome,
  buildArchive,
  archiveSession,
  archiveSupabaseRow,
  // constants exported para os scripts batch reusarem:
  CART_ABANDON_MS,
  JSONL_FILE,
};
