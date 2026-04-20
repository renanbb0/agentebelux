/**
 * monitor.js — Dashboard de monitoramento do Agente Belux
 * Porta 3001 | Leitura passiva do log + Supabase + Z-API + Gemini Sentiment
 * NÃO mexe no index.js
 */

require('dotenv').config();
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { WebSocketServer } = require('ws');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const PORT     = 3001;
const LOGS_DIR = path.join(__dirname, 'logs');

// ─── Clients externos ────────────────────────────────────────────────────────

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const sentimentModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const ZAPI_BASE = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`;
const zapi = axios.create({
  baseURL: ZAPI_BASE,
  headers: { 'Content-Type': 'application/json', ...(process.env.ZAPI_CLIENT_TOKEN ? { 'Client-Token': process.env.ZAPI_CLIENT_TOKEN } : {}) },
  timeout: 15000,
});
const ADMIN_PHONES = (process.env.ADMIN_PHONES || '').split(',').map(s => s.trim()).filter(Boolean);

// ─── Análise de sentimento via Gemini ────────────────────────────────────────

const SENTIMENT_LABELS = {
  FRUSTRADO:  { icon: '😤', color: '#ff6b6b', label: 'Frustrado'  },
  CONFUSO:    { icon: '😕', color: '#f5a623', label: 'Confuso'    },
  IMPACIENTE: { icon: '⏰', color: '#ff9940', label: 'Impaciente' },
  DESISTINDO: { icon: '🚪', color: '#cc4444', label: 'Desistindo' },
  ANIMADO:    { icon: '😃', color: '#4ecb71', label: 'Animado'    },
  SATISFEITO: { icon: '😊', color: '#7c9eff', label: 'Satisfeito' },
  NEUTRO:     { icon: '😐', color: '#888888', label: 'Neutro'     },
};

// Cache sentimento para não chamar Gemini duas vezes pela mesma msg
const sentimentCache = new Map();

async function analyzeSentiment(phone, text, history) {
  const cacheKey = `${phone}:${text}`;
  if (sentimentCache.has(cacheKey)) return sentimentCache.get(cacheKey);

  // Contexto: últimas 3 msgs do cliente para entender progressão
  const recentClientMsgs = (state.perPhoneEvents[phone] || [])
    .filter(e => e.category === 'client')
    .slice(-3)
    .map(e => e.text)
    .join(' | ');

  const prompt = `Você é um analisador de sentimento para uma loja de moda íntima no WhatsApp.
Classifique o estado emocional do cliente em UMA palavra apenas:
FRUSTRADO | CONFUSO | IMPACIENTE | DESISTINDO | ANIMADO | SATISFEITO | NEUTRO

Contexto recente: "${recentClientMsgs}"
Mensagem atual: "${text}"

Responda APENAS a palavra, sem pontuação.`;

  try {
    const result = await sentimentModel.generateContent(prompt);
    const raw    = result.response.text().trim().toUpperCase().replace(/[^A-Z]/g, '');
    const label  = SENTIMENT_LABELS[raw] ? raw : 'NEUTRO';
    sentimentCache.set(cacheKey, label);
    return label;
  } catch {
    return 'NEUTRO';
  }
}

// ─── Estado ──────────────────────────────────────────────────────────────────

function freshState() {
  return {
    startedAt:          new Date().toISOString(),
    chatsUnicos:        new Set(),
    ultimaAtividade:    {},
    mensagensRecebidas: 0,
    webhooksTotal:      0,
    chamadasIA:         0,
    ttsGerados:         0,
    itensCarrinho:      0,
    handoffs:           0,
    erros:              [],
    sessionResets:      0,
    switchFsmFocus:     0,
    gradesParsed:       0,
    perPhoneEvents:     {},   // phone → [{ time, category, icon, text, sentiment?, meta? }]
    sentimentSummary:   {},   // phone → { FRUSTRADO: 2, SATISFEITO: 1, ... }
    logFile:            null,
  };
}

let state = freshState();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function extractField(block, key) {
  const m = block.match(new RegExp(`${key}:\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

function extractJson(block, key) {
  try {
    const idx = block.indexOf(`${key}:`);
    if (idx === -1) return null;
    const sub = block.slice(idx + key.length + 1).trim();
    const end = sub.indexOf('\n    [') !== -1 ? sub.indexOf('\n    [') : sub.indexOf('\n  [');
    const chunk = end !== -1 ? sub.slice(0, end) : sub.slice(0, 400);
    return JSON.parse(chunk.split('\n')[0].trim());
  } catch { return null; }
}

