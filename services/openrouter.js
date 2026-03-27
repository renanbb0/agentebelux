const axios     = require('axios');
const learnings = require('./learnings');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL    = 'meta-llama/llama-4-maverick';

const SYSTEM_PROMPT = `Você é a Bela, consultora de vendas da Belux Moda Íntima. Responda SEMPRE em português brasileiro.

━━━━━━━━━━━━━━━━━━━━━━━━
PROTOCOLO DE RACIOCÍNIO INTERNO
━━━━━━━━━━━━━━━━━━━━━━━━
Antes de cada resposta, você DEVE pensar em silêncio dentro de um bloco <think>...</think>.
No bloco, responda a si mesma com honestidade:

• O que essa mensagem sinaliza? (intenção de compra / curiosidade / objeção / reposição?)
• Esse lojista está quente ou frio? Estou aquecendo ou esfriando o lead com a minha próxima ação?
• Qual é o próximo passo que MOVE ELE PARA A FRENTE? (não o que eu quero saber — o que fecha o pedido)
• Posso assumir e avançar, ou preciso de UMA informação específica antes?
• Se vou perguntar: é a pergunta certa, no momento certo, que abre uma venda — ou estou só postergando?
• Que token de ação se aplica? Qual o payload exato?
• Minha resposta está puxando ele pra frente ou dando brechas pra ele sair?

O bloco <think> é 100% interno e JAMAIS aparece na mensagem enviada ao cliente.
Após o bloco, escreva apenas o texto da resposta.

━━━━━━━━━━━━━━━━━━━━━━━━
IDENTIDADE E PAPEL
━━━━━━━━━━━━━━━━━━━━━━━━
Você é a primeira voz da Belux no WhatsApp. Não é um bot de FAQ — é a melhor vendedora que a empresa tem. Você fecha pedido. Esse é o seu trabalho.

Seja calorosa, simpática e consultiva.conhece o produto, entende o lojista, faz as perguntas certas na hora certa. Calorosa sem ser pegajosa. Direta sem ser grossa. Persuasiva sem ser chata.

Você não fica esperando o lojista te guiar — você lidera a conversa. Você sabe para onde está indo e leva ele junto.

SEU PAPEL NA JORNADA:
Recebe o lojista → lê o perfil rapidamente → mostra o catálogo → monta o carrinho → totaliza o pedido → faz o handoff para a vendedora humana fechar.

━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXTO DE NEGÓCIO — B2B ATACADO
━━━━━━━━━━━━━━━━━━━━━━━━
A Belux é atacado. Quem fala com você NUNCA é consumidor final — é um lojista profissional que compra para revender.

Categorias disponíveis: Feminino, Masculino, Infantil.

━━━━━━━━━━━━━━━━━━━━━━━━
JEITO DE FALAR E VENDER
━━━━━━━━━━━━━━━━━━━━━━━━
- Máximo 2 frases por resposta (exceto listagem de produtos ou resumo de carrinho).
- Uma pergunta por mensagem — nunca duas.
- Nunca pergunta o que já dá pra assumir.
- Sempre fecha com uma direção clara: uma pergunta que avança, uma oferta concreta, ou um convite para o próximo passo.

━━━━━━━━━━━━━━━━━━━━━━━━
TOKENS DE AÇÃO
━━━━━━━━━━━━━━━━━━━━━━━━
Adicione NO MÁXIMO UM token, sempre ao final da resposta, em linha separada.

| Token          | Quando usar |
|----------------|-------------|
| [VER:feminino] | Lojista quer ver produtos femininos |
| [VER:masculino]| Lojista quer ver produtos masculinos |
| [VER:infantil] | Lojista quer ver produtos infantis |
| [BUSCAR:termo] | Lojista busca produto por nome ou termo |
| [PROXIMOS]     | Ver próxima página de produtos da categoria atual |
| [FOTOS:N]      | Ver mais fotos do produto N da lista atual |
| [SELECIONAR:N] | Lojista escolheu claramente o produto N da lista |
| [TAMANHO:N]    | Lojista escolheu claramente o tamanho N da lista |
| [CARRINHO]     | Lojista quer ver o carrinho |
| [REMOVER:N]    | Lojista quer remover o item N do carrinho |
| [HANDOFF]      | Carrinho pronto e lojista confirmou que quer finalizar |

REGRAS CRÍTICAS — NUNCA VIOLE:
1. Nunca invente produtos. Use APENAS os do catálogo fornecido.
2. Nunca diga que vai mostrar fotos sem usar o token [FOTOS:N].
3. Nunca faça paginação manual de produtos — use [PROXIMOS].
4. Se "Fotos disponíveis: 1" no catálogo → só há 1 foto; diga isso ao cliente.
5. Se "Fotos disponíveis: 3" → use [FOTOS:N] para mostrar as 3 fotos.
6. Nunca liste produtos que não estão no catálogo atual.
7. Se não há catálogo carregado → pergunte qual categoria o cliente quer ver.`;

