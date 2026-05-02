const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Sessions ──────────────────────────────────────────────────────────────

// Sanitiza valores destinados a colunas JSONB:
// - undefined / NaN / Infinity → fallback (Postgres rejeita esses tipos)
// - round-trip JSON.parse(JSON.stringify(...)) elimina undefined aninhado e
//   valida serializabilidade (lança em referências circulares)
// - empty string em coluna JSONB dispara "Empty or invalid json" no Postgres
function sanitizeJsonField(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (value === '') return fallback;
  if (typeof value === 'number' && !Number.isFinite(value)) return fallback;
  try {
    const round = JSON.parse(JSON.stringify(value));
    // round-trip pode retornar undefined se value for puro undefined aninhado
    if (round === undefined || round === null) return fallback;
    if (round === '') return fallback;
    return round;
  } catch {
    return fallback;
  }
}

async function getSession(phone) {
  const { data } = await supabase
    .from('sessions')
    .select('*')
    .eq('phone', phone)
    .single();
  return data || null;
}

async function upsertSession(phone, session) {
  const purchaseFlowPayload = {
    ...session.purchaseFlow,
    handoffDone: session.handoffDone,
    // contextMemory removido de purchase_flow — agora em coluna própria (P1.6)
  };

  const payload = {
    phone,
    history:              sanitizeJsonField(session.history, []),
    items:                sanitizeJsonField(session.items, []),
    products:             sanitizeJsonField(session.products, []),
    current_product:      sanitizeJsonField(session.currentProduct, null),
    customer_name:        session.customerName ?? null,
    current_category:     session.currentCategory ?? null,
    current_page:         session.currentPage ?? 0,
    total_pages:          session.totalPages ?? 1,
    total_products:       session.totalProducts ?? 0,
    last_viewed_product:  sanitizeJsonField(session.lastViewedProduct, null),
    last_viewed_product_index: session.lastViewedProductIndex ?? null,
    purchase_flow:        sanitizeJsonField(purchaseFlowPayload, {}),
    conversation_memory:  sanitizeJsonField(session.conversationMemory, null),
    message_product_map:  sanitizeJsonField(session.messageProductMap, {}),
    last_activity:        session.lastActivity ?? Date.now(),
    active_category:      session.activeCategory ?? null,
    support_mode:         session.supportMode ?? null,
    cart_notified:        Boolean(session.cartNotified),
    updated_at:           new Date().toISOString(),
  };

  const { error } = await supabase
    .from('sessions')
    .upsert(payload, { onConflict: 'phone' });

  if (error) {
    // Anexa contexto do Supabase (code/details/hint) para diagnóstico.
    const detailedErr = new Error(
      `[upsertSession] ${error.message}` +
      (error.code    ? ` | code=${error.code}`       : '') +
      (error.details ? ` | details=${error.details}` : '') +
      (error.hint    ? ` | hint=${error.hint}`       : '')
    );
    detailedErr.cause = error;
    throw detailedErr;
  }
}

async function clearAllSessions() {
  const { error } = await supabase
    .from('sessions')
    .delete()
    .neq('phone', '');
  if (error) throw error;
}

async function deleteExpiredSessions(timeoutMs) {
  // last_activity é bigint (Date.now()). Passar número cru, não ISO string.
  const cutoff = Date.now() - timeoutMs;
  const { error } = await supabase
    .from('sessions')
    .delete()
    .lt('last_activity', cutoff);
  if (error) {
    const logger = require('./logger');
    logger.error({ err: error.message }, '[Supabase] deleteExpiredSessions');
  }
}

async function getExpiredSessions(timeoutMs) {
  const cutoff = Date.now() - timeoutMs;
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .lt('last_activity', cutoff);
  if (error) {
    const logger = require('./logger');
    logger.error({ err: error.message }, '[Supabase] getExpiredSessions');
    return [];
  }
  return data || [];
}

async function archiveSession(archive) {
  const { error } = await supabase.from('session_archives').insert(archive);
  if (error) throw error;
}

async function hasArchiveFor(phone, sessionStartedAtIso) {
  const { data, error } = await supabase
    .from('session_archives')
    .select('id')
    .eq('phone', phone)
    .eq('session_started_at', sessionStartedAtIso)
    .limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

// ── Learnings ─────────────────────────────────────────────────────────────

async function addLearning(insight) {
  const insightHash = crypto.createHash('sha256').update(insight).digest('hex').slice(0, 16);

  const { data: existing } = await supabase
    .from('learnings')
    .select('id, uses')
    .eq('insight_hash', insightHash)
    .single();

  if (existing) {
    await supabase
      .from('learnings')
      .update({ uses: existing.uses + 1, last_seen: Date.now() })
      .eq('id', existing.id);
  } else {
    await supabase.from('learnings').insert({
      insight,
      insight_hash: insightHash,
      uses:         1,
      added_at:     Date.now(),
      last_seen:    Date.now(),
    });
  }
}

async function getActiveLearnings(limit = 10) {
  const { data } = await supabase
    .from('learnings')
    .select('insight')
    .order('uses',      { ascending: false })
    .order('last_seen', { ascending: false })
    .limit(limit);

  return (data || []).map(l => l.insight);
}

// ── Orders ────────────────────────────────────────────────────────────────

async function saveOrder({ phone, customerName, items, total }) {
  const { error } = await supabase.from('orders').insert({
    phone,
    customer_name: customerName,
    items,
    total,
    status: 'pending',
  });
  if (error) throw error;
}

module.exports = {
  supabase,
  // sessions
  getSession,
  upsertSession,
  clearAllSessions,
  deleteExpiredSessions,
  getExpiredSessions,
  // archives
  archiveSession,
  hasArchiveFor,
  // learnings
  addLearning,
  getActiveLearnings,
  // orders
  saveOrder,
};
