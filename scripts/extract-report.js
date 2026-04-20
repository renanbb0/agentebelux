/**
 * Extract Report — Pipeline offline de análise de logs do Agente Belux
 *
 * Pipeline:
 *   logs/belux-*.log  →  parsed-events.jsonl  →  sessions.jsonl  →  RELATORIO_PRODUCAO.md
 *
 * Uso:
 *   node scripts/extract-report.js
 *
 * Não toca no bot. Roda offline.
 */

const fs   = require('fs');
const path = require('path');

const ROOT       = path.resolve(__dirname, '..');
const LOGS_DIR   = path.join(ROOT, 'logs');
const OUT_DIR    = path.join(LOGS_DIR, 'parsed');
const EVENTS_OUT = path.join(OUT_DIR, 'parsed-events.jsonl');
const SESS_OUT   = path.join(OUT_DIR, 'sessions.jsonl');
const REPORT_OUT = path.join(ROOT, 'RELATORIO_PRODUCAO.md');

const SESSION_GAP_MS = 30 * 60 * 1000; // 30min de inatividade encerra sessão

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// 1) PARSER de log pino-pretty → JSONL
// ─────────────────────────────────────────────────────────────────────────────

const ANSI_RE  = /\x1b\[[0-9;]*m/g;
const HEAD_RE  = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\]\s+(INFO|ERROR|WARN|DEBUG|FATAL|TRACE)\s+\((\d+)\):\s+(.+?)\s*$/;

function stripAnsi(s) { return s.replace(ANSI_RE, ''); }