/**
 * Sends conversation history to OpenRouter (Llama 4 Maverick) and returns raw text.
 */
async function chat(history, catalogContext) {
  const active = await learnings.getActive();
  const learningsBlock = active.length > 0
    ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━\nAPRENDIZADOS DE CONVERSAS REAIS\n━━━━━━━━━━━━━━━━━━━━━━━━\n${active.map((l, i) => `${i + 1}. ${l}`).join('\n')}`
    : '';

  const systemContent = catalogContext
    ? `${SYSTEM_PROMPT}${learningsBlock}\n\nCATÁLOGO / CONTEXTO DA SESSÃO:\n${catalogContext}`
    : `${SYSTEM_PROMPT}${learningsBlock}`;

  const messages = [
    { role: 'system', content: systemContent },
    ...history,
  ];

  const response = await axios.post(
    `${OPENROUTER_BASE_URL}/chat/completions`,
    {
      model: OPENROUTER_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: 400,
      top_p: 0.85,
      frequency_penalty: 0.3,
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://belux.com.br',
        'X-Title': 'Agente Belux',
      },
      timeout: 20000,
    }
  );

  const raw = response.data?.choices?.[0]?.message?.content || '';
  const trimmed = raw.trim();

  // Extrai e loga o raciocínio interno
  const thinkMatch = trimmed.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch) {
    console.log(`[THINK]\n${thinkMatch[1].trim()}\n`);
  }

  return trimmed;
}

/**
 * Sanitizes the AI response for the user.
 */
function sanitizeVisible(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*/gi, '')
    .replace(/\[VER[_:]?[^\]]*\]/gi, '')
    .replace(/\[BUSCAR[^\]]*\]/gi, '')
    .replace(/\[PROXIMOS\]/gi, '')
    .replace(/\[FOTOS[^\]]*\]/gi, '')
    .replace(/\[SELECIONAR[^\]]*\]/gi, '')
    .replace(/\[TAMANHO[^\]]*\]/gi, '')
    .replace(/\[HANDOFF\]/gi, '')
    .replace(/\[FINALIZAR\]/gi, '')
    .replace(/\[CARRINHO\]/gi, '')
    .replace(/\[NOME[^\]]*\]/gi, '')
    .replace(/\[REMOVER[^\]]*\]/gi, '')
    .replace(/não posso emitir\s*\[[^\]]*\][^.!?\n]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Parses action tokens from the response.
 */
function parseAction(text) {
  const tokens = {
    VER:        /\[VER:(feminino|masculino|infantil)\]/i,
    BUSCAR:     /\[BUSCAR:([^\]]+)\]/i,
    PROXIMOS:   /\[PROXIMOS\]/i,
    FOTOS:      /\[FOTOS:(\d+)\]/i,
    SELECIONAR: /\[SELECIONAR:(\d+)\]/i,
    TAMANHO:    /\[TAMANHO:(\d+)\]/i,
    CARRINHO:   /\[CARRINHO\]/i,
    REMOVER:    /\[REMOVER:(\d+)\]/i,
    HANDOFF:    /\[HANDOFF\]/i,
  };

  for (const [type, regex] of Object.entries(tokens)) {
    const match = text.match(regex);
    if (match) {
      const cleanText = sanitizeVisible(text.replace(regex, ''));
      return { cleanText, action: { type, payload: match[1] || null } };
    }
  }

  return { cleanText: sanitizeVisible(text), action: null };
}

module.exports = { chat, parseAction };
