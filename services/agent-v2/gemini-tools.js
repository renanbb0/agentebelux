/**
 * services/agent-v2/gemini-tools.js
 *
 * Wrapper do Gemini SDK com Function Calling nativo habilitado.
 *
 * Diferença do services/gemini.js (V1):
 *   - V1: IA emite tokens em colchetes ([VER_TODOS:x]), parseados via regex.
 *   - V2: IA chama tools nativas via SDK; recebemos `functionCalls` estruturado.
 *
 * REGRA: este módulo NÃO executa nada no mundo real (não envia mensagem,
 * não toca em FSM, não fala com Z-API). Ele só conversa com o Gemini.
 * A execução das tools é responsabilidade de tool-executor.js.
 *
 * Modo de uso típico (shadow):
 *   const { chatWithTools } = require('./agent-v2/gemini-tools');
 *   const { text, functionCalls, raw } = await chatWithTools(history, ctx);
 *   // Em shadow: apenas loga. Em produção (futuro): executa via tool-executor.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const learnings = require('../learnings');
const logger = require('../logger');
const { TOOLS_SCHEMA } = require('./tools');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Mesmo modelo da V1 (escolha do usuário — não trocar sem aprovação).
const MODEL_NAME = 'gemini-3.1-flash-lite-preview';

/**
 * System prompt da V2.
 *
 * Diferenças críticas vs V1:
 *   - NÃO menciona colchetes (a IA não emite mais [VER_TODOS], etc).
 *   - Instrui a chamar tools nativas via Function Calling.
 *   - Reforça liberdade de decisão (princípio "estado é contexto, não prisão").
 *   - Mantém persona, repertório e tom — esses vêm do prompt V1 reaproveitado.
 */
const SYSTEM_PROMPT_V2 = `Você é a Bela, consultora de vendas da Belux Moda Íntima. Responda SEMPRE em português brasileiro, de forma 100% natural e humana via WhatsApp.

━━━━━━━━━━━━━━━━━━━━━━━━
COMO VOCÊ AGE NESTE SISTEMA (V2 — Function Calling)
━━━━━━━━━━━━━━━━━━━━━━━━
Você tem acesso a um conjunto de TOOLS (funções nativas). Quando precisar agir
no mundo (mostrar catálogo, adicionar item, transferir para humano, etc),
CHAME a tool correspondente — não escreva colchetes nem códigos.

Você também pode simplesmente CONVERSAR (responder dúvida, explicar tecido,
calcular preço, perguntar tamanho de forma natural) sem chamar nenhuma tool.

REGRA DE OURO: a tool é a sua MÃO. Você decide se usa, qual usa e quando usa.
O sistema só executa o que você chamar. Se não tem certeza, PERGUNTE em texto.

━━━━━━━━━━━━━━━━━━━━━━━━
PROTOCOLO DE RACIOCÍNIO INTERNO
━━━━━━━━━━━━━━━━━━━━━━━━
Antes de cada resposta, pense em silêncio dentro de <think>...</think>:
• O que essa mensagem sinaliza? (compra / dúvida / objeção / pedido humano?)
• Esse cliente está quente ou frio?
• Qual é o próximo passo que MOVE para a frente?
• Preciso chamar uma tool, ou só responder em texto?
• Se for tool: tenho TODOS os parâmetros, ou preciso perguntar antes?

O bloco <think> NUNCA aparece para o cliente.

━━━━━━━━━━━━━━━━━━━━━━━━
TOM DE VOZ (100% HUMANA)
━━━━━━━━━━━━━━━━━━━━━━━━
- NUNCA: "Olá!", "Com certeza!", "Claro, posso ajudar", "Aqui estão", "Entendido".
- Frases curtas, pontuação leve, emojis discretos (😊 ✨ 🙌 😍).
- Interjeições reais: "Poxa", "Ah, entendi!", "Olha só", "Amiga", "Bom,".
- Lojista B2B: papo reto, carisma sem embromação, foco em fechar pedido.

━━━━━━━━━━━━━━━━━━━━━━━━
REGRAS COMERCIAIS
━━━━━━━━━━━━━━━━━━━━━━━━
- Pedido mínimo atacado: R$ 150,00.
- PIX tem desconto.
- Categorias: Feminino adulto, Masculino adulto, Infantil (fem/masc).

━━━━━━━━━━━━━━━━━━━━━━━━
QUANDO O CLIENTE PEDE HUMANO
━━━━━━━━━━━━━━━━━━━━━━━━
Chame requestHumanHandoff IMEDIATAMENTE. NUNCA insista em vender, NUNCA
ofereça mais catálogo, NUNCA tente "ajudar mais um pouquinho". Respeite o
pedido na hora.`;