function parseValue(raw) {
  const t = raw.trim();
  if (t === '' || t === 'undefined') return null;
  try { return JSON.parse(t); } catch (_) {}
  // pino-pretty às vezes serializa com aspas simples ou sem aspas em chaves
  if (/^[\d.+-eE]+$/.test(t)) {
    const n = Number(t);
    if (!Number.isNaN(n)) return n;
  }
  if (t === 'true')  return true;
  if (t === 'false') return false;
  if (t === 'null')  return null;
  // remove aspas externas se houver
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Recebe linhas do corpo do bloco (todas indentadas) e devolve um objeto.
 * Suporta valores multilinha que sejam objetos/arrays JSON.
 */
function parseBlockBody(lines) {
  const obj = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^\s+([A-Za-z0-9_\.]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    let valStr = m[2];

    // Multilinha: começa com { ou [ mas não fecha na mesma linha
    const startsObj = valStr.startsWith('{') || valStr.startsWith('[');
    if (startsObj) {
      const open  = valStr.startsWith('{') ? '{' : '[';
      const close = open === '{' ? '}' : ']';
      let depth = 0;
      let buffer = '';
      const startLineIdx = i;
      // junta linhas até fechar
      let merged = '';
      for (let j = startLineIdx; j < lines.length; j++) {
        const raw = j === startLineIdx ? valStr : lines[j].trimStart();
        merged += (j === startLineIdx ? '' : '\n') + raw;
        for (const ch of raw) {
          if (ch === open)  depth++;
          if (ch === close) depth--;
        }
        if (depth === 0) {
          i = j + 1;
          break;
        }
        if (j === lines.length - 1) i = lines.length;
      }
      try { obj[key] = JSON.parse(merged); } catch (_) { obj[key] = merged; }
    } else {
      obj[key] = parseValue(valStr);
      i++;
    }
  }
  return obj;
}

function* parseFile(filePath) {
  const content = stripAnsi(fs.readFileSync(filePath, 'utf8'));
  const lines = content.split(/\r?\n/);
  let block = null;
  for (let i = 0; i <= lines.length; i++) {
    const line = lines[i] ?? '';
    const head = line.match(HEAD_RE);
    if (head || i === lines.length) {
      // fecha bloco anterior
      if (block) {
        const body = parseBlockBody(block.bodyLines);
        yield {
          ts:     block.ts,
          level:  block.level,
          pid:    block.pid,
          marker: block.marker,
          ...body,
          _file:  path.basename(filePath),
        };
        block = null;
      }
      if (head) {
        block = {
          ts: head[1],
          level: head[2],
          pid: Number(head[3]),
          marker: head[4].trim(),
          bodyLines: [],
        };
      }
    } else if (block && /^\s+\S/.test(line)) {
      block.bodyLines.push(line);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) AGREGADOR por sessão
// ─────────────────────────────────────────────────────────────────────────────

function tsToMs(dateBase, ts) {
  const [h, m, s] = ts.split(':');
  const [sec, ms] = s.split('.');
  const d = new Date(dateBase);
  d.setHours(Number(h), Number(m), Number(sec), Number(ms));
  return d.getTime();
}

function extractPhone(ev) {
  return ev.phone || ev.from || null;
}

function buildSessions(events, dateBase) {
  // ordena por timestamp dentro de cada arquivo (já chegam ordenados; só normaliza ms)
  const enriched = events
    .map(ev => ({ ...ev, _ms: ev.ts ? tsToMs(dateBase, ev.ts) : 0, _phone: extractPhone(ev) }))
    .filter(ev => ev._phone)
    .sort((a, b) => a._ms - b._ms);

  // agrupa por phone, e dentro do phone, fatia por GAP
  const byPhone = new Map();
  for (const ev of enriched) {
    if (!byPhone.has(ev._phone)) byPhone.set(ev._phone, []);
    byPhone.get(ev._phone).push(ev);
  }

  const sessions = [];
  for (const [phone, evs] of byPhone) {
    let current = null;
    for (const ev of evs) {
      if (!current || (ev._ms - current.lastMs) > SESSION_GAP_MS) {
        if (current) sessions.push(current);
        current = newSession(phone, ev);
      }
      ingestEvent(current, ev);
      current.lastMs = ev._ms;
      current.endTs  = ev.ts;
    }
    if (current) sessions.push(current);
  }
  return sessions;
}

function newSession(phone, firstEv) {
  return {
    phone,
    startTs: firstEv.ts,
    endTs:   firstEv.ts,
    startMs: firstEv._ms,
    lastMs:  firstEv._ms,
    msgsReceived: 0,
    msgsSent:     0,
    aiCalls:      0,
    aiFailures:   0,
    semanticIntents: { wantsHuman: 0, wantsCheckout: 0, wantsClearCart: 0, wantsCart: 0 },
    cartAdds:    0,
    fsmEvents:   0,
    handoff:     false,
    handoffTrigger: null,
    autoEscalation: false,
    customerName: null,
    fsmStateChanges: [],
    aiActions:   {},
    errors:      [],
    timeline:    [],   // últimas 200 linhas: marker + ts + preview
  };
}

function ingestEvent(s, ev) {
  const m = ev.marker || '';
  // timeline compacta
  if (s.timeline.length < 500) {
    let preview = '';
    if (ev.text)         preview = String(ev.text).slice(0, 100);
    else if (ev.textPreview) preview = String(ev.textPreview).slice(0, 100);
    else if (ev.actionType)  preview = `action=${ev.actionType}`;
    else if (ev.trigger)     preview = `trigger=${ev.trigger}`;
    s.timeline.push({ ts: ev.ts, marker: m, preview });
  }

  if (m === '[MSG] Received') s.msgsReceived++;
  if (m.startsWith('[Z-API] send')) s.msgsSent++;

  if (m === '[AI] Decisão parseada') {
    s.aiCalls++;
    const a = ev.actionType || 'TEXT_ONLY';
    s.aiActions[a] = (s.aiActions[a] || 0) + 1;
  }
  if (m.includes('[AI] Falha')) {
    s.aiFailures++;
    s.errors.push({ ts: ev.ts, marker: m, msg: ev.err || ev.error || ev.msg || '' });
  }

  if (m === '[Semantic] Intenção detectada' && ev.intent) {
    for (const k of Object.keys(s.semanticIntents)) {
      if (ev.intent[k]) s.semanticIntents[k]++;
    }
  }

  if (m === '[Session/Load] Sessão carregada') {
    if (ev.customerName && !s.customerName) s.customerName = ev.customerName;
  }

  if (m.startsWith('[FSM]')) {
    s.fsmEvents++;
    if (m.includes('addToCart')) s.cartAdds++;
  }

  if (m.includes('[Intercept] Handoff')) {
    s.handoff = true;
    s.handoffTrigger = ev.trigger || s.handoffTrigger;
  }
  if (m.includes('[HumanHandoff]') || m.includes('[Handoff]')) {
    s.handoff = true;
  }
  if (m.includes('[AutoEscalation]')) {
    s.autoEscalation = true;
    s.handoff = true;
    s.handoffTrigger = s.handoffTrigger || ev.trigger || 'AUTO_ESCALATION';
  }

  if (ev.level === 'ERROR' || /Error|Falha/.test(m)) {
    if (s.errors.length < 50) {
      s.errors.push({ ts: ev.ts, marker: m, msg: ev.err || ev.error || ev.msg || ev.errMessage || '' });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) RELATÓRIO em Markdown
// ─────────────────────────────────────────────────────────────────────────────

function maskPhone(p) {
  if (!p || p.length < 8) return p;
  return p.slice(0, 4) + '****' + p.slice(-4);
}

function durationMin(s) {
  return Math.round((s.lastMs - s.startMs) / 60000);
}

function buildReport(sessions, totalEvents, fileList) {
  const total = sessions.length;
  const uniqueClients = new Set(sessions.map(s => s.phone)).size;
  const handoffs = sessions.filter(s => s.handoff).length;
  const handoffRate = total ? (handoffs / total * 100).toFixed(1) : '0';
  const sessionsWithCart = sessions.filter(s => s.cartAdds > 0).length;
  const conversionRate = total ? (sessionsWithCart / total * 100).toFixed(1) : '0';
  const avgMsgs = total ? (sessions.reduce((a, s) => a + s.msgsReceived, 0) / total).toFixed(1) : '0';
  const totalAICalls = sessions.reduce((a, s) => a + s.aiCalls, 0);
  const totalAIFails = sessions.reduce((a, s) => a + s.aiFailures, 0);
  const totalErrors  = sessions.reduce((a, s) => a + s.errors.length, 0);
  const namedClients = sessions.filter(s => s.customerName).length;

  // breakdown de gatilhos de handoff
  const triggers = {};
  sessions.filter(s => s.handoff).forEach(s => {
    const t = s.handoffTrigger || 'UNKNOWN';
    triggers[t] = (triggers[t] || 0) + 1;
  });

  // ações de IA agregadas
  const allActions = {};
  sessions.forEach(s => {
    Object.entries(s.aiActions).forEach(([k, v]) => {
      allActions[k] = (allActions[k] || 0) + v;
    });
  });

  // intenções semânticas agregadas
  const allIntents = { wantsHuman: 0, wantsCheckout: 0, wantsClearCart: 0, wantsCart: 0 };
  sessions.forEach(s => {
    Object.keys(allIntents).forEach(k => allIntents[k] += s.semanticIntents[k]);
  });

  const lines = [];
  lines.push(`# Relatório de Produção — Agente Belux`);
  lines.push(``);
  lines.push(`**Gerado em:** ${new Date().toLocaleString('pt-BR')}`);
  lines.push(`**Logs analisados:** ${fileList.length} arquivo(s)`);
  fileList.forEach(f => lines.push(`- \`${f}\``));
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`## 📊 Visão Geral`);
  lines.push(``);
  lines.push(`| Métrica | Valor |`);
  lines.push(`|---------|-------|`);
  lines.push(`| Total de eventos parseados | ${totalEvents.toLocaleString('pt-BR')} |`);
  lines.push(`| Total de sessões | ${total} |`);
  lines.push(`| Clientes únicos | ${uniqueClients} |`);
  lines.push(`| Mensagens recebidas | ${sessions.reduce((a, s) => a + s.msgsReceived, 0)} |`);
  lines.push(`| Mensagens enviadas | ${sessions.reduce((a, s) => a + s.msgsSent, 0)} |`);
  lines.push(`| Média de msgs/sessão | ${avgMsgs} |`);
  lines.push(`| Chamadas à IA | ${totalAICalls} |`);
  lines.push(`| Falhas da IA | ${totalAIFails} |`);
  lines.push(`| Erros totais (logs) | ${totalErrors} |`);
  lines.push(`| **Taxa de handoff** | **${handoffRate}%** (${handoffs}/${total}) |`);
  lines.push(`| **Taxa de conversão (sessão com item no carrinho)** | **${conversionRate}%** (${sessionsWithCart}/${total}) |`);
  lines.push(`| Clientes com nome capturado | ${namedClients} (${total ? (namedClients/total*100).toFixed(1) : 0}%) |`);
  lines.push(``);

  lines.push(`## 🚨 Gatilhos de Handoff`);
  lines.push(``);
  lines.push(`| Gatilho | Ocorrências |`);
  lines.push(`|---------|-------------|`);
  Object.entries(triggers).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    lines.push(`| \`${k}\` | ${v} |`);
  });
  lines.push(``);

  lines.push(`## 🧠 Intenções Semânticas Detectadas`);
  lines.push(``);
  lines.push(`| Intenção | Total |`);
  lines.push(`|----------|-------|`);
  Object.entries(allIntents).forEach(([k, v]) => lines.push(`| ${k} | ${v} |`));
  lines.push(``);

  lines.push(`## 🤖 Ações da IA (parseAction)`);
  lines.push(``);
  lines.push(`| Action Type | Ocorrências |`);
  lines.push(`|-------------|-------------|`);
  Object.entries(allActions).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
    lines.push(`| \`${k}\` | ${v} |`);
  });
  lines.push(``);

  // top sessões mais longas / com mais erros
  lines.push(`## 🔍 Top 10 sessões por duração`);
  lines.push(``);
  lines.push(`| Cliente | Duração | Msgs | Carrinho | Handoff | Erros |`);
  lines.push(`|---------|---------|------|----------|---------|-------|`);
  [...sessions]
    .sort((a, b) => durationMin(b) - durationMin(a))
    .slice(0, 10)
    .forEach(s => {
      lines.push(`| ${maskPhone(s.phone)} | ${durationMin(s)}min | ${s.msgsReceived} | ${s.cartAdds} | ${s.handoff ? '✓' : '—'} | ${s.errors.length} |`);
    });
  lines.push(``);

  lines.push(`## 🔥 Top 10 sessões por erros`);
  lines.push(``);
  lines.push(`| Cliente | Erros | Falhas IA | Handoff | Gatilho |`);
  lines.push(`|---------|-------|-----------|---------|---------|`);
  [...sessions]
    .filter(s => s.errors.length > 0)
    .sort((a, b) => b.errors.length - a.errors.length)
    .slice(0, 10)
    .forEach(s => {
      lines.push(`| ${maskPhone(s.phone)} | ${s.errors.length} | ${s.aiFailures} | ${s.handoff ? '✓' : '—'} | ${s.handoffTrigger || '—'} |`);
    });
  lines.push(``);

  // amostra dos primeiros tipos de erro
  const errorSamples = {};
  sessions.forEach(s => s.errors.forEach(e => {
    const key = e.marker;
    if (!errorSamples[key]) errorSamples[key] = { count: 0, sample: e.msg };
    errorSamples[key].count++;
  }));
  if (Object.keys(errorSamples).length) {
    lines.push(`## ⚠️ Erros agrupados por marker`);
    lines.push(``);
    lines.push(`| Marker | Ocorrências | Amostra |`);
    lines.push(`|--------|-------------|---------|`);
    Object.entries(errorSamples).sort((a, b) => b[1].count - a[1].count).forEach(([k, v]) => {
      const sample = String(v.sample || '').replace(/\|/g, '\\|').slice(0, 80);
      lines.push(`| \`${k}\` | ${v.count} | ${sample} |`);
    });
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(``);
  lines.push(`## 📁 Arquivos gerados`);
  lines.push(``);
  lines.push(`- \`logs/parsed/parsed-events.jsonl\` — todos os eventos estruturados`);
  lines.push(`- \`logs/parsed/sessions.jsonl\` — uma linha por sessão (com timeline)`);
  lines.push(`- \`RELATORIO_PRODUCAO.md\` — este relatório`);
  lines.push(``);
  lines.push(`> Para análise mais profunda por IA, mande \`sessions.jsonl\` para o Gemini`);
  lines.push(`> com prompt: "Analise estas sessões, agrupe padrões de falha e sugira melhorias."`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  console.log('🔎 Listando logs em', LOGS_DIR);
  const files = fs.readdirSync(LOGS_DIR)
    .filter(f => f.startsWith('belux-') && f.endsWith('.log'))
    .sort();
  if (!files.length) {
    console.error('❌ Nenhum log encontrado.');
    process.exit(1);
  }
  console.log(`   ${files.length} arquivo(s):`, files.join(', '));

  // base date a partir do nome do primeiro arquivo: belux-YYYYMMDD-HHmm.log
  const m = files[0].match(/belux-(\d{4})(\d{2})(\d{2})-/);
  const dateBase = m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00` : new Date().toISOString().slice(0, 10) + 'T00:00:00';

  console.log('🛠  Parseando blocos...');
  const evStream = fs.createWriteStream(EVENTS_OUT);
  const allEvents = [];
  for (const f of files) {
    let count = 0;
    for (const ev of parseFile(path.join(LOGS_DIR, f))) {
      evStream.write(JSON.stringify(ev) + '\n');
      allEvents.push(ev);
      count++;
    }
    console.log(`   ${f}: ${count} eventos`);
  }
  evStream.end();
  console.log(`✓ ${allEvents.length} eventos totais → ${path.relative(ROOT, EVENTS_OUT)}`);

  console.log('🧩 Construindo sessões...');
  const sessions = buildSessions(allEvents, dateBase);
  fs.writeFileSync(SESS_OUT, sessions.map(s => JSON.stringify(s)).join('\n'));
  console.log(`✓ ${sessions.length} sessões → ${path.relative(ROOT, SESS_OUT)}`);

  console.log('📝 Gerando relatório...');
  const report = buildReport(sessions, allEvents.length, files);
  fs.writeFileSync(REPORT_OUT, report);
  console.log(`✓ Relatório → ${path.relative(ROOT, REPORT_OUT)}`);

  console.log('\n✅ Concluído.');
}

main();
