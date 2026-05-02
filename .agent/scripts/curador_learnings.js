/**
 * Curador de Learnings — extrai insights de conversas reais via Gemini
 * e popula a tabela `learnings`.
 *
 * Os insights curados são injetados automaticamente no SYSTEM prompt da Bela em
 * services/gemini.js via learnings.getActive() — top 10 por `uses DESC`.
 *
 * Uso:
 *   node .agent/scripts/curador_learnings.js
 *   node .agent/scripts/curador_learnings.js --limit=20
 *   node .agent/scripts/curador_learnings.js --since=2026-04-01 --outcomes=success,handoff
 *   node .agent/scripts/curador_learnings.js --dry-run   (só imprime, não grava)
 *
 * Quality gates aplicados (v2):
 *   - maxOutputTokens: 800 (evita truncamento do Gemini)
 *   - Anti-truncamento: rejeita insights que terminam em preposição/conjunção/artigo/pontuação
 *   - Tamanho mínimo: 30 chars
 *   - Verbo inicial: primeiro token deve ser infinitivo (-ar/-er/-ir) ou gerúndio (-ando/-endo/-indo)
 *   - Dedup intra-rodada: normalizado (lowercase + sem acentos + sem pontuação) primeiros 60 chars
 *   - Weighting por outcome: success → addLearning() x3 (uses=3), handoff → x1
 */

require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../../services/supabase');
const learnings = require('../../services/learnings');

// ── CLI ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
function hasFlag(name) { return args.includes(`--${name}`); }

