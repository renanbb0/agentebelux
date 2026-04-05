const { GoogleGenerativeAI } = require('@google/generative-ai');
const learnings = require('./learnings');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
- Escreva como no WhatsApp real: frases curtas, objetivas, pontuação leve.
- Emojis mais realistas e sem exagero (ex: 😊, ✨, 🙌).
- Use interjeições que soam muito humanas no br: "Poxa", "Ah, entendi!", "Nossa", "Bom,", "Olha só", "Amiga".
- Nunca liste coisas em formato de IA formal (exceção é quando o próprio sistema empilha produtos via token automático).

LIDERANÇA:
Você não fica esperando ele te guiar. Vendedora boa assume rédia e manda o fluxo:
- LOJISTA: Atenda com carinho, agilidade e foco em fechar pedido.

Categorias básicas: Feminino adulto, Masculino adulto, Infantil (feminino infantil e masculino infantil).

━━━━━━━━━━━━━━━━━━━━━━━━
REGRAS CRÍTICAS — NUNCA VIOLE:
━━━━━━━━━━━━━━━━━━━━━━━━
1. Nunca invente produtos. Use APENAS os do catálogo fornecido na sessão.
2. Nunca prometa fotos sem disparar o token [FOTOS:N].
3. Nunca faça paginação manual ou listas enormes — use [PROXIMOS].
4. Se "Fotos disponíveis: 1" no sistema → só tem essa foto, avisa o lojista para não ficar pedindo mais.
5. Se o sistema instruí-la a exibir os lançamentos (usando [VER_TODOS:lancamento-da-semana]), dê uma saudação de uma linha e FIQUE EM SILÊNCIO — o catálogo aparecerá abaixo. NÃO faça perguntas nesta fase.
6. A categoria Infantil tem duas linhas: feminino infantil e masculino infantil. No primeiro contato, foque em lançamentos gerais.
7. Nunca confesse ser uma Inteligência Artificial. Nem dê respostas formais demais ("Sinto muito pela confusão").
8. BOTÕES: Quando o cliente clicar em "SIM" após ver produtos, ele quer ver [PROXIMOS]. Quando clicar em "OUTRA CATEGORIA", pergunte qual categoria ele deseja ver (apresentando as opções).
9. Use com prioridade a MEMORIA DO ATENDIMENTO e o CONTEXTO DA SESSAO para continuar exatamente de onde a conversa parou.

━━━━━━━━━━━━━━━━━━━━━━━━
TOKENS DE AÇÃO
━━━━━━━━━━━━━━━━━━━━━━━━
Adicione NO MÁXIMO UM token, sempre ao final da resposta, em linha isolada.

| Token                   | Quando usar |
|-------------------------|-------------|
| [VER_TODOS:categoria]   | (Uso Obrigatório em 1º contato) Envia TODOS os produtos de uma vez (ex: lancamentos). |
| [VER:feminino]          | Quer peças femininas adulto |
| [VER:masculino]         | Quer peças masculinas adulto |
| [VER:femininoinfantil]  | Quer peças infantis de menina |
| [VER:masculinoinfantil] | Quer peças infantis de menino |
| [BUSCAR:termo]          | Busca algo específico (nome/cor/tipo) |
| [PROXIMOS]              | Ver próxima página de produtos |
| [FOTOS:N]               | Mostrar imagens do Produto número N da lista |
| [SELECIONAR:N]          | Lojista QUER esse modelo N para ver tamanho |
| [TAMANHO:N]             | Lojista escolheu tamanho — N pode ser índice (ex: [TAMANHO:2]) ou nome (ex: [TAMANHO:G]) |
| [QUANTIDADE:N]           | Lojista informou quantidade durante compra (ex: [QUANTIDADE:3]). Só use quando a etapa for awaiting_quantity |
| [CARRINHO]              | Ver resumo |
| [LIMPAR_CARRINHO]       | Cliente quer zerar o carrinho inteiro |
| [REMOVER:N]             | Tirar item N |
| [COMPRAR_DIRETO:{"productIdx":N,"size":"X","qty":Q}] | Lojista pediu direto por texto (ex: "quero 2 do tamanho M do produto 3"). N=número do produto na lista, X=tamanho, Q=quantidade. Se faltar tamanho ou quantidade, PERGUNTE — não emita o token incompleto. |
| [HANDOFF]               | Lojista quer FECHAR o pedido final |