/**
 * Conversão de history (igual à V1).
 * Reaproveita a função exportada de services/gemini.js para garantir paridade.
 */
const { toGeminiHistory } = require('../gemini');

/**
 * Chama o Gemini com tools habilitadas.
 *
 * @param {Array} history - histórico [{role, content}, ...] (mesmo formato V1)
 * @param {string|null} catalogContext - contexto do catálogo/FSM
 * @param {object} [opts]
 * @param {string} [opts.nudge] - instrução de sistema prioritária
 * @param {object} [opts.toolConfig] - override do toolConfig do SDK
 * @returns {Promise<{ text: string, functionCalls: Array, raw: object }>}
 */
async function chatWithTools(history, catalogContext, opts = {}) {
  const { nudge = null, toolConfig = null } = opts;

  const nudgeBlock = nudge
    ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━\nCOMANDO DE SISTEMA PRIORITÁRIO\n━━━━━━━━━━━━━━━━━━━━━━━━\n${nudge}\n\n`
    : '';

  const active = await learnings.getActive().catch(() => []);
  const learningsBlock = active.length > 0
    ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━\nAPRENDIZADOS DE CONVERSAS REAIS\n━━━━━━━━━━━━━━━━━━━━━━━━\n${active.map((l, i) => `${i + 1}. ${l}`).join('\n')}`
    : '';

  const systemContent = catalogContext
    ? `${nudgeBlock}${SYSTEM_PROMPT_V2}${learningsBlock}\n\nCONTEXTO DA SESSAO:\n${catalogContext}`
    : `${nudgeBlock}${SYSTEM_PROMPT_V2}${learningsBlock}`;

  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: { parts: [{ text: systemContent }] },
    tools: TOOLS_SCHEMA,
    // toolConfig opcional: permite forçar AUTO/ANY/NONE em testes.
    ...(toolConfig ? { toolConfig } : {}),
    generationConfig: {
      temperature: 0.85,
      maxOutputTokens: 800,
    },
  });

  const geminiHistory = toGeminiHistory(history.slice(0, -1));
  const lastMsg = history[history.length - 1];

  const chatSession = model.startChat({ history: geminiHistory });
  const result = await chatSession.sendMessage(lastMsg.content);

  const response = result.response;
  const text = (response.text() || '').trim();

  // Extrai functionCalls (Function Calling nativo).
  // O SDK expõe via response.functionCalls() — método que retorna array ou undefined.
  let functionCalls = [];
  try {
    const fc = typeof response.functionCalls === 'function'
      ? response.functionCalls()
      : null;
    if (Array.isArray(fc)) functionCalls = fc;
  } catch (err) {
    logger.warn({ err: err.message }, '[V2] Falha ao extrair functionCalls do response');
  }

  // Loga raciocínio interno (mesmo padrão da V1).
  const thinkMatch = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch) {
    logger.info({ v2: true, think: thinkMatch[1].trim() }, '[V2-THINK]');
  }

  return {
    text,
    functionCalls,
    raw: response,
  };
}

module.exports = {
  chatWithTools,
  MODEL_NAME,
  SYSTEM_PROMPT_V2,
};
