/**
 * Gerador de Dataset para Fine-Tuning — Agente Belux
 *
 * Lê `session_archives` e gera JSONL no formato que o Vertex AI / Gemini espera
 * para supervised fine-tuning, já com sanitização de PII (telefones, nomes).
 *
 * READ-ONLY no Supabase. Só escreve arquivos em ./training_data/
 *
 * Uso:
 *   node .agent/scripts/gerar_dataset_finetune.js
 *   node .agent/scripts/gerar_dataset_finetune.js --outcomes=success,handoff
 *   node .agent/scripts/gerar_dataset_finetune.js --since=2026-04-01 --split=0.8
 *   node .agent/scripts/gerar_dataset_finetune.js --min-turns=6 --limit=200
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../../services/supabase');

// ── CLI ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}

const OUTCOMES = (getArg('outcomes', 'success,handoff')).split(',').map(s => s.trim()).filter(Boolean);
const SINCE = getArg('since', null); // ISO date
const SPLIT = parseFloat(getArg('split', '0.8'));
const MIN_TURNS = parseInt(getArg('min-turns', '4'), 10);
const LIMIT = parseInt(getArg('limit', '1000'), 10);
const OUT_DIR = path.join(process.cwd(), 'training_data');
const OUT_BASE = getArg('out-base', `finetune_${new Date().toISOString().slice(0,10).replace(/-/g,'')}`);

// ── Sanitização de PII ──────────────────────────────────────────────────
const RE_PHONE = /\b\d{10,13}\b/g;          // 10-13 dígitos = telefone BR
const RE_CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const RE_CEP = /\b\d{5}-?\d{3}\b/g;

function sanitize(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(RE_CPF, '[CPF]')
    .replace(RE_CEP, '[CEP]')
    .replace(RE_PHONE, '[TELEFONE]');
}

function stripThink(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// ── Converte archive → linha JSONL no formato Gemini ────────────────────
function toFineTuneExample(archive) {
  const history = Array.isArray(archive.history) ? archive.history : [];
  if (history.length < MIN_TURNS) return null;
  if (history[0]?.role !== 'user') return null;

  const messages = [];
  for (const msg of history) {
    if (!msg?.content || !msg?.role) continue;
    if (msg.role === 'system') continue; // Gemini não aceita system em history
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const text = sanitize(stripThink(String(msg.content))).trim();
    if (!text) continue;

    // Mescla consecutivos do mesmo role (Gemini exige alternância)
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.parts[0].text += '\n' + text;
    } else {
      messages.push({ role, parts: [{ text }] });
    }
  }

  if (messages.length < MIN_TURNS) return null;
  // Gemini fine-tune normalmente requer que termine em 'model' (assistente)
  // e comece em 'user'. Descarta se não bater.
  if (messages[0].role !== 'user') return null;
  if (messages[messages.length - 1].role !== 'model') {
    // Se termina em user (sem resposta), remove o último
    messages.pop();
    if (messages.length < MIN_TURNS || messages[messages.length - 1].role !== 'model') return null;
  }

  return {
    messages,
    metadata: {
      outcome: archive.outcome,
      archive_id: archive.id,
      final_fsm_state: archive.final_fsm_state,
      turn_count: messages.length,
      order_total: archive.order_total || null,
    },
  };
}

// ── Shuffle determinístico (semente por archive_id para repetibilidade) ─
function deterministicShuffle(arr) {
  const copy = arr.slice();
  copy.sort((a, b) => ((a.metadata.archive_id * 9301 + 49297) % 233280) -
                      ((b.metadata.archive_id * 9301 + 49297) % 233280));
  return copy;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[dataset] Outcomes: ${OUTCOMES.join(', ')}`);
  console.log(`[dataset] Min turns: ${MIN_TURNS} | Split: ${SPLIT} | Limit: ${LIMIT}`);

  let q = db.supabase
    .from('session_archives')
    .select('*')
    .in('outcome', OUTCOMES)
    .order('archived_at', { ascending: false })
    .limit(LIMIT);
  if (SINCE) q = q.gte('archived_at', SINCE);

  const { data, error } = await q;
  if (error) {
    console.error('[dataset] Erro consultando session_archives:', error.message);
    process.exit(1);
  }

  console.log(`[dataset] ${data.length} arquivos lidos do Supabase.`);

  const examples = [];
  let skipped = 0;
  for (const row of data) {
    const ex = toFineTuneExample(row);
    if (ex) examples.push(ex);
    else skipped++;
  }
  console.log(`[dataset] ${examples.length} exemplos válidos (${skipped} descartados por filtros de qualidade).`);

  if (examples.length === 0) {
    console.log('[dataset] Nada a exportar.');
    return;
  }

  // Split train/val
  const shuffled = deterministicShuffle(examples);
  const splitIdx = Math.floor(shuffled.length * SPLIT);
  const train = shuffled.slice(0, splitIdx);
  const val = shuffled.slice(splitIdx);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const trainPath = path.join(OUT_DIR, `${OUT_BASE}_train.jsonl`);
  const valPath = path.join(OUT_DIR, `${OUT_BASE}_val.jsonl`);

  fs.writeFileSync(trainPath, train.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(valPath, val.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const stats = { train: train.length, val: val.length, total: examples.length };
  const outcomes = examples.reduce((acc, e) => {
    acc[e.metadata.outcome] = (acc[e.metadata.outcome] || 0) + 1;
    return acc;
  }, {});

  console.log(`[dataset] ✅ Train: ${trainPath} (${stats.train} exemplos)`);
  console.log(`[dataset] ✅ Val:   ${valPath} (${stats.val} exemplos)`);
  console.log(`[dataset] Distribuição por outcome: ${JSON.stringify(outcomes)}`);
}

main().catch(err => {
  console.error('[dataset] Falha:', err);
  process.exit(1);
});