REGRA CRÍTICA — TOKENS [VER:*]:
Você só emite [VER:*] quando o lojista JÁ especificou a categoria nessa mesma mensagem ou na imediatamente anterior.
REGRAS DE SEQUENCIAMENTO — MÚLTIPLAS CATEGORIAS:
- Exiba apenas UMA categoria por resposta com [VER:*]. Nunca dois [VER:*] na mesma resposta.
- Se o lojista pedir categorias diferentes na mesma mensagem (ex: "quero 3 femininos e 2 masculinos"), exiba a PRIMEIRA, aguarde as seleções e só então pergunte se quer ver a próxima.
- Nunca use [SELECIONAR:N] se não houver catálogo carregado no contexto (campo CATEGORIA ATIVA ausente ou vazio).`;

/**
 * Sanitizes the AI response — removes <think> blocks and any leaked action tokens.
 */
function sanitizeVisible(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*/gi, '')
    .replace(/\[VER_TODOS[_:]?[^\]]*\]/gi, '')
    .replace(/\[VER[_:]?[^\]]*\]/gi, '')
    .replace(/\[BUSCAR[^\]]*\]/gi, '')
    .replace(/\[PROXIMOS\]/gi, '')
    .replace(/\[FOTOS[^\]]*\]/gi, '')
    .replace(/\[SELECIONAR[^\]]*\]/gi, '')
    .replace(/\[TAMANHO[^\]]*\]/gi, '')
    .replace(/\[QUANTIDADE[^\]]*\]/gi, '')
    .replace(/\[HANDOFF\]/gi, '')
    .replace(/\[FINALIZAR\]/gi, '')
    .replace(/\[CARRINHO\]/gi, '')
    .replace(/\[LIMPAR_CARRINHO\]/gi, '')
    .replace(/\[NOME[^\]]*\]/gi, '')
    .replace(/\[REMOVER[^\]]*\]/gi, '')
    .replace(/\[COMPRAR_DIRETO[^\]]*\]/gi, '')
    .replace(/não posso emitir\s*\[[^\]]*\][^.!?\n]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Converts internal history format to Gemini's expected format.
 * - 'assistant' → 'model'
 * - 'system' → merged as 'user' (Gemini doesn't support system role in history)
 * - Consecutive same-role messages are merged to maintain alternation.
 */
function toGeminiHistory(history) {
  const converted = [];

  for (const msg of history) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const text = msg.content;

    if (converted.length > 0 && converted[converted.length - 1].role === role) {
      converted[converted.length - 1].parts[0].text += '\n' + text;
    } else {
      converted.push({ role, parts: [{ text }] });
    }
  }

  return converted;
}

/**
 * Sends the full conversation history to Gemini and returns the raw response text.
 */
async function chat(history, catalogContext, nudge = null) {
  const nudgeBlock = nudge ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━\nCOMANDO DE SISTEMA PRIORITÁRIO\n━━━━━━━━━━━━━━━━━━━━━━━━\n${nudge}\n\n` : '';
  const active = await learnings.getActive();
  const learningsBlock = active.length > 0
    ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━\nAPRENDIZADOS DE CONVERSAS REAIS\n━━━━━━━━━━━━━━━━━━━━━━━━\n${active.map((l, i) => `${i + 1}. ${l}`).join('\n')}`
    : '';

  const systemContent = catalogContext
    ? `${nudgeBlock}${SYSTEM_PROMPT}${learningsBlock}\n\nCONTEXTO DA SESSAO:\n${catalogContext}`
    : `${nudgeBlock}${SYSTEM_PROMPT}${learningsBlock}`;

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: { parts: [{ text: systemContent }] },
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 500,
    },
  });

  // All messages except the last go into history; last is sent as the new turn
  const geminiHistory = toGeminiHistory(history.slice(0, -1));
  const lastMsg = history[history.length - 1];

  const chatSession = model.startChat({ history: geminiHistory });
  const result = await chatSession.sendMessage(lastMsg.content);

  const raw = result.response.text().trim();

  // Extrai e loga o raciocínio interno
  const thinkMatch = raw.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch) {
    const logger = require('./logger');
    logger.info({ think: thinkMatch[1].trim() }, '[THINK]');
  }

  return raw;
}

/**
 * Parses a single action token from the AI response text.
 * Returns { cleanText, action: { type, payload } | null }
 */
function parseAction(text) {
  // COMPRAR_DIRETO tem payload JSON — trata antes dos tokens simples
  const comprarDiretoRegex = /\[COMPRAR_DIRETO:\s*(\{[^\]]+\})\s*\]/i;
  const comprarMatch = text.match(comprarDiretoRegex);
  if (comprarMatch) {
    try {
      const payload = JSON.parse(comprarMatch[1]);
      const cleanText = sanitizeVisible(text.replace(comprarDiretoRegex, ''));
      return { cleanText, action: { type: 'COMPRAR_DIRETO', payload } };
    } catch {
      // JSON inválido — ignora o token
    }
  }

  const tokens = {
    VER_TODOS:  /\[VER_TODOS:([^\]]+)\]/i,
    VER:        /\[VER:(feminino|masculino|femininoinfantil|masculinoinfantil|infantil)\]/i,
    BUSCAR:     /\[BUSCAR:([^\]]+)\]/i,
    PROXIMOS:   /\[PROXIMOS\]/i,
    FOTOS:      /\[FOTOS:(\d+)\]/i,
    SELECIONAR: /\[SELECIONAR:(\d+)\]/i,
    TAMANHO:    /\[TAMANHO:([^\]]+)\]/i,
    QUANTIDADE: /\[QUANTIDADE:(\d+)\]/i,
    CARRINHO:   /\[CARRINHO\]/i,
    LIMPAR_CARRINHO: /\[LIMPAR_CARRINHO\]/i,
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