function pushEvent(phone, ev) {
  if (!state.perPhoneEvents[phone]) state.perPhoneEvents[phone] = [];
  const arr = state.perPhoneEvents[phone];
  arr.push(ev);
  if (arr.length > 600) arr.shift();
}

function recordSentiment(phone, label) {
  if (!state.sentimentSummary[phone]) state.sentimentSummary[phone] = {};
  state.sentimentSummary[phone][label] = (state.sentimentSummary[phone][label] || 0) + 1;
}

// ─── Parser por blocos ───────────────────────────────────────────────────────

function processBlock(blockRaw) {
  const block = stripAnsi(blockRaw);
  const tsMatch = block.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{3})\]/);
  if (!tsMatch) return;
  const time = tsMatch[1];

  const phone = extractField(block, 'phone') || extractField(block, 'from') || extractField(block, 'to');
  if (phone && !phone.includes('@')) {
    state.chatsUnicos.add(phone);
    state.ultimaAtividade[phone] = Date.now();
  }

  const firstLine = block.split('\n')[0];
  const eff_phone = phone && !phone.includes('@') ? phone : null;

  // ── MSG Recebida ──
  if (firstLine.includes('[MSG] Received')) {
    state.mensagensRecebidas++;
    const text = extractField(block, 'text');
    if (eff_phone && text) {
      pushEvent(eff_phone, { time, category: 'client', icon: '👤', text, sentiment: 'NEUTRO' });
      // Análise de sentimento assíncrona — atualiza o evento quando terminar
      const evIdx = state.perPhoneEvents[eff_phone].length - 1;
      analyzeSentiment(eff_phone, text).then(label => {
        const arr = state.perPhoneEvents[eff_phone];
        if (arr && arr[evIdx]) arr[evIdx].sentiment = label;
        recordSentiment(eff_phone, label);
      }).catch(() => {});
    }
    return;
  }

  // ── Webhook (contador) ──
  if (firstLine.includes('[Webhook] Evento recebido')) { state.webhooksTotal++; return; }

  // ── [Semantic] Intenção detectada ──
  if (firstLine.includes('[Semantic] Intenção detectada')) {
    if (!eff_phone) return;
    // Extrair campos do bloco multi-linha
    const wantsHuman    = block.includes('"wantsHuman": true');
    const wantsCheckout = block.includes('"wantsCheckout": true');
    const wantsClearCart= block.includes('"wantsClearCart": true');
    const wantsCart     = block.includes('"wantsCart": true');
    const slang         = block.includes('"slangOrNoisy": true');
    const catMatch      = block.match(/"categories":\s*\[([^\]]*)\]/);
    const categories    = catMatch ? catMatch[1].replace(/"/g, '').split(',').map(s => s.trim()).filter(Boolean) : [];

    const flags = [];
    if (wantsHuman)    flags.push('🤝 quer atendente');
    if (wantsCheckout) flags.push('💳 quer fechar pedido');
    if (wantsClearCart)flags.push('🗑️ limpar carrinho');
    if (wantsCart)     flags.push('🛒 ver carrinho');
    if (slang)         flags.push('💬 gíria/ruído');
    if (categories.length) flags.push('📂 ' + categories.join(', '));

    const summary = flags.length ? flags.join(' · ') : 'neutro / sem intenção clara';
    pushEvent(eff_phone, { time, category: 'semantic', icon: '🎯', text: summary });
    return;
  }

  // ── [AI] Decisão parseada ──
  if (firstLine.includes('[AI] Decisão parseada')) {
    if (!eff_phone) return;
    const actionType  = extractField(block, 'actionType');
    const textPreview = extractField(block, 'textPreview');
    const fsmState    = extractField(block, 'fsmState');
    const parts = [];
    if (actionType)  parts.push(`ação: ${actionType}`);
    if (textPreview) parts.push(`texto: "${textPreview.slice(0, 60)}..."`);
    if (fsmState && fsmState !== 'idle') parts.push(`fsm: ${fsmState}`);
    const summary = parts.length ? parts.join(' · ') : 'resposta de texto';
    pushEvent(eff_phone, { time, category: 'ai-decision', icon: '🧠', text: summary });
    state.chamadasIA++;
    return;
  }

  // ── [AI] Response (legado) ──
  if (firstLine.includes('[AI] Response') || firstLine.includes('[AI]')) {
    if (!firstLine.includes('Decisão')) state.chamadasIA++;
    return;
  }

  // ── [Session/Load] ──
  if (firstLine.includes('[Session/Load] Sessão carregada')) {
    if (!eff_phone) return;
    const isNew      = block.includes('"isNew": true');
    const cartItems  = block.match(/"cartItems":\s*(\d+)/)?.[1] || '0';
    const historyLen = block.match(/"historyLen":\s*(\d+)/)?.[1] || '0';
    const custName   = extractField(block, 'customerName');
    const support    = extractField(block, 'supportMode');
    const ageMs      = parseInt(block.match(/"sessionAgeMs":\s*(\d+)/)?.[1] || '0');
    const ageMins    = Math.round(ageMs / 60000);

    const parts = isNew ? ['✨ sessão nova'] : [`retomou após ${ageMins}min`];
    if (custName)   parts.push(`nome: ${custName}`);
    if (cartItems !== '0') parts.push(`carrinho: ${cartItems} itens`);
    if (historyLen !== '0') parts.push(`histórico: ${historyLen} msgs`);
    if (support)    parts.push(`⚠️ suporte: ${support}`);

    pushEvent(eff_phone, { time, category: 'session', icon: '🔌', text: parts.join(' · ') });
    if (isNew) state.sessionResets++;
    return;
  }

  // ── Z-API saída ──
  if (firstLine.includes('[Z-API]')) {
    let kind = 'texto';
    if (firstLine.includes('sendAudio'))       kind = '🔊 áudio';
    else if (firstLine.includes('sendImage'))  kind = '🖼️ imagem';
    else if (firstLine.includes('sendOptionList')) kind = '📋 lista de opções';
    else if (firstLine.includes('sendSizeList'))   kind = '📏 lista de tamanhos';
    else if (firstLine.includes('sendButton'))     kind = '🔘 botões';
    else if (firstLine.includes('sendReaction')) {
      const reaction = extractField(block, 'reaction');
      if (eff_phone) pushEvent(eff_phone, { time, category: 'bot-meta', icon: '💫', text: `reação ${reaction || '✓'}` });
      return;
    } else if (firstLine.includes('replyText')) kind = '↩️ reply';
    if (eff_phone) pushEvent(eff_phone, { time, category: 'bot', icon: '🤖', text: `enviou ${kind}` });
    return;
  }

  // ── TTS ──
  if (firstLine.includes('[textToSpeech] Iniciando')) { state.ttsGerados++; return; }

  // ── FSM ──
  if (firstLine.includes('[FSM]')) {
    const short = firstLine.split('[FSM]')[1]?.trim().slice(0, 100) || '';
    if (eff_phone) pushEvent(eff_phone, { time, category: 'fsm', icon: '⚙️', text: short });
    if (firstLine.includes('switchFsmFocus')) state.switchFsmFocus++;
    return;
  }

  // ── Carrinho ──
  if (firstLine.includes('[addToCart]')) {
    state.itensCarrinho++;
    if (eff_phone) pushEvent(eff_phone, { time, category: 'cart', icon: '🛒', text: 'item adicionado ao carrinho' });
    return;
  }
  if (firstLine.includes('[FSM/Variant] Grade multi-variante')) {
    state.itensCarrinho++;
    // addedSummary pode ser array — pegar do bloco
    const added = block.match(/"addedSummary":\s*\[([^\]]*)\]/)?.[1]?.replace(/"/g, '') || '';
    if (eff_phone) pushEvent(eff_phone, { time, category: 'cart', icon: '🛒', text: `grade processada${added ? ': ' + added : ''}` });
    return;
  }
  if (firstLine.includes('[SilentAdd] Timer disparou')) {
    if (eff_phone) pushEvent(eff_phone, { time, category: 'cart', icon: '⏱️', text: 'timer de resumo disparado → avançou fila' });
    return;
  }

  // ── Handoff ──
  if (firstLine.includes('[Handoff]') || firstLine.includes('[HumanHandoff]')) {
    if (firstLine.includes('Order persisted') || firstLine.includes('executeHandoff') || firstLine.includes('Admin notified')) {
      state.handoffs++;
      if (eff_phone) pushEvent(eff_phone, { time, category: 'handoff', icon: '🤝', text: 'handoff para humano executado' });
    }
    return;
  }

  // ── Intercept (expandido com trigger) ──
  if (firstLine.includes('[Intercept]')) {
    const short   = firstLine.split('[Intercept]')[1]?.trim().slice(0, 100) || '';
    const trigger = extractField(block, 'trigger');
    const fsm     = extractField(block, 'fsmState');
    const cart    = block.match(/"cartItems":\s*(\d+)/)?.[1];
    const parts   = [short];
    if (trigger) parts.push(`trigger: ${trigger}`);
    if (fsm && fsm !== 'idle') parts.push(`fsm: ${fsm}`);
    if (cart)    parts.push(`carrinho: ${cart}`);
    if (eff_phone) pushEvent(eff_phone, { time, category: 'intercept', icon: '🎯', text: parts.join(' · ') });
    return;
  }

  // ── AutoEscalation ──
  if (firstLine.includes('[AutoEscalation]')) {
    const trigger = extractField(block, 'trigger') || 'falhas consecutivas';
    const fails   = block.match(/"failures":\s*(\d+)/)?.[1] || '?';
    if (eff_phone) pushEvent(eff_phone, { time, category: 'error', icon: '🚨', text: `auto-escalação: ${trigger} (${fails} falhas) → handoff` });
    return;
  }

  // ── Grade ──
  if (firstLine.includes('[Grade]') || firstLine.includes('[Grade/QuoteVariant]')) {
    state.gradesParsed++;
    const short = (firstLine.split(':').pop() || '').trim().slice(0, 90);
    if (eff_phone) pushEvent(eff_phone, { time, category: 'grade', icon: '📐', text: short });
    return;
  }

  // ── Erros ──
  if (firstLine.match(/ERROR/) && !block.includes('node_modules')) {
    const msg = firstLine.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+\w+\s+\(\d+\):\s*/, '').trim();
    if (msg.length > 5) {
      state.erros.unshift({ time, phone: eff_phone, msg: msg.slice(0, 200) });
      if (state.erros.length > 50) state.erros.pop();
      if (eff_phone) pushEvent(eff_phone, { time, category: 'error', icon: '❌', text: msg.slice(0, 100) });
    }
  }
}

