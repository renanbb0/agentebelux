/**
 * Curador de Learnings — extrai insights de conversas de sucesso via Gemini
 * e popula a tabela `learnings` (hoje dormente).
 *
 * Os insights curados são injetados automaticamente no SYSTEM prompt da Bela em
 * services/gemini.js via learnings.getActive() — top 10 por `uses DESC`.
 *
 * Uso:
 *   node .agent/scripts/curador_learnings.js
 *   node .agent/scripts/curador_learnings.js --limit=20
 *   node .agent/scripts/curador_learnings.js --since=2026-04-01 --outcomes=success,handoff
 *   node .agent/scripts/curador_learnings.js --dry-run   (só imprime, não grava)
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

const LIMIT = parseInt(getArg('limit', '10'), 10);
const SINCE = getArg('since', null);
const OUTCOMES = (getArg('outcomes', 'success')).split(',').map(s => s.trim()).filter(Boolean);
const DRY = hasFlag('dry-run');
const MODEL_ID = getArg('model', 'gemini-2.5-flash');

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY não definido no .env');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Prompt de extração de insights ──────────────────────────────────────
const CURATOR_PROMPT = `Você é um analista especialista em técnicas de venda B2B via WhatsApp.

Abaixo está a transcrição de uma conversa real que resultou em uma venda bem-sucedida entre a vendedora "Bela" e um(a) lojista de moda íntima.

Sua tarefa: extrair de 1 a 3 PADRÕES ou TÉCNICAS concretas que a Bela aplicou e que contribuíram para o fechamento. Cada insight deve:
- Ter UMA frase curta (máx 20 palavras).
- Ser ACIONÁVEL (algo que outra vendedora pode replicar amanhã).
- Ser ESPECÍFICO (não "foi simpática"; mas sim "respondeu com o tamanho já separado quando o cliente mencionou a grade").
- NÃO conter dados pessoais (nomes, telefones, produtos específicos por nome próprio).
- Começar com verbo no infinitivo ou gerúndio.

Formato da resposta: **apenas** uma linha por insight, sem numeração, sem bullet, sem explicação adicional.

Exemplos de BONS insights:
- Oferecer ajuda com a grade quando cliente menciona tamanhos soltos sem pedir expressamente
- Confirmar valor antes de chamar atendente para evitar frustração com pedido mínimo
- Usar quote-reply do cliente para resolver produto sem fazer "qual produto?"

Se a conversa não tiver técnica clara, retorne apenas a palavra: NENHUM

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

async function extractInsights(history) {
  const transcript = renderHistoryForPrompt(history);
  if (transcript.length < 50) return [];

  const model = genAI.getGenerativeModel({
    model: MODEL_ID,
    generationConfig: { temperature: 0.4, maxOutputTokens: 300 },
  });

  const res = await model.generateContent(CURATOR_PROMPT + transcript);
  const text = res?.response?.text?.() || '';
  if (/^nenhum\s*$/i.test(text.trim())) return [];

  return text.split(/\r?\n/)
    .map(l => l.replace(/^[-*\d.\s]+/, '').trim())
    .filter(l => l.length > 10 && l.length < 200);
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

  let totalInsights = 0;
  let processed = 0;

  for (const arc of archives) {
    processed++;
    try {
      const insights = await extractInsights(arc.history || []);
      if (insights.length === 0) {
        console.log(`  [${processed}/${archives.length}] archive=${arc.id} — nenhum insight extraído.`);
        continue;
      }
      console.log(`  [${processed}/${archives.length}] archive=${arc.id} → ${insights.length} insight(s):`);
      for (const ins of insights) {
        console.log(`    • ${ins}`);
        if (!DRY) {
          try { await learnings.addLearning(ins); totalInsights++; }
          catch (e) { console.warn(`    ⚠ falha ao gravar: ${e.message}`); }
        } else {
          totalInsights++;
        }
      }
    } catch (err) {
      console.warn(`  [${processed}/${archives.length}] archive=${arc.id} falhou: ${err.message}`);
    }
    // Rate limiting leve
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`\n[curador] ✅ Concluído. ${processed} conversas processadas, ${totalInsights} insights ${DRY ? 'simulados' : 'gravados'}.`);
  if (!DRY) {
    console.log(`[curador] Os top 10 por 'uses' já serão injetados no próximo chat() da Bela via services/gemini.js.`);
  }
}

main().catch(err => {
  console.error('[curador] Falha:', err);
  process.exit(1);
});
