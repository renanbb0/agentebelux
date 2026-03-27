const { createClient } = require('@supabase/supabase-js');

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
  const { error } = await supabase
    .from('sessions')
    .upsert({
      phone,
      history:          session.history,
      items:            session.items,
      products:         session.products,
      current_product:  session.currentProduct,
      customer_name:    session.customerName,
      current_category: session.currentCategory,
      current_page:     session.currentPage,
      total_pages:      session.totalPages,
      total_products:   session.totalProducts,
      last_activity:    session.lastActivity,
      updated_at:       new Date().toISOString(),
    }, { onConflict: 'phone' });

  if (error) throw error;
}

async function deleteSession(phone) {
  await supabase.from('sessions').delete().eq('phone', phone);
}

async function deleteExpiredSessions(timeoutMs) {
  const cutoff = Date.now() - timeoutMs;
  const { error } = await supabase
    .from('sessions')
    .delete()
    .lt('last_activity', cutoff);
  if (error) console.error('[Supabase] deleteExpiredSessions:', error.message);
}

// ── Learnings ─────────────────────────────────────────────────────────────

async function addLearning(insight) {
  const key = insight.slice(0, 40).toLowerCase();

  // Busca registro com chave similar
  const { data: existing } = await supabase
    .from('learnings')
    .select('id, insight, uses')
    .ilike('insight', `${key}%`)
    .single();

  if (existing) {
    await supabase
      .from('learnings')
      .update({ uses: existing.uses + 1, last_seen: Date.now() })
      .eq('id', existing.id);
  } else {
    await supabase.from('learnings').insert({
      insight,
      uses:      1,
      added_at:  Date.now(),
      last_seen: Date.now(),
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
  deleteSession,
  deleteExpiredSessions,
  // learnings
  addLearning,
  getActiveLearnings,
  // orders
  saveOrder,
};