// ─── Watcher de log ───────────────────────────────────────────────────────────

let logBuffer = '';
let currentBlock = '';

function feedChunk(chunk) {
  logBuffer += chunk;
  const lines = logBuffer.split('\n');
  logBuffer = lines.pop();
  for (const line of lines) {
    if (/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/.test(line)) {
      if (currentBlock) processBlock(currentBlock);
      currentBlock = line;
    } else {
      currentBlock += '\n' + line;
    }
  }
}

function flushBlock() {
  if (currentBlock) { processBlock(currentBlock); currentBlock = ''; }
}

function latestLog() {
  try {
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => f.endsWith('.log'))
      .map(f => ({ f, t: fs.statSync(path.join(LOGS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return files.length ? path.join(LOGS_DIR, files[0].f) : null;
  } catch { return null; }
}

function openLogTail(filePath) {
  state.logFile = path.basename(filePath);
  const full = fs.readFileSync(filePath, 'utf8');
  feedChunk(full); flushBlock();

  let lastSize = fs.statSync(filePath).size;
  fs.watchFile(filePath, { interval: 800 }, (curr) => {
    if (curr.size < lastSize) { state = freshState(); currentBlock = ''; logBuffer = ''; openLogTail(filePath); return; }
    if (curr.size > lastSize) {
      const stream = fs.createReadStream(filePath, { start: lastSize, end: curr.size, encoding: 'utf8' });
      stream.on('data', feedChunk);
      stream.on('end', flushBlock);
      lastSize = curr.size;
    }
  });
}

function startWatching() {
  const f = latestLog();
  if (f) openLogTail(f);
  else setTimeout(startWatching, 3000);
}

startWatching();

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function loadSessionFromSupabase(phone) {
  const { data } = await supabase.from('sessions').select('phone,customer_name,history,items,support_mode,purchase_flow,current_product').eq('phone', phone).single();
  return data || null;
}

// ─── Z-API helpers ────────────────────────────────────────────────────────────

async function sendZapiText(to, message) {
  await zapi.post('/send-text', { phone: to, message, delayTyping: Math.min(Math.ceil(message.length / 80), 5) });
}

// ─── Handoff manual ───────────────────────────────────────────────────────────

async function forceHandoff(phone, reason) {
  const session = await loadSessionFromSupabase(phone);
  const nome    = session?.customer_name || '';
  const items   = session?.items || [];

  await sendZapiText(phone,
    `Oi${nome ? ' ' + nome.split(' ')[0] : ''}! 💖 Vou te passar agora pra nossa consultora que vai te atender pessoalmente. Já já ela te chama por aqui, tá bom?`
  );

  const purchaseFlow = { ...(session?.purchase_flow || {}), handoffDone: true };
  await supabase.from('sessions').upsert({ phone, support_mode: 'human_pending', purchase_flow: purchaseFlow, updated_at: new Date().toISOString() }, { onConflict: 'phone' });

  const resumo = items.length
    ? items.map((i, n) => `${n + 1}. ${i.name || '?'} ${i.size ? '(' + i.size + ')' : ''} ${i.quantity ? 'x' + i.quantity : ''}`).join('\n')
    : '(carrinho vazio)';

  const adminMsg = `🚨 *HANDOFF MANUAL VIA PAINEL*\n\nCliente: ${nome || phone} — https://wa.me/${phone}\nMotivo: ${reason || 'solicitado pelo painel'}\n\n*Carrinho:*\n${resumo}\n\nA Bela foi pausada. Pode assumir a conversa.`;
  for (const admin of ADMIN_PHONES) {
    try { await sendZapiText(admin, adminMsg); } catch {}
  }
  return { ok: true, notifiedAdmins: ADMIN_PHONES.length, items: items.length };
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

const SENTIMENT_JSON = JSON.stringify(SENTIMENT_LABELS);

const HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bela Monitor</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f0f13;color:#e0e0e0;font-family:'Segoe UI',system-ui,sans-serif}
  .top{padding:14px 20px;border-bottom:1px solid #1e1e2e;display:flex;align-items:center;justify-content:space-between}
  h1{font-size:1.1rem;color:#fff;display:flex;align-items:center;gap:8px}
  .sub{font-size:.68rem;color:#555}
  .wrap{display:grid;grid-template-columns:300px 1fr;height:calc(100vh - 52px)}
  .side{border-right:1px solid #1e1e2e;overflow-y:auto;padding:10px}
  .main{overflow-y:auto;padding:14px 18px}

  /* cards métricas */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:6px;margin-bottom:12px}
  .card{background:#1a1a24;border:1px solid #2a2a3a;border-radius:7px;padding:8px 6px;text-align:center}
  .card .val{font-size:1.3rem;font-weight:700;color:#7c9eff}
  .card .val.ok{color:#4ecb71}.card .val.warn{color:#f5a623}.card .val.danger{color:#ff6b6b}
  .card .lbl{font-size:.58rem;color:#777;margin-top:2px;text-transform:uppercase;letter-spacing:.04em}

  /* lista de chats */
  h2{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:#555;margin:10px 0 5px}
  .chat-item{background:#1a1a24;border:1px solid #2a2a3a;border-radius:7px;padding:7px 9px;margin-bottom:5px;cursor:pointer;transition:border .15s}
  .chat-item:hover{border-color:#4c6fff}
  .chat-item.sel{border-color:#4ecb71;background:#1a2a1e}
  .chat-item.ativo .ph::before{content:'● ';color:#4ecb71;font-size:.75rem}
  .chat-item .ph{font-family:monospace;font-size:.75rem;color:#ccc}
  .chat-item .nm{font-size:.68rem;color:#777;margin-top:1px}
  .sentiment-bar{display:flex;gap:3px;margin-top:4px;flex-wrap:wrap}
  .s-pill{font-size:.6rem;padding:1px 5px;border-radius:10px;background:#1e1e2e}

  /* timeline */
  .tl-header{background:#1a1a24;border:1px solid #2a2a3a;border-radius:9px;padding:12px 14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px}
  .tl-header .phone{font-family:monospace;font-size:.95rem;color:#fff}
  .tl-header .name{font-size:.75rem;color:#aaa;margin-top:2px}
  .tl-header .status{font-size:.65rem;color:#666;margin-top:4px}
  .sentiment-summary{background:#1a1a24;border:1px solid #2a2a3a;border-radius:9px;padding:10px 14px;margin-bottom:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .sentiment-summary .tt{font-size:.65rem;color:#666;text-transform:uppercase;letter-spacing:.08em;margin-right:4px}
  .s-badge{display:flex;align-items:center;gap:4px;font-size:.75rem;padding:3px 10px;border-radius:12px;background:#1e1e2e;border:1px solid #2a2a3a}
  .cart-box{background:#1e2a1e;border:1px solid #2a4a2a;border-radius:8px;padding:9px 12px;margin-bottom:10px}
  .cart-box .tt{font-size:.62rem;color:#7c9eff;text-transform:uppercase;margin-bottom:5px}
  .cart-item{font-family:monospace;font-size:.72rem;color:#c0ffc0;padding:1px 0}

  /* eventos */
  .timeline{background:#1a1a24;border:1px solid #2a2a3a;border-radius:9px;padding:8px}
  .ev{display:flex;gap:8px;padding:5px 4px;border-bottom:1px solid #1a1a24;align-items:flex-start}
  .ev:last-child{border:none}
  .ev .t{color:#444;font-family:monospace;font-size:.65rem;min-width:78px;padding-top:2px;flex-shrink:0}
  .ev .ic{min-width:18px;font-size:.85rem}
  .ev .body{display:flex;flex-direction:column;gap:2px;min-width:0}
  .ev .tx{font-size:.78rem;word-break:break-word;color:#ddd}
  .ev .sent-tag{font-size:.62rem;padding:1px 6px;border-radius:8px;display:inline-block;width:fit-content}

  /* cores por categoria */
  .ev.client .tx{color:#a8d8ff}
  .ev.bot .tx{color:#c0ffc0}
  .ev.ai-decision .tx{color:#ffd080}
  .ev.semantic .tx{color:#d4a0ff}
  .ev.session .tx{color:#7c9eff;font-size:.72rem}
  .ev.fsm .tx{color:#888;font-size:.72rem}
  .ev.error .tx{color:#ff8080;font-weight:600}
  .ev.handoff .tx{color:#ffb366;font-weight:600}
  .ev.cart .tx{color:#b5ffc9;font-weight:600}
  .ev.intercept .tx{color:#c999ff}
  .ev.grade .tx{color:#fff09a}
  .ev.bot-meta .tx,.ev.system .tx{color:#555;font-size:.68rem}

  .btn-handoff{background:#c0392b;color:#fff;border:none;padding:9px 14px;border-radius:7px;font-weight:600;cursor:pointer;font-size:.78rem;white-space:nowrap}
  .btn-handoff:hover{background:#a93226}
  .btn-handoff:disabled{background:#333;color:#777;cursor:not-allowed}

  #dot{width:7px;height:7px;border-radius:50%;background:#4ecb71;display:inline-block;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .empty{text-align:center;color:#444;padding:40px;font-size:.85rem}
  .toast{position:fixed;bottom:18px;right:18px;background:#1a2a1e;border:1px solid #4ecb71;padding:10px 18px;border-radius:8px;color:#4ecb71;font-size:.82rem;z-index:99;display:none}
  .toast.err{background:#2a1a1a;border-color:#ff6b6b;color:#ff6b6b}
</style>
</head>
<body>
<div class="top">
  <h1><span id="dot"></span> Bela Monitor</h1>
  <div class="sub" id="sub">conectando...</div>
</div>
<div class="wrap">
  <div class="side">
    <div id="cards" class="grid"></div>
    <h2>Ativos agora</h2><div id="ativos"></div>
    <h2>Todos os chats</h2><div id="todos"></div>
  </div>
  <div class="main" id="main">
    <div class="empty">← Selecione um chat para ver a conversa</div>
  </div>
</div>
<div id="toast" class="toast"></div>

<script>
const SENTIMENT = ${SENTIMENT_JSON};
const ws = new WebSocket('ws://' + location.host);
let cur = null, metrics = {};

const mask = p => p?.length >= 8 ? p.slice(0,4)+'****'+p.slice(-4) : p;
const esc  = s => String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast'+(err?' err':''); t.style.display='block';
  setTimeout(()=>t.style.display='none', 3500);
}

ws.onmessage = e => {
  metrics = JSON.parse(e.data);
  document.getElementById('sub').textContent = 'desde ' + new Date(metrics.startedAt).toLocaleTimeString('pt-BR') + ' · ' + (metrics.logFile||'—');

  const cards = [
    { v: metrics.chatsUnicos,        l: 'Total',    c: '' },
    { v: metrics.chatsAtivos,        l: 'Ativos',   c: metrics.chatsAtivos>0?'ok':'' },
    { v: metrics.mensagensRecebidas, l: 'Msgs',     c: '' },
    { v: metrics.chamadasIA,         l: 'IA',       c: '' },
    { v: metrics.ttsGerados,         l: 'TTS',      c: '' },
    { v: metrics.itensCarrinho,      l: 'Carrinho', c: metrics.itensCarrinho>0?'ok':'' },
    { v: metrics.handoffs,           l: 'Handoffs', c: metrics.handoffs>0?'warn':'' },
    { v: metrics.erros,              l: 'Erros',    c: metrics.erros>0?'danger':'ok' },
  ];
  document.getElementById('cards').innerHTML = cards.map(c =>
    '<div class="card"><div class="val '+c.c+'">'+c.v+'</div><div class="lbl">'+c.l+'</div></div>'
  ).join('');

  renderList('ativos', metrics.ativosArr, true);
  renderList('todos',  metrics.todosArr,  false, metrics.ativosArr);
  if (cur) loadTimeline(cur, true);
};
ws.onclose = () => {
  document.getElementById('dot').style.background='#ff6b6b';
  document.getElementById('sub').textContent = 'Desconectado — recarregue';
};

function sentimentBar(phone, inline) {
  const s = metrics.sentimentMap?.[phone]; if (!s) return '';
  const entries = Object.entries(s).sort((a,b)=>b[1]-a[1]).slice(0,4);
  if (!entries.length) return '';
  if (inline) return '<div class="sentiment-bar">' + entries.map(([k,v]) => {
    const def = SENTIMENT[k]||{icon:'',color:'#888'};
    return '<span class="s-pill" style="border:1px solid '+def.color+'20;color:'+def.color+'">'+def.icon+' '+v+'</span>';
  }).join('') + '</div>';
  return entries.map(([k,v]) => {
    const def = SENTIMENT[k]||{icon:'',color:'#888',label:k};
    return '<div class="s-badge" style="border-color:'+def.color+'40;color:'+def.color+'">'+def.icon+' '+def.label+' <strong>'+v+'</strong></div>';
  }).join('');
}

function renderList(id, arr, isAtivo, activeSet) {
  const el = document.getElementById(id);
  const activeObj = new Set(activeSet||[]);
  if (!arr.length) { el.innerHTML='<div style="color:#444;font-size:.7rem;padding:5px">Nenhum</div>'; return; }
  el.innerHTML = arr.map(p => {
    const active = isAtivo || activeObj.has(p);
    const sel    = p===cur?' sel':'';
    return '<div class="chat-item'+(active?' ativo':'')+sel+'" onclick="loadTimeline(\\''+p+'\\')">'+
           '<div class="ph">'+mask(p)+'</div>'+
           sentimentBar(p, true)+
           '</div>';
  }).join('');
}

async function loadTimeline(phone, silent) {
  cur = phone;
  if (!silent) document.getElementById('main').innerHTML='<div class="empty">Carregando...</div>';
  try {
    const r = await fetch('/api/session/'+phone);
    render(await r.json());
    renderList('ativos', metrics.ativosArr, true);
    renderList('todos',  metrics.todosArr,  false, metrics.ativosArr);
  } catch { document.getElementById('main').innerHTML='<div class="empty">Erro ao carregar</div>'; }
}

function render(data) {
  const support = data.support_mode;
  const sentHtml = sentimentBar(data.phone, false);

  const header = '<div class="tl-header">'+
    '<div>'+
      '<div class="phone">'+mask(data.phone)+(support?'<span style="background:#ff6b6b;color:#fff;padding:1px 7px;border-radius:4px;font-size:.62rem;margin-left:8px">'+support+'</span>':'')+'</div>'+
      '<div class="name">'+(data.customer_name||'sem nome identificado')+'</div>'+
      '<div class="status">produto atual: '+(data.current_product||'—')+'</div>'+
    '</div>'+
    '<button class="btn-handoff"'+(support==='human_pending'?' disabled':'')+' onclick="doHandoff(\\''+data.phone+'\\')">'+
      (support==='human_pending'?'✅ Em atendimento humano':'🤝 Passar pra vendedora')+
    '</button>'+
  '</div>';

  const sentBox = sentHtml
    ? '<div class="sentiment-summary"><span class="tt">Sentimento</span>'+sentHtml+'</div>'
    : '';

  const items = data.items||[];
  const cartHtml = items.length
    ? '<div class="cart-box"><div class="tt">🛒 Carrinho ('+items.length+')</div>'+
      items.map(i=>'<div class="cart-item">'+esc(i.name||'?')+' '+(i.size?'· '+i.size:'')+' '+(i.quantity?'x'+i.quantity:'')+'</div>').join('')+
      '</div>'
    : '';

  const events = data.events||[];
  const tlHtml = events.length
    ? events.map(e => {
        const sentTag = (e.category==='client' && e.sentiment && e.sentiment!=='NEUTRO')
          ? '<span class="sent-tag" style="background:'+(SENTIMENT[e.sentiment]?.color||'#888')+'22;color:'+(SENTIMENT[e.sentiment]?.color||'#888')+';border:1px solid '+(SENTIMENT[e.sentiment]?.color||'#888')+'44">'+(SENTIMENT[e.sentiment]?.icon||'')+' '+(SENTIMENT[e.sentiment]?.label||e.sentiment)+'</span>'
          : '';
        return '<div class="ev '+e.category+'">'+
               '<div class="t">'+e.time+'</div>'+
               '<div class="ic">'+e.icon+'</div>'+
               '<div class="body"><div class="tx">'+esc(e.text)+'</div>'+sentTag+'</div>'+
               '</div>';
      }).join('')
    : '<div class="empty">Sem eventos registrados</div>';

  document.getElementById('main').innerHTML = header + sentBox + cartHtml + '<div class="timeline">'+tlHtml+'</div>';
  // Rola para o fim automaticamente
  setTimeout(()=>{ const tl=document.querySelector('.timeline'); if(tl) tl.scrollTop=tl.scrollHeight; },50);
}

async function doHandoff(phone) {
  if (!confirm('Passar esse cliente para a vendedora? A Bela vai pausar.')) return;
  const reason = prompt('Motivo (opcional):')||'';
  try {
    const r = await fetch('/api/handoff/'+phone,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason})});
    const d = await r.json();
    d.ok ? toast('✅ Handoff executado · '+d.notifiedAdmins+' vendedora(s) avisada(s)') : toast('Erro: '+(d.error||'?'),true);
    if (d.ok) loadTimeline(phone);
  } catch(e){ toast('Erro: '+e.message,true); }
}
</script>
</body>
</html>`;

// ─── HTTP ─────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(HTML);
    }
    const mS = req.url.match(/^\/api\/session\/(\d+)$/);
    if (req.method === 'GET' && mS) {
      const phone   = mS[1];
      const session = await loadSessionFromSupabase(phone);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        phone,
        customer_name:   session?.customer_name || null,
        items:           session?.items         || [],
        support_mode:    session?.support_mode  || null,
        current_product: session?.current_product || null,
        events:          state.perPhoneEvents[phone] || [],
      }));
    }
    const mH = req.url.match(/^\/api\/handoff\/(\d+)$/);
    if (req.method === 'POST' && mH) {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { reason } = JSON.parse(body || '{}');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(await forceHandoff(mH[1], reason)));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) { res.writeHead(500); res.end('Error: ' + e.message); }
});

// ─── WebSocket broadcast ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

function broadcast() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  const ativos = Object.entries(state.ultimaAtividade)
    .filter(([, ts]) => ts > cutoff).map(([p]) => p);

  const payload = JSON.stringify({
    startedAt:          state.startedAt,
    chatsUnicos:        state.chatsUnicos.size,
    chatsAtivos:        ativos.length,
    mensagensRecebidas: state.mensagensRecebidas,
    chamadasIA:         state.chamadasIA,
    ttsGerados:         state.ttsGerados,
    itensCarrinho:      state.itensCarrinho,
    handoffs:           state.handoffs,
    erros:              state.erros.length,
    ativosArr:          ativos,
    todosArr:           [...state.chatsUnicos].filter(p => !p.includes('@')).sort(),
    sentimentMap:       state.sentimentSummary,
    logFile:            state.logFile,
  });

  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}

wss.on('connection', () => broadcast());
setInterval(broadcast, 2000);

server.listen(PORT, () => {
  console.log(`\n🖥️  Bela Monitor em http://localhost:${PORT}`);
  console.log(`   Log: ${latestLog() || '(aguardando)'}`);
  console.log(`   Gemini Sentiment: ativo`);
  console.log(`   Admins: ${ADMIN_PHONES.length ? ADMIN_PHONES.join(', ') : '(não configurado)'}\n`);
});
