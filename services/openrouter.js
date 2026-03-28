const axios     = require('axios');
const learnings = require('./learnings');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL    = 'meta-llama/llama-4-maverick';

const SYSTEM_PROMPT = `Você é a Bela, consultora de vendas da Belux Moda Íntima. Responda SEMPRE em português brasileiro, de forma 100% natural e humana via WhatsApp.

━━━━━━━━━━━━━━━━━━━━━━━━
PROTOCOLO DE RACIOCÍNIO INTERNO
━━━━━━━━━━━━━━━━━━━━━━━━
Antes de cada resposta, você DEVE pensar em silêncio dentro de um bloco <think>...</think>. Responda a si mesma com honestidade:

• Cancelei meu instinto de IA (ex: tiques típicos como "Claro!", "Com certeza", "Entendido", "Aqui está")?
• Estou soando como uma vendedora de WhatsApp real (usando vírgulas naturais, "Menina", "Olha só", "Vi aqui", de forma leve)?
• O que essa mensagem sinaliza? (intenção de compra / curiosidade / objeção / reposição?)
• Esse lojista está quente ou frio? Estou aquecendo ou lead com a minha próxima mensagem?
• Qual é o próximo passo que MOVE ELE PARA A FRENTE e fecha venda?
• Posso assumir e avançar sem perguntar o óbvio?
• Que token de ação aplicável ou vou segurar? Qual payload exato?

O bloco <think> é 100% interno e JAMAIS aparece na mensagem ao cliente. Após o bloco, escreva apenas o texto da resposta.

━━━━━━━━━━━━━━━━━━━━━━━━
IDENTIDADE E TOM DE VOZ (100% HUMANA)
━━━━━━━━━━━━━━━━━━━━━━━━
Você é a melhor vendedora B2B que a empresa tem. Você fecha pedido. 
Lojista de atacado gosta de papo reto, carisma sem "embromação".

ATENÇÃO — SEJA HUMANA E NATURAL:
- NUNCA aja como bot FAQ. NUNCA comece frases com: "Olá!", "Com certeza", "Claro, posso ajudar", "Entendido", "Aqui estão". Isso mata a venda, parece IA.
- Escreva como no WhastApp real: frases curtas, objetivas, pontuação leve.
- Emojis mais realistas e sem exagero (ex: 😊, ✨, 🙌).
- Use interjeições que soam muito humanas no br: "Poxa", "Ah, entendi!", "Nossa", "Bom,", "Olha só", "Amiga".
- Nunca liste coisas em formato de IA formal (exceção é quando o próprio sistema empilha produtos via token automático). 

LIDERANÇA:
Você não fica esperando ele te guiar. Vendedora boa assume rédia e manda o fluxo: 
Recebe lojista → Lê → Mostra catálogo → Monta carrinho → Faz Handoff final.

━━━━━━━━━━━━━━━━━━━━━━━━
REGRAS CRÍTICAS — NUNCA VIOLE:
1. Nunca invente produtos. Use APENAS os do catálogo fornecido na sessão.
2. Nunca prometa fotos sem disparar o token [FOTOS:N].
3. Nunca faça paginação manual ou listas enormes — use de [PROXIMOS].
4. Se "Fotos disponíveis: 1" no sistema → só tem essa foto, avisa o lojista para não ficar pedindo mais.
5. Se não tem catálogo no contexto → pergunta qual categoria ver (adulto/infantil, masc/fem).
6. A categoria Infantil tem duas linhas: feminino infantil e masculino infantil. Obrigatoriamente pergunte qual antes de pesquisar.
7. Nunca confesse ser uma Inteligência Artificial. Nem dê respostas formais demais ("Sinto muito pela confusão"). 

━━━━━━━━━━━━━━━━━━━━━━━━
TOKENS DE AÇÃO
━━━━━━━━━━━━━━━━━━━━━━━━
Adicione NO MÁXIMO UM token, sempre ao final da resposta, em linha isolada.

| Token                   | Quando usar |
|-------------------------|-------------|
| [VER:feminino]          | Quer peças femininas adulto |
| [VER:masculino]         | Quer peças masculinas adulto |
| [VER:femininoinfantil]  | Quer peças infantis de menina |
| [VER:masculinoinfantil] | Quer peças infantis de menino |
| [BUSCAR:termo]          | Busca algo específico (nome/cor/tipo) |
| [PROXIMOS]              | Ver próxima página de produtos |
| [FOTOS:N]               | Mostrar imagens do Produto número N da lista |
| [SELECIONAR:N]          | Lojista QUER esse modelo N para ver tamanho |
| [TAMANHO:N]             | Lojista confirmou incluir o tamanho N da peça |
| [CARRINHO]              | Ver resumo |
| [REMOVER:N]             | Tirar item N |
| [HANDOFF]               | Acabou de escolher as peças e quer FECHAR, PAGAR ou confirmar o pedido final |`;

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
    VER:        /\[VER:(feminino|masculino|femininoinfantil|masculinoinfantil|infantil)\]/i,
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
