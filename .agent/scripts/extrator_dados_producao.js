/**
 * Extrator de Dados de Produção — Agente Belux
 *
 * Gera um relatório Markdown consolidado com o que aconteceu no período:
 *   - Resumo executivo
 *   - Handoffs (conversas que pediram humano)
 *   - Abandonos de carrinho (FSM travada)
 *   - Vendas concluídas (tabela `orders`)
 *   - Aprendizados registrados (tabela `learnings`)
 *   - Conversas "neutras" (ativas no período, sem handoff nem abandono)
 *
 * READ-ONLY: não altera nenhum dado.
 *
 * Uso:
 *   node .agent/scripts/extrator_dados_producao.js
 *   node .agent/scripts/extrator_dados_producao.js --hours=24 --full-history
 *   node .agent/scripts/extrator_dados_producao.js --hours=168 --out=./semana.md
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ── CLI ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const HOURS = parseFloat(getArg('hours', '12'));
const FULL_HISTORY = hasFlag('full-history');
const OUT_PATH = getArg('out', './relatório_producao_hoje.md');
const TAIL_HANDOFF = parseInt(getArg('tail-handoff', '8'), 10);
const TAIL_ABANDON = parseInt(getArg('tail-abandon', '5'), 10);
const ARCHIVE_EXISTING = hasFlag('archive-existing');

// Archiver opcional — só carrega se for usar (evita require desnecessário)
const archiver = ARCHIVE_EXISTING ? require('../../services/session-archiver') : null;

// ── Supabase client ──────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Erro: SUPABASE_URL ou SUPABASE_ANON_KEY não definidos no .env');
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ── Helpers ──────────────────────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }
function fmtDateTime(input) {
  if (!input) return 'N/A';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return 'N/A';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtTime(input) {
  if (!input) return '--:--';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function escapeMd(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/\r/g, '').replace(/\n/g, '  \n> ');
}
function roleLabel(role) {
  return role === 'user' ? '👤 Cliente' : '🤖 Bela';
}
function renderHistory(history, limit) {
  if (!Array.isArray(history) || history.length === 0) {
    return '> _(sem histórico)_\n';
  }
  const slice = (limit && limit > 0) ? history.slice(-limit) : history;
  return slice.map(msg => {
    const t = msg.ts ? fmtTime(msg.ts) : '--:--';
    return `> **[${t}] ${roleLabel(msg.role)}**: ${escapeMd(msg.content)}`;
  }).join('\n') + '\n';
}

// ── Extração ─────────────────────────────────────────────────────────────
async function extrair() {
  const cutoffMs = Date.now() - HOURS * 60 * 60 * 1000;
  const cutoffISO = new Date(cutoffMs).toISOString();

  console.log(`[extrator] Janela: últimas ${HOURS}h (desde ${fmtDateTime(cutoffISO)})`);
  console.log(`[extrator] Saída: ${OUT_PATH}`);

  // Sessões ativas no período
  const { data: sessoes, error: errSess } = await supabase
    .from('sessions')
    .select('*')
    .gte('updated_at', cutoffISO);
  if (errSess) {
    console.error('Erro ao consultar sessions:', errSess.message);
    process.exit(1);
  }

  // Orders no período (pode não ter created_at em schemas antigos — fallback)
  let orders = [];
  {
    const res = await supabase
      .from('orders')
      .select('*')
      .gte('created_at', cutoffISO)
      .order('created_at', { ascending: true });
    if (res.error) {
      console.warn('[extrator] orders indisponível ou sem created_at:', res.error.message);
      const fallback = await supabase.from('orders').select('*').limit(200);
      orders = fallback.data || [];
    } else {
      orders = res.data || [];
    }
  }

  // Learnings no período
  let learnings = [];
  {
    const res = await supabase
      .from('learnings')
      .select('*')
      .gte('added_at', cutoffMs)
      .order('added_at', { ascending: true });
    if (res.error) {
      console.warn('[extrator] learnings indisponível:', res.error.message);
    } else {
      learnings = res.data || [];
    }
  }

  // ── Filtragem ──
  const handoffs = sessoes.filter(s =>
    s?.purchase_flow?.handoffDone === true || s?.support_mode != null
  );
  const abandonos = sessoes.filter(s => {
    if (!Array.isArray(s?.items) || s.items.length === 0) return false;
    if (s?.purchase_flow?.handoffDone === true) return false; // já está em handoffs
    const la = s?.last_activity ? new Date(s.last_activity).getTime() : 0;
    return (Date.now() - la) > 30 * 60 * 1000;
  });
  const handoffPhones = new Set(handoffs.map(s => s.phone));
  const abandonoPhones = new Set(abandonos.map(s => s.phone));
  const neutras = sessoes.filter(s =>
    !handoffPhones.has(s.phone) && !abandonoPhones.has(s.phone)
  );

  // ── Relatório ──
  const header = [
    `# 📊 Relatório de Produção — Agente Belux`,
    ``,
    `**Gerado em:** ${fmtDateTime(new Date())}  `,
    `**Janela:** últimas ${HOURS}h (desde ${fmtDateTime(cutoffISO)})  `,
    `**Flags:** ${FULL_HISTORY ? '`--full-history`' : 'histórico truncado'}`,
    ``,
    `## 📈 Resumo executivo`,
    ``,
    `| Métrica | Valor |`,
    `|---------|-------|`,
    `| Sessões ativas no período | **${sessoes.length}** |`,
    `| Handoffs (humano solicitado) | **${handoffs.length}** |`,
    `| Abandonos de carrinho (>30min) | **${abandonos.length}** |`,
    `| Vendas concluídas (orders) | **${orders.length}** |`,
    `| Aprendizados novos (learnings) | **${learnings.length}** |`,
    `| Conversas neutras / em andamento | **${neutras.length}** |`,
    ``,
    `---`,
    ``,
  ].join('\n');

  let relatorio = header;

  // ── 1. HANDOFFS ──
  relatorio += `## 🙋‍♀️ 1. Handoffs — ${handoffs.length} ocorrência(s)\n\n`;
  if (handoffs.length === 0) {
    relatorio += `_Sem pedidos para falar com a atendente no período._\n\n`;
  } else {
    handoffs.forEach(h => {
      relatorio += `### 📱 ${h.phone}${h.customer_name ? ` — ${h.customer_name}` : ''}\n\n`;
      relatorio += `- **Estágio FSM:** \`${h?.purchase_flow?.state || 'n/a'}\`\n`;
      relatorio += `- **support_mode:** \`${h.support_mode || 'n/a'}\`\n`;
      relatorio += `- **handoffDone:** ${h?.purchase_flow?.handoffDone ? 'true' : 'false'}\n`;
      relatorio += `- **Última atividade:** ${fmtDateTime(h.last_activity)}\n\n`;
      relatorio += `**Conversa${FULL_HISTORY ? ' (completa)' : ` (últimas ${TAIL_HANDOFF})`}:**\n\n`;
      relatorio += renderHistory(h.history, FULL_HISTORY ? null : TAIL_HANDOFF);
      relatorio += `\n---\n\n`;
    });
  }

  // ── 2. ABANDONOS ──
  relatorio += `## 🛒 2. Abandonos de carrinho — ${abandonos.length} ocorrência(s)\n\n`;
  if (abandonos.length === 0) {
    relatorio += `_Ninguém com carrinho parado no período._\n\n`;
  } else {
    abandonos.forEach(a => {
      relatorio += `### 📱 ${a.phone}${a.customer_name ? ` — ${a.customer_name}` : ''}\n\n`;
      relatorio += `- **Estágio FSM:** \`${a?.purchase_flow?.state || 'n/a'}\`\n`;
      relatorio += `- **Último produto:** ${a?.purchase_flow?.productName || 'n/a'}\n`;
      relatorio += `- **Itens no carrinho:** ${a?.items?.length || 0}\n`;
      relatorio += `- **Última atividade:** ${fmtDateTime(a.last_activity)}\n\n`;
      relatorio += `**Últimas mensagens${FULL_HISTORY ? ' (completo)' : ` (${TAIL_ABANDON})`}:**\n\n`;
      relatorio += renderHistory(a.history, FULL_HISTORY ? null : TAIL_ABANDON);
      relatorio += `\n---\n\n`;
    });
  }

  // ── 3. VENDAS ──
  relatorio += `## 💰 3. Vendas concluídas — ${orders.length} pedido(s)\n\n`;
  if (orders.length === 0) {
    relatorio += `_Nenhum pedido salvo no período._\n\n`;
  } else {
    relatorio += `| Data | Cliente | Telefone | Itens | Total | Status |\n`;
    relatorio += `|------|---------|----------|-------|-------|--------|\n`;
    orders.forEach(o => {
      const data = fmtDateTime(o.created_at || o.createdAt);
      const nome = o.customer_name || o.customerName || '-';
      const qtd = Array.isArray(o.items) ? o.items.length : 0;
      const total = typeof o.total === 'number' ? `R$ ${o.total.toFixed(2)}` : (o.total || '-');
      relatorio += `| ${data} | ${nome} | ${o.phone || '-'} | ${qtd} | ${total} | ${o.status || '-'} |\n`;
    });
    relatorio += `\n`;
  }

  // ── 4. APRENDIZADOS ──
  relatorio += `## 🧠 4. Aprendizados registrados — ${learnings.length}\n\n`;
  if (learnings.length === 0) {
    relatorio += `_Nenhum insight novo adicionado à base._\n\n`;
  } else {
    learnings.forEach(l => {
      const addedAt = l.added_at ? fmtDateTime(new Date(l.added_at)) : '?';
      relatorio += `- **[${addedAt}]** ${escapeMd(l.insight)}  _(uses=${l.uses || 1})_\n`;
    });
    relatorio += `\n`;
  }

  // ── 5. NEUTRAS ──
  relatorio += `## 🟢 5. Conversas neutras / em andamento — ${neutras.length}\n\n`;
  relatorio += `_Sessões ativas no período sem handoff nem abandono. Potenciais bons exemplos para treino positivo._\n\n`;
  if (neutras.length > 0) {
    relatorio += `| Telefone | Cliente | Estágio FSM | Itens | Última atividade |\n`;
    relatorio += `|----------|---------|-------------|-------|------------------|\n`;
    neutras.forEach(n => {
      relatorio += `| ${n.phone} | ${n.customer_name || '-'} | \`${n?.purchase_flow?.state || 'n/a'}\` | ${n?.items?.length || 0} | ${fmtDateTime(n.last_activity)} |\n`;
    });
    relatorio += `\n`;

    if (FULL_HISTORY) {
      relatorio += `### Histórico completo das conversas neutras\n\n`;
      neutras.forEach(n => {
        relatorio += `#### 📱 ${n.phone}${n.customer_name ? ` — ${n.customer_name}` : ''}\n\n`;
        relatorio += renderHistory(n.history, null);
        relatorio += `\n---\n\n`;
      });
    }
  }

  // ── 6. ERROS (via arquivo de log opcional) ──
  const logPath = path.join(process.cwd(), 'logs', 'agent.log');
  relatorio += `## 🔥 6. Erros capturados\n\n`;
  if (fs.existsSync(logPath)) {
    try {
      const raw = fs.readFileSync(logPath, 'utf8');
      const lines = raw.split(/\r?\n/).filter(l => /ERROR|error|err\s/i.test(l));
      const recent = lines.slice(-100);
      if (recent.length === 0) {
        relatorio += `_Sem linhas de erro recentes em \`logs/agent.log\`._\n\n`;
      } else {
        relatorio += `Últimas ${recent.length} linhas de erro em \`logs/agent.log\`:\n\n`;
        relatorio += '```log\n' + recent.join('\n') + '\n```\n\n';
      }
    } catch (e) {
      relatorio += `_Erro ao ler \`logs/agent.log\`: ${e.message}_\n\n`;
    }
  } else {
    relatorio += `_Arquivo \`logs/agent.log\` não encontrado. Para capturar erros em disco, rode o Agente com \`node index.js 2>&1 | Tee-Object -FilePath logs/agent.log\` (PowerShell) ou \`node index.js 2>&1 | tee logs/agent.log\` (bash)._\n\n`;
  }

  // ── 7. ARQUIVAMENTO OPCIONAL (rede de segurança) ──
  let archiveStats = null;
  if (ARCHIVE_EXISTING && archiver) {
    console.log('[extrator] Flag --archive-existing: arquivando sessões classificáveis...');
    const stats = { archived: 0, skipped: 0, failed: 0, byOutcome: {} };
    for (const s of sessoes) {
      try {
        const r = await archiver.archiveSupabaseRow(s);
        if (r?.archived) {
          stats.archived++;
          stats.byOutcome[r.outcome] = (stats.byOutcome[r.outcome] || 0) + 1;
        } else {
          stats.skipped++;
        }
      } catch (err) {
        stats.failed++;
        console.warn(`[extrator]   arquivo falhou phone=${s.phone}: ${err.message}`);
      }
    }
    archiveStats = stats;
    relatorio += `## 📦 7. Arquivamento (--archive-existing)\n\n`;
    relatorio += `- Arquivadas: **${stats.archived}** ${JSON.stringify(stats.byOutcome)}\n`;
    relatorio += `- Puladas (sem outcome classificável ou já arquivadas): ${stats.skipped}\n`;
    relatorio += `- Falhas: ${stats.failed}\n\n`;
  }

  // ── Grava ──
  fs.writeFileSync(OUT_PATH, relatorio, 'utf8');
  console.log(`[extrator] ✅ Relatório gravado em: ${OUT_PATH}`);
  console.log(`[extrator] Resumo: ${sessoes.length} sessões / ${handoffs.length} handoffs / ${abandonos.length} abandonos / ${orders.length} vendas / ${learnings.length} learnings.`);
  if (archiveStats) {
    console.log(`[extrator] Arquivamento: ${archiveStats.archived} arquivadas, ${archiveStats.skipped} puladas, ${archiveStats.failed} falhas.`);
  }
}

extrair().catch(err => {
  console.error('[extrator] Falha:', err);
  process.exit(1);
});
