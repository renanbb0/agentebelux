/**
 * Analyze with AI — manda sessions.jsonl para Gemini e gera relatório qualitativo
 *
 * Uso: node scripts/analyze-with-ai.js
 * Saída: RELATORIO_QUALITATIVO.md
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const ROOT     = path.resolve(__dirname, '..');
const SESS_IN  = path.join(ROOT, 'logs', 'parsed', 'sessions.jsonl');
const REPORT   = path.join(ROOT, 'RELATORIO_QUALITATIVO.md');
const MODEL    = 'gemini-2.5-flash';

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY ausente em .env');
  process.exit(1);
}

if (!fs.existsSync(SESS_IN)) {
  console.error('❌ sessions.jsonl não existe. Rode antes: node scripts/extract-report.js');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL });

function loadSessions() {
  const raw = fs.readFileSync(SESS_IN, 'utf8').trim();
  return raw.split('\n').map(l => JSON.parse(l));
}

function compactSession(s) {
  // mantém só o essencial pra caber no prompt
  return {
    phone: s.phone.slice(0, 4) + '****' + s.phone.slice(-4),
    duration_min: Math.round((s.lastMs - s.startMs) / 60000),
    msgs_received: s.msgsReceived,
    msgs_sent: s.msgsSent,
    ai_calls: s.aiCalls,
    ai_failures: s.aiFailures,
    cart_adds: s.cartAdds,
    fsm_events: s.fsmEvents,
    handoff: s.handoff,
    handoff_trigger: s.handoffTrigger,
    auto_escalation: s.autoEscalation,
    customer_name: s.customerName,
    semantic_intents: s.semanticIntents,
    ai_actions: s.aiActions,
    errors: s.errors.slice(0, 5),
    // timeline compacta - só msgs e decisões da IA
    timeline: s.timeline
      .filter(t => /\[MSG\] Received|\[AI\] Decisão|\[Intercept\]|\[FSM\] qty_|\[Handoff\]|\[AutoEscalation\]/.test(t.marker))
      .slice(0, 60)
      .map(t => `${t.ts} ${t.marker} ${t.preview}`),
  };
}

const PROMPT = `Você é um arquiteto sênior de IA conversacional analisando dados reais de produção de um bot de vendas WhatsApp B2B (Belux Moda Íntima — lojistas comprando atacado).

Recebi 28 sessões reais de hoje (~11h de operação). Quero um relatório qualitativo em português brasileiro que ajude a equipe de produto a tomar decisões.

DADOS-CHAVE QUE JÁ SABEMOS (para você não repetir):
- Taxa de handoff: 25%
- Taxa de conversão (sessão com item no carrinho): 3.6%
- customerName: null em 100% das sessões (gap conhecido)
- Top action errada: VER_TODOS sendo retornada para perguntas consultivas
- Erro técnico do TTS (rate limit 429) já mapeado

O QUE EU QUERO DE VOCÊ:

## 1. Padrões de Falha
Olhando timeline e ações, identifique 3-5 padrões claros que se repetem em múltiplas sessões. Para cada padrão:
- O que aconteceu (descrição com exemplos de telefones mascarados)
- Em quantas sessões aparece
- Causa raiz provável (FSM? IA? prompt? falta de KB?)

## 2. Sessões críticas que merecem atenção manual
Liste até 5 sessões com observações específicas (use o telefone mascarado para referência). Foque nas que duraram muito sem converter, ou tiveram handoff de cliente.

## 3. Gap de conversão
Por que tivemos 25% de handoff e apenas 3.6% de conversão? O que as outras 70% das sessões fizeram durante o tempo que ficaram conectadas? (use evidência da timeline)

## 4. Quick Wins
Liste 3 mudanças no código/prompt que teriam impacto imediato baseadas APENAS nos dados que você está vendo. Cite o phone mascarado da sessão que justifica cada quick win.

## 5. Insights inesperados
O que esses dados mostraram que você NÃO esperaria de antemão? (algo contraintuitivo, surpreendente, ou que muda como devemos pensar a Bela)

REGRAS:
- Use markdown bem formatado (## ### tabelas)
- Cite telefones mascarados quando der exemplo
- Seja específico, não genérico ("a IA precisa melhorar" não vale)
- Quando algo for hipótese, marque como hipótese
- Tamanho ideal: 600-1000 palavras

DADOS DAS SESSÕES (JSON):

`;

async function main() {
  console.log('📥 Carregando sessions.jsonl...');
  const sessions = loadSessions().map(compactSession);
  console.log(`   ${sessions.length} sessões carregadas`);

  const payload = JSON.stringify(sessions, null, 2);
  console.log(`📦 Payload: ${(payload.length / 1024).toFixed(1)} KB`);

  console.log(`🤖 Chamando ${MODEL}...`);
  const t0 = Date.now();
  const result = await model.generateContent(PROMPT + payload);
  const text = result.response.text();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✓ Resposta em ${elapsed}s (${text.length} chars)`);

  const final = `# Relatório Qualitativo — Análise IA das Sessões de Produção

**Gerado em:** ${new Date().toLocaleString('pt-BR')}
**Modelo:** ${MODEL}
**Sessões analisadas:** ${sessions.length}
**Origem:** \`logs/parsed/sessions.jsonl\`

---

${text}

---

*Este relatório foi gerado automaticamente pelo \`scripts/analyze-with-ai.js\`.*
*Para o relatório quantitativo, ver \`RELATORIO_PRODUCAO.md\`.*
`;

  fs.writeFileSync(REPORT, final);
  console.log(`📝 Relatório → ${path.relative(ROOT, REPORT)}`);
}

main().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