const LIMIT    = parseInt(getArg('limit', '10'), 10);
const SINCE    = getArg('since', null);
const OUTCOMES = (getArg('outcomes', 'success')).split(',').map(s => s.trim()).filter(Boolean);
const DRY      = hasFlag('dry-run');
const MODEL_ID = getArg('model', 'gemini-2.5-flash');

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY não definido no .env');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Prompt de extração de insights ──────────────────────────────────────
const CURATOR_PROMPT = `Você é um analista especialista em técnicas de venda B2B via WhatsApp.

Abaixo está a transcrição de uma conversa real entre a vendedora "Bela" e um(a) lojista de moda íntima.

Sua tarefa: extrair de 1 a 3 PADRÕES ou TÉCNICAS concretas que a Bela aplicou. Cada insight deve:
- Ter UMA frase COMPLETA (não corte no meio — termine a ideia).
- Ser curto (máx 20 palavras), mas sem truncamento.
- Ser ACIONÁVEL (algo que outra vendedora pode replicar amanhã).
- Ser ESPECÍFICO (não "foi simpática"; mas sim "respondeu com o tamanho já separado quando o cliente mencionou a grade").
- NÃO conter dados pessoais (nomes, telefones, produtos específicos por nome próprio).
- Começar com verbo no INFINITIVO (ex: "Oferecer", "Confirmar", "Usar") ou GERÚNDIO (ex: "Oferecendo", "Confirmando").

Formato da resposta: **apenas** uma linha por insight, sem numeração, sem bullet, sem explicação adicional.
Cada linha deve ser uma frase gramaticalmente completa — nunca termine com preposição, artigo ou vírgula.

Exemplos de BONS insights:
Oferecer ajuda com a grade quando cliente menciona tamanhos soltos sem pedir expressamente
Confirmar valor antes de chamar atendente para evitar frustração com pedido mínimo
Usar quote-reply do cliente para resolver produto sem precisar perguntar qual produto

Se a conversa não tiver técnica clara a extrair, retorne apenas a palavra: NENHUM

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRANSCRIÇÃO:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

function renderHistoryForPrompt(history) {
  return history
    .filter(m => m?.role && m?.content)
    .map(m => {
      const who = m.role === 'assistant' ? 'Bela' : m.role === 'user' ? 'Lojista' : 'Sistema';
      const text = String(m.content).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      return text ? `${who}: ${text}` : null;
    })
    .filter(Boolean)
    .join('\n');
}

// ── Quality Gates ────────────────────────────────────────────────────────

// (b) Palavras que indicam truncamento se forem a última da frase
const TRUNCATION_WORDS = /\b(a|de|em|para|com|por|sem|sob|sobre|e|ou|que|como|mas|o|os|as|um|uma|ao|dos|das|no|na|nos|nas|do|da|se|ao|à|após|antes|mediante|conforme|durante)$/i;
const TRUNCATION_PUNCT = /[,;:\-–]\s*$/;

// (d) Verbo inicial: termina em -ar/-er/-ir ou -ando/-endo/-indo
const VERB_INITIAL = /^[\wÀ-ž]+(ar|er|ir|ando|endo|indo)\b/i;

// (e) Normalização para dedup intra-rodada
function normalizeForDedup(s) {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip acentos
    .replace(/[^a-z0-9 ]/g, '')                        // strip pontuação
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// (f-extra) Fragmento mid-word: consonantes que raramente terminam palavras em português
// Captura stems truncados como "expand" (d), "inform" precede -ar mas termina fora do esperado
const FRAGMENT_ENDING = /[bdfgjkpqtvx]$/i;

function passesQualityGates(insight) {
  // (c) Tamanho mínimo 30 chars
  if (insight.length < 30) {
    return { ok: false, reason: `muito curto (${insight.length} chars, mín 30)` };
  }

  // (b) Anti-truncamento — termina com palavra/pontuação de truncamento
  if (TRUNCATION_WORDS.test(insight)) {
    return { ok: false, reason: 'truncado — termina com preposição/artigo/conjunção' };
  }
  if (TRUNCATION_PUNCT.test(insight)) {
    return { ok: false, reason: 'truncado — termina com pontuação' };
  }

  // (d) Verbo inicial
  if (!VERB_INITIAL.test(insight)) {
    return { ok: false, reason: 'não começa com verbo no infinitivo/gerúndio' };
  }

  // (g) Fragmento mid-word — última palavra termina em consonante atípica para português
  const lastWord = insight.split(/\s+/).pop() || '';
  const lastWordClean = lastWord.replace(/[.!?'"]/g, '');
  if (FRAGMENT_ENDING.test(lastWordClean) && lastWordClean.length <= 8) {
    return { ok: false, reason: `possível fragmento mid-word ("${lastWord}")` };
  }

  return { ok: true };
}

// ── Extração via Gemini ──────────────────────────────────────────────────
async function extractInsights(history) {
  const transcript = renderHistoryForPrompt(history);
  if (transcript.length < 50) return [];

  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    generationConfig: { temperature: 0.4, maxOutputTokens: 800 }, // era 300 → mais espaço pra terminar a frase
  });

  const res = await model.generateContent(CURATOR_PROMPT + transcript);
  const text = res?.response?.text?.() || '';
  if (/^nenhum\s*$/i.test(text.trim())) return [];

  return text.split(/\r?\n/)
    .map(l => l.replace(/^[-*\d.\s]+/, '').trim())
    .filter(l => l.length > 0);
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[curador] Outcomes: ${OUTCOMES.join(', ')} | Limit: ${LIMIT} | Model: ${MODEL_ID}${DRY ? ' | DRY-RUN' : ''}`);

  let q = db.supabase
    .from('session_archives')
    .select('id, phone, outcome, archived_at, history')
    .in('outcome', OUTCOMES)
    .order('archived_at', { ascending: false })
    .limit(LIMIT);
  if (SINCE) q = q.gte('archived_at', SINCE);

  const { data: archives, error } = await q;
  if (error) {
    console.error('[curador] Erro consultando session_archives:', error.message);
    process.exit(1);
  }

  console.log(`[curador] ${archives.length} conversas para processar.`);

  let totalInsights   = 0;
  let totalDescartados = 0;
  let processed       = 0;
  const seenThisRun   = new Set(); // (e) dedup intra-rodada

  for (const arc of archives) {
    processed++;
    try {
      const rawInsights = await extractInsights(arc.history || []);

      if (rawInsights.length === 0) {
        console.log(`  [${processed}/${archives.length}] archive=${arc.id} — nenhum insight extraído.`);
        await new Promise(r => setTimeout(r, 400));
        continue;
      }

      const accepted = [];
      for (const ins of rawInsights) {
        // (b)(c)(d) Quality gates
        const { ok, reason } = passesQualityGates(ins);
        if (!ok) {
          console.log(`    [descartado: ${reason}] "${ins}"`);
          totalDescartados++;
          continue;
        }

        // (e) Dedup intra-rodada
        const key = normalizeForDedup(ins);
        if (seenThisRun.has(key)) {
          console.log(`    [descartado: duplicata nesta rodada] "${ins}"`);
          totalDescartados++;
          continue;
        }
        seenThisRun.add(key);
        accepted.push(ins);
      }

      if (accepted.length === 0) {
        const total = rawInsights.length;
        console.log(`  [${processed}/${archives.length}] archive=${arc.id} — ${total} extraído(s), todos descartados.`);
      } else {
        console.log(`  [${processed}/${archives.length}] archive=${arc.id} [${arc.outcome}] → ${accepted.length} insight(s):`);
        for (const ins of accepted) {
          console.log(`    • ${ins}`);
          if (!DRY) {
            try {
              await learnings.addLearning(ins);
              // (f) Weighting: success → +2 chamadas extras (total uses=3)
              if (arc.outcome === 'success') {
                await learnings.addLearning(ins);
                await learnings.addLearning(ins);
              }
              totalInsights++;
            } catch (e) {
              console.warn(`    ⚠ falha ao gravar: ${e.message}`);
            }
          } else {
            totalInsights++;
          }
        }
      }
    } catch (err) {
      console.warn(`  [${processed}/${archives.length}] archive=${arc.id} falhou: ${err.message}`);
    }
    // Rate limiting leve
    await new Promise(r => setTimeout(r, 400));
  }

  const suffix = DRY ? 'simulados' : 'gravados';
  console.log(`\n[curador] ✅ Concluído. ${processed} conversas processadas, ${totalInsights} insights ${suffix}, ${totalDescartados} descartados.`);
  if (!DRY) {
    console.log(`[curador] Os top 10 por 'uses' já serão injetados no próximo chat() da Bela via services/gemini.js.`);
  }
}

main().catch(err => {
  console.error('[curador] Falha:', err);
  process.exit(1);
});
