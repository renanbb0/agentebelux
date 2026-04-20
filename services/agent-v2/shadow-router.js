/**
 * services/agent-v2/shadow-router.js
 *
 * MODO SOMBRA da Bela V2.
 *
 * O que faz:
 *   - Recebe a MESMA mensagem que a V1 acabou de processar.
 *   - Roda o pipeline V2 (Function Calling) em paralelo.
 *   - LOGA a decisão V2 com tag [V2-SHADOW] para análise comparativa.
 *   - NUNCA envia mensagem ao cliente. NUNCA toca em FSM. NUNCA escreve no Supabase.
 *
 * Por que existe:
 *   - Validar Function Calling em tráfego real, sem risco para a V1.
 *   - Gerar dataset de comparação V1 (tokens regex) vs V2 (tools nativas).
 *   - Detectar regressões cedo (antes do canary).
 *
 * Como ativar:
 *   .env → AGENT_SHADOW_MODE=true
 *
 * Como desativar (kill switch):
 *   .env → AGENT_SHADOW_MODE=false  (default)
 *
 * Princípio crítico:
 *   QUALQUER erro aqui é silenciado. A V2 em sombra NUNCA pode quebrar a V1.
 *   Todo o ponto de chamada deve estar dentro de try/catch no index.js.
 */

const logger = require('../logger');
const { chatWithTools } = require('./gemini-tools');
const { TOOL_TO_LEGACY_ACTION } = require('./tools');

/**
 * Verifica se o modo sombra está habilitado via env.
 */
function isShadowEnabled() {
  return String(process.env.AGENT_SHADOW_MODE || '').toLowerCase() === 'true';
}

/**
 * Roda a V2 em sombra para uma mensagem.
 *
 * @param {object} params
 * @param {string} params.phone - telefone do cliente (anonimizado em logs se preciso)
 * @param {Array}  params.history - mesmo history passado para a V1
 * @param {string|null} params.catalogContext - mesmo contexto da V1
 * @param {object} [params.v1Result] - resultado da V1 para comparação
 *   { action: { type, payload } | null, cleanText: string }
 * @returns {Promise<object|null>} resultado V2 ou null em erro
 */
async function runShadow({ phone, history, catalogContext, v1Result = null }) {
  if (!isShadowEnabled()) return null;

  const startedAt = Date.now();

  try {
    const v2 = await chatWithTools(history, catalogContext);

    const latencyMs = Date.now() - startedAt;

    // Mapeia tools V2 chamadas → ações legacy V1 equivalentes (para diff).
    const v2ToolNames = (v2.functionCalls || []).map(fc => fc.name);
    const v2EquivalentLegacyActions = v2ToolNames
      .map(name => TOOL_TO_LEGACY_ACTION[name] || null)
      .filter(Boolean);

    const v1ActionType = v1Result?.action?.type || null;

    // Diagnóstico: V1 e V2 concordam sobre a "ação principal"?
    let agreement = 'N/A';
    if (v1ActionType && v2EquivalentLegacyActions.length > 0) {
      agreement = v2EquivalentLegacyActions.includes(v1ActionType) ? 'MATCH' : 'DIVERGE';
    } else if (!v1ActionType && v2ToolNames.length === 0) {
      agreement = 'BOTH_TEXT_ONLY';
    } else if (!v1ActionType && v2ToolNames.length > 0) {
      agreement = 'V2_ACTED_V1_TEXT';
    } else if (v1ActionType && v2ToolNames.length === 0) {
      agreement = 'V1_ACTED_V2_TEXT';
    }

    logger.info({
      v2Shadow: true,
      phone,
      latencyMs,
      v2: {
        toolCalls: v2.functionCalls.map(fc => ({ name: fc.name, args: fc.args })),
        textPreview: (v2.text || '').slice(0, 200),
        textLen: (v2.text || '').length,
      },
      v1: v1Result ? {
        actionType: v1ActionType,
        textPreview: (v1Result.cleanText || '').slice(0, 200),
      } : null,
      agreement,
    }, '[V2-SHADOW] decision');

    return {
      text: v2.text,
      functionCalls: v2.functionCalls,
      latencyMs,
      agreement,
    };
  } catch (err) {
    logger.warn({
      v2Shadow: true,
      phone,
      err: err.message,
      stack: err.stack?.split('\n').slice(0, 3).join(' | '),
    }, '[V2-SHADOW] erro silenciado — V1 não foi afetada');
    return null;
  }
}

module.exports = {
  runShadow,
  isShadowEnabled,
};
