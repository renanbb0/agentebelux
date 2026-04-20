const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Sessions ──────────────────────────────────────────────────────────────

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

  const { error } = await supabase
    .from('sessions')
    .upsert({
      phone,
      history:              session.history,
      items:                session.items,
      products:             session.products,
      current_product:      session.currentProduct,
      customer_name:        session.customerName,
      current_category:     session.currentCategory,
      current_page:         session.currentPage,
      total_pages:          session.totalPages,
      total_products:       session.totalProducts,
      last_viewed_product:  session.lastViewedProduct,
      last_viewed_product_index: session.lastViewedProductIndex,
      purchase_flow:        purchaseFlowPayload,
      conversation_memory:  session.conversationMemory || null,
      message_product_map:  session.messageProductMap || {},
      last_activity:        session.lastActivity,
      active_category:      session.activeCategory || null,
      support_mode:         session.supportMode || null,
      cart_notified:        session.cartNotified || false,
      updated_at:           new Date().toISOString(),
    }, { onConflict: 'phone' });

  if (error) throw error;
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
