require('dotenv').config();

const express = require('express');
const woocommerce = require('./services/woocommerce');
const zapi = require('./services/zapi');
const ai       = require('./services/gemini');
const tts      = require('./services/tts');
const stt      = require('./services/stt');
const db       = require('./services/supabase');
const learnings = require('./services/learnings');
const logger = require('./services/logger');
const conversationMemory = require('./services/conversation-memory');

const TTS_ENABLED = process.env.TTS_ENABLED === 'true';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_PHONE = process.env.ADMIN_PHONE || null;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes inactivity
const MAX_HISTORY_MESSAGES = parseInt(process.env.MAX_HISTORY_MESSAGES || '40', 10);
// ── Grade Parser ─────────────────────────────────────────────────────────

/**
 * Extracts a size+quantity grid from free text.
 * Only call when FSM is active and the focused product has known sizes.
 * @param {string} text
 * @param {string[]} knownSizes - e.g. ['P','M','G','GG']
 * @returns {{ size: string, qty: number }[] | null}
 */
function parseGradeText(text, knownSizes) {
  if (!text || !knownSizes?.length) return null;

  const knownSizesUpper = new Set(knownSizes.map(size => size.toUpperCase()));
  const sizesPattern = knownSizes
    .slice()
    .sort((a, b) => b.length - a.length) // GG before G
    .join('|');

  const totalsBySize = new Map();
  const orderedSizes = [];

  // Pattern: number before size — cobre variações PT-BR:
  //   "9P", "9 P", "9 do P", "9 da P", "9 de P", "9 dos P", "9 das P",
  //   "9x P", "9 tamanho P", "9:P"
  // Lookahead aceita espaço, vírgula, ponto, ponto-e-vírgula, barra, "e", fim de string.
  const regexQtyFirst = new RegExp(
    `(\\d+)\\s*(?:do|da|de|dos|das|x|:|tamanho)?\\s*(${sizesPattern})(?=\\s|,|;|\\.|/|!|\\?|e\\b|$)`,
    'gi'
  );

  // Pattern: size before number — "P: 9", "P=9", "P - 9"
  const regexSizeFirst = new RegExp(
    `\\b(${sizesPattern})\\s*[=:\\-]\\s*(\\d+)`,
    'gi'
  );

  function addGradeEntry(rawSize, rawQty) {
    const size = String(rawSize).toUpperCase();
    const qty = parseInt(rawQty, 10);
    if (!knownSizesUpper.has(size) || qty <= 0 || qty > 999) return;

    if (!totalsBySize.has(size)) {
      totalsBySize.set(size, 0);
      orderedSizes.push(size);
    }
    totalsBySize.set(size, totalsBySize.get(size) + qty);
  }

  let match;
  while ((match = regexQtyFirst.exec(text)) !== null) {
    addGradeEntry(match[2], match[1]);
  }
  while ((match = regexSizeFirst.exec(text)) !== null) {
    addGradeEntry(match[1], match[2]);
  }

  const validResults = orderedSizes.map(size => ({ size, qty: totalsBySize.get(size) }));
  return validResults.length > 0 ? validResults : null;
}

// ── Sessions ──────────────────────────────────────────────────────────────
const sessions = {};

const SLUG_MAP = {
  'feminina': 'feminino',
  'feminino': 'feminino',
  'feminino_infantil': 'femininoinfantil',
  'masculina': 'masculino',
  'masculino': 'masculino',
  'masculino_infantil': 'masculinoinfantil',
  'lancamentos': 'lancamento-da-semana',
  'lancamento': 'lancamento-da-semana'
};
const CATEGORY_OPTIONS = [
  { id: 'cat_feminina', title: 'Feminino', description: 'Moda íntima feminina' },
  { id: 'cat_feminino_infantil', title: 'Feminino Infantil', description: 'Conforto para as meninas' },
  { id: 'cat_masculina', title: 'Masculino', description: 'Moda íntima masculina' },
  { id: 'cat_masculino_infantil', title: 'Masculino Infantil', description: 'Conforto para os meninos' },
  { id: 'cat_lancamentos', title: 'Lançamentos', description: 'As novidades da semana' },
  { id: 'falar_atendente', title: 'Falar com Humano', description: 'Tire suas dúvidas agora' },
];

async function sendCategoryMenu(phone, text) {
  await zapi.sendOptionList(
    phone,
    text,
    'Nossas Coleções',
    'Ver Opções',
    CATEGORY_OPTIONS
  );
}

function createDefaultPurchaseFlow() {
  return {
    state: 'idle',
    productId: null,
    productName: null,
    price: null,
    selectedSize: null,
    interactiveVersion: Date.now(),
    addedSizes: [],
    // Contexto de clique para identificar produto em replies
    lastClickedProductId: null,
    lastClickedProductName: null,
    lastClickedProductTimestamp: null,
    // Fila de compras: acumula buy_ clicks enquanto FSM está ocupada
    buyQueue: [],
  };
}

function trimSessionHistory(session) {
  if (!Array.isArray(session.history) || session.history.length <= MAX_HISTORY_MESSAGES) return;
  session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
}

function appendHistory(session, role, content) {
  if (!content) return;
  session.history.push({ role, content });
  trimSessionHistory(session);
}

function buildFsmContext(session) {
  const pf = session.purchaseFlow;
  if (!pf || pf.state === 'idle') return null;

  const product = session.products?.find(p => p.id === pf.productId);
  const lines = [
    `[ESTADO ATUAL DA COMPRA]`,
    `Produto em foco: ${pf.productName || 'desconhecido'}`,
    `Etapa: ${pf.state}`,
  ];

  if (pf.state === 'awaiting_size' && product?.sizes?.length) {
    lines.push(`Tamanhos disponíveis: ${product.sizes.map((s, i) => `${i + 1}=${s}`).join(', ')}`);
    lines.push(`→ O cliente precisa escolher UM tamanho. Se ele disser "G", "M", "P" etc., use [TAMANHO:G]. Se disser o número, use [TAMANHO:2].`);
  }

  if (pf.state === 'awaiting_quantity') {
    lines.push(`Tamanho já escolhido: ${pf.selectedSize}`);
    lines.push(`→ O cliente precisa dizer QUANTAS peças quer. Use [QUANTIDADE:N] com o número.`);
  }

  if (pf.state === 'awaiting_more_sizes') {
    lines.push(`Tamanhos já adicionados: ${pf.addedSizes?.join(', ') || 'nenhum'}`);
    const remaining = product?.sizes?.filter(s => !pf.addedSizes?.includes(s)) || [];
    if (remaining.length > 0) {
      lines.push(`Tamanhos ainda disponíveis: ${remaining.join(', ')}`);
    }
    lines.push(`→ O cliente pode querer outro tamanho, ver o carrinho, ou seguir para o próximo produto.`);
  }

  if (pf.buyQueue?.length > 0) {
    const nomes = pf.buyQueue.map(q => q.productName).join(', ');
    lines.push(`Fila de compras pendente (${pf.buyQueue.length}): ${nomes}`);
  }

  if (session.items?.length > 0) {
    const cartTotal = session.items.reduce((acc, it) => acc + parseFloat(it.price || 0), 0);
    lines.push(`Carrinho atual (${session.items.length} itens, total ${woocommerce.formatPrice(cartTotal)}): ${session.items.map(it => `${it.productName} (${it.size}) x${it.quantity}`).join('; ')}`);
  }

  return lines.join('\n');
}

function buildAiContext(session) {
  const blocks = [conversationMemory.buildConversationContext(session)];
  const fsmContext = buildFsmContext(session);
  const catalogContext = woocommerce.buildCatalogContext(session);

  if (fsmContext) blocks.push(fsmContext);
  if (catalogContext) blocks.push(catalogContext);

  return blocks.filter(Boolean).join('\n\n');
}

function normalizeCategorySlug(slug) {
  if (!slug) return null;
  return SLUG_MAP[slug.toLowerCase()] || slug.toLowerCase();
}

async function getSession(phone) {
  if (!sessions[phone]) {
    const stored = await db.getSession(phone);
    const defaultPurchaseFlow = createDefaultPurchaseFlow();
    const storedPurchaseFlow = stored?.purchase_flow ? { ...stored.purchase_flow } : null;
    const storedConversationMemory = storedPurchaseFlow?.contextMemory || null;
    if (storedPurchaseFlow?.contextMemory) delete storedPurchaseFlow.contextMemory;

    sessions[phone] = stored
      ? {
          history:         stored.history         || [],
          items:           stored.items            || [],
          products:        stored.products         || [],
          currentProduct:  stored.current_product  || null,
          customerName:    stored.customer_name    || null,
          currentCategory: normalizeCategorySlug(stored.current_category) || null,
          activeCategory:  normalizeCategorySlug(stored.current_category) || null,
          currentPage:     stored.current_page     || 0,
          totalPages:      stored.total_pages      || 1,
          totalProducts:   stored.total_products   || 0,
          lastViewedProduct: stored.last_viewed_product || null,
          lastViewedProductIndex: stored.last_viewed_product_index || null,
          purchaseFlow: storedPurchaseFlow
            ? { ...defaultPurchaseFlow, ...storedPurchaseFlow, addedSizes: storedPurchaseFlow.addedSizes || [], buyQueue: storedPurchaseFlow.buyQueue || [] }
            : defaultPurchaseFlow,
          conversationMemory: storedConversationMemory || conversationMemory.createDefaultConversationMemory(),
          messageProductMap: stored.message_product_map || {},
          previousLastActivity: stored.last_activity || null,
          lastActivity:    Date.now(),
        }
      : {
          history: [], items: [], products: [],
          currentProduct: null, customerName: null,
          currentCategory: null, activeCategory: null,
          currentPage: 0, totalPages: 1, totalProducts: 0,
          lastViewedProduct: null,
          lastViewedProductIndex: null,
          purchaseFlow: defaultPurchaseFlow,
          conversationMemory: conversationMemory.createDefaultConversationMemory(),
          messageProductMap: {},
          previousLastActivity: null,
          lastActivity: Date.now(),
        };
  } else {
    sessions[phone].previousLastActivity = sessions[phone].lastActivity || null;
    sessions[phone].lastActivity = Date.now();
  }
  return sessions[phone];
}

function persistSession(phone) {
  const session = sessions[phone];
  if (!session) return;
  db.upsertSession(phone, session)
    .catch(err => logger.error({ err: err.message }, '[Supabase] upsertSession'));
}

// Clean up sessions
setInterval(() => {
  const now = Date.now();
  for (const phone of Object.keys(sessions)) {
    if (now - sessions[phone].lastActivity > SESSION_TIMEOUT_MS) {
      delete sessions[phone];
      logger.info({ phone }, '[Session] Expired');
    }
  }
  db.deleteExpiredSessions(SESSION_TIMEOUT_MS)
    .catch(err => logger.error({ err: err.message }, '[Supabase] deleteExpiredSessions'));
}, 10 * 60 * 1000);

// ── Cart Recovery (Abandono de Carrinho) ─────────────────────────────────
const CART_ABANDON_MS = 2 * 60 * 60 * 1000; // 2 horas sem interação

setInterval(async () => {
  const now = Date.now();
  for (const [phone, session] of Object.entries(sessions)) {
    if (
      session.items?.length > 0 &&
      !session.cartNotified &&
      (now - session.lastActivity) > CART_ABANDON_MS
    ) {
      try {
        await zapi.sendText(
          phone,
          'Oii! Vi que você deixou alguns itens no carrinho 🛒 Quer ajuda para finalizar o pedido ou quer ver mais novidades?'
        );
        session.cartNotified = true;
        logger.info({ phone, items: session.items.length }, '[CartRecovery] Mensagem de recuperação enviada');
      } catch (err) {
        logger.error({ phone, err: err.message }, '[CartRecovery] Erro ao enviar mensagem');
      }
    }
  }
}, 30 * 60 * 1000); // Verifica a cada 30 minutos

// ── Text Extraction ──────────────────────────────────────────────────────

function extractTextFromEvent(event) {
  try {
    if (!event) return '';

    // Intercepta cliques em Option List da Z-API
    const listId = event.listResponseMessage?.selectedRowId;
    if (listId) {
      logger.info({ from: event.phone, listId }, '[ListResponse] Item selecionado');
      if (listId === 'cat_feminina') return 'quero ver a linha feminina';
      if (listId === 'cat_feminino_infantil') return 'quero ver a linha feminino infantil';
      if (listId === 'cat_masculina') return 'quero ver a linha masculina';
      if (listId === 'cat_masculino_infantil') return 'quero ver a linha masculino infantil';
      if (listId === 'cat_lancamentos') return 'quero ver os lançamentos';
      if (listId === 'btn_sim_mais') return 'SIM';
      if (listId === 'btn_ver_todos') return 'VER_TODOS_CATEGORIA';
      if (listId === 'cart_view') return 'quero ver meu carrinho';
      if (listId === 'cart_finalize') return 'quero finalizar o pedido';
      // Sentinela determinístico — evita colisão com detector de fotos ("ver mais").
      // Interceptado no webhook e roteado direto para navegação/catálogo.
      if (listId === 'cart_more_products') return 'VER_MAIS_PRODUTOS';
      if (listId === 'falar_atendente') return 'quero falar com um atendente';
      return listId;
    }

    // Intercepta botões da Z-API e trata como texto transparente para a IA
    if (event.type === 'button_reply' && event.buttonReply?.id) {
       if (event.buttonReply.id === 'btn_sim_mais') return 'SIM';
       if (event.buttonReply.id === 'btn_outra_cat') return 'OUTRA CATEGORIA';
       if (event.buttonReply.id === 'cart_view') return 'quero ver meu carrinho';
       if (event.buttonReply.id === 'cart_finalize') return 'quero finalizar o pedido';
       if (event.buttonReply.id === 'cart_more_products') return 'VER_MAIS_PRODUTOS';
       return event.buttonReply.id;
    }

    // Suporte para múltiplos formatos de payload da Z-API
    if (typeof event.text === 'string') return event.text;
    if (event.text && typeof event.text.message === 'string') return event.text.message;
    if (event.content && typeof event.content === 'string') return event.content;
    if (event.audio) return '[Áudio_STT]';
    if (event.image?.caption) return event.image.caption.trim();
    if (event.sticker) return '[Sticker]';

    // Fallback para objetos complexos
    return event.text?.message || event.content || '';
  } catch (err) {
    return '';
  }
}

// ── Webhook ───────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  let from = '';
  try {
    const fsmEventId  = fsmButtonId || fsmListId;

    // ─────────────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────────────

    const text = extractTextFromEvent(body);
    if (!text) return;

    if (text === '[Áudio]') {
      logger.info({ from }, '[Intercept] Áudio recebido — fallback humano');
      await zapi.replyText(from, 'Puts amada, tô sem fone aqui no depósito 😅. Consegue me digitar rapidinho o que precisa?', messageId);
      return;
    }
    if (text === '[Sticker]') {
      logger.info({ from }, '[Intercept] Sticker recebido — ignorando');
      return;
    }

    if (text.includes('CONTA EM TRIAL') || text.includes('MENSAGEM DE TESTE')) return;

    logger.info({ phone: from, text }, '[MSG] Received');
    if (messageId) zapi.readMessage(from, messageId);

    const session = await getSession(from);
    const inactivityMs = session.previousLastActivity
      ? Date.now() - session.previousLastActivity
      : 0;

    if (/(limpar|esvaziar|zerar).*(carrinho)|carrinho.*(limpar|esvaziar|zerar)/i.test(text)) {
      logger.info({ from, text }, '[Cart] Comando direto para limpar carrinho');
      await clearCart(from, session);
      persistSession(from);
      return;
    }

    // Intercept: botão "Ver Mais Produtos" — roteado ANTES de qualquer detector semântico.
    // Navegação é determinística: continua catálogo em curso OU abre menu de categorias.
    // Evita colisão do sentinel com IS_PHOTO_REQUEST e mantém histórico limpo.
    if (text === 'VER_MAIS_PRODUTOS') {
      logger.info({ phone: from, category: session.activeCategory, page: session.currentPage, totalPages: session.totalPages }, '[Intercept] VER_MAIS_PRODUTOS — navegação de catálogo');
      if (session.activeCategory && session.currentPage > 0 && session.currentPage < session.totalPages) {
        await showNextPage(from, session);
      } else if (session.activeCategory) {
        await showAllCategory(from, session.activeCategory, session);
      } else {
        await sendCategoryMenu(from, 'Claro, amor! Qual linha você quer ver?');
      }
      persistSession(from);
      return;
    }

    // Fallback: cliente digitou quantidade manualmente durante awaiting_quantity.
    // Só aceita quantidade pura (ex: "3", "12", "3 peças", "quero 3") — rejeita
    // textos com letras de tamanho (ex: "9P 5M 3G") para não roubar grades do
    // parser semântico. Fallback de parseInt cego era fonte de bug documentado.
    if (session.purchaseFlow?.state === 'awaiting_quantity') {
      const trimmed = text.trim();
      const qtyMatch = trimmed.match(/^\s*(?:quero\s+)?(\d{1,3})\s*(?:pe[çc]as?|unidades?|itens?|pares?|pc|pcs)?\s*$/i);
      if (qtyMatch) {
        const qty = parseInt(qtyMatch[1], 10);
        if (qty > 0 && qty <= 999) {
          logger.info({ from, qty }, '[FSM] Quantidade digitada manualmente');
          await addToCart(from, qty, session);
          persistSession(from);
          return;
        }
      } else {
        logger.info({ from, text: trimmed.slice(0, 60) }, '[FSM] Texto não é quantidade pura — passando adiante (grade parser / IA)');
      }
    }

    // ── Grade Semântica: parser determinístico de tamanho+quantidade ──────────
    // Só dispara quando a FSM está ativa e o produto está em foco.
    // Processa toda a grade em batch (pushCartItem) e envia confirmação única.
    const pfGrade = session.purchaseFlow;
    if (pfGrade.state !== 'idle' && pfGrade.productId) {
      // Se o cliente citou um produto diferente do que está em foco, migrar o foco
      const quoteRefId = body?.referenceMessageId
        || body?.quotedMessage?.messageId
        || body?.quotedMessage?.stanzaId
        || body?.quotedMessage?.id;
      if (quoteRefId && session.messageProductMap?.[quoteRefId]) {
        const mapped = session.messageProductMap[quoteRefId];
        if (mapped.productId !== pfGrade.productId) {
          const productStillLoaded = session.products?.some(p => p.id === mapped.productId);
          if (productStillLoaded) {
            const quotedProd = session.products.find(p => p.id === mapped.productId);
            logger.info(
              { prev: pfGrade.productId, next: mapped.productId, prevName: pfGrade.productName, nextName: quotedProd?.name },
              '[Grade] Migrando foco do produto via quote reply'
            );
            pfGrade.productId = mapped.productId;
            pfGrade.productName = quotedProd?.name || pfGrade.productName;
            pfGrade.unitPrice = parseFloat(quotedProd?.salePrice || quotedProd?.price);
            pfGrade.addedSizes = [];
          }
        }
      }

      const focusedProduct = session.products?.find(p => p.id === pfGrade.productId);

      if (focusedProduct?.sizes?.length) {
        const grade = parseGradeText(text, focusedProduct.sizes);

        if (grade) {
          logger.info({ from, grade, product: pfGrade.productName }, '[Grade] Grade semântica detectada');
          appendHistory(session, 'user', text);
          conversationMemory.refreshConversationMemory(session, { userText: text });

          const unitPrice = parseFloat(focusedProduct.salePrice || focusedProduct.price);
          const addedItems = [];

          for (const { size, qty } of grade) {
            const validSize = focusedProduct.sizes.find(s => s.toUpperCase() === size);
            if (!validSize) continue;
            pushCartItem(session, focusedProduct.id, focusedProduct.name, validSize, qty, unitPrice);
            addedItems.push({ size: validSize, qty });
          }

          if (addedItems.length === 0) {
            await zapi.sendText(from, `Hmm, não reconheci os tamanhos. Os disponíveis são: *${focusedProduct.sizes.join(', ')}* 😊`);
            persistSession(from);
            return;
          }

          // Consolidated confirmation — single message for entire grade
          const gradeLines = addedItems.map(({ size, qty }) =>
            `• ${focusedProduct.name} (${size}) x${qty}`
          ).join('\n');
          const cartTotal = session.items.reduce((acc, it) => acc + parseFloat(it.price || 0), 0);
          const { lineItems, totalPieces } = getCartStats(session);
          const confirmMsg = `✅ Grade separada!\n${gradeLines}\n\n🛒 Carrinho: ${totalPieces} ${totalPieces === 1 ? 'peça' : 'peças'} em ${lineItems} ${lineItems === 1 ? 'item' : 'itens'} — *${woocommerce.formatPrice(cartTotal)}*`;

          appendHistory(session, 'assistant', confirmMsg);
          conversationMemory.refreshConversationMemory(session, { assistantText: confirmMsg, action: { type: 'CARRINHO' } });

          // Set FSM to awaiting_more_sizes for proper post-add menu
          pfGrade.state = 'awaiting_more_sizes';
          pfGrade.selectedSize = null;
          if (!Array.isArray(pfGrade.addedSizes)) pfGrade.addedSizes = [];
          session.currentProduct = focusedProduct;

          const remainingSizes = focusedProduct.sizes.filter(s => !pfGrade.addedSizes.includes(s));
          await sendPostAddMenu(from, session, remainingSizes, confirmMsg);
          persistSession(from);
          return;
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── FSM Text Interceptor ──────────────────────────────────────────────────
    // Intercepta textos ambíguos/curtos durante a FSM ativa (ex: "Ok", "sim")
    // para re-enviar o menu pendente. Textos com intenção real (comandos de
    // carrinho, cancelamento, navegação) passam direto para a IA.
    const pfCheck = session.purchaseFlow;

    // Comandos que sempre escapam o interceptor — a IA deve tratá-los
    const FSM_ESCAPE = /limpar|esvaziar|cancelar|sair|parar|remov|carrinho|voltar|finaliz|ver cart|catálog|catalog|categoria|quero ver|não quero|nao quero|mudar|trocar|outro produto|outros produto/i;
    const fsmEscaping = FSM_ESCAPE.test(text);

    if (!fsmEscaping && pfCheck.state === 'awaiting_size') {
      const product = session.products?.find(p => p.id === pfCheck.productId);
      if (product) {
        const textUpper = text.trim().toUpperCase();

        // Direct match: text IS a size name → process immediately without AI roundtrip
        const directSizeIdx = product.sizes.findIndex(s => s.toUpperCase().trim() === textUpper);
        if (directSizeIdx >= 0) {
          logger.info({ from, size: product.sizes[directSizeIdx] }, '[FSM] Tamanho digitado — processando direto');
          const pf = session.purchaseFlow;
          pf.selectedSize = product.sizes[directSizeIdx];
          pf.state = 'awaiting_quantity';
          pf.interactiveVersion = Date.now();
          appendHistory(session, 'user', text);
          conversationMemory.refreshConversationMemory(session, { userText: text });
          await zapi.sendQuantityList(from, pf.selectedSize, pf.interactiveVersion);
          persistSession(from);
          return;
        }

        // Direct match: text is a valid size index number
        const numericIdx = parseInt(textUpper, 10);
        if (!isNaN(numericIdx) && numericIdx >= 1 && numericIdx <= product.sizes.length) {
          logger.info({ from, sizeIdx: numericIdx, size: product.sizes[numericIdx - 1] }, '[FSM] Índice de tamanho digitado — processando direto');
          const pf = session.purchaseFlow;
          pf.selectedSize = product.sizes[numericIdx - 1];
          pf.state = 'awaiting_quantity';
          pf.interactiveVersion = Date.now();
          appendHistory(session, 'user', text);
          conversationMemory.refreshConversationMemory(session, { userText: text });
          await zapi.sendQuantityList(from, pf.selectedSize, pf.interactiveVersion);
          persistSession(from);
          return;
        }

        // Text mentions a known size in natural language → let through to AI
        const words = textUpper.split(/\s+/);
        const mentionsSize = product.sizes.some(s => words.includes(s.toUpperCase().trim()));
        if (mentionsSize) {
          logger.info({ from, text, state: pfCheck.state }, '[FSM] Texto menciona tamanho — passando para IA');
          // Falls through to AI processing below
        } else {
          logger.info({ from, state: pfCheck.state }, '[FSM] Texto ambíguo em awaiting_size — re-enviando menu');
          await zapi.sendText(from, `😊 Escolhe o tamanho de *${pfCheck.productName}* pelo botão abaixo!`);
          await zapi.sendSizeList(from, product, pfCheck.interactiveVersion);
          persistSession(from);
          return;
        }
      }
    }

    if (!fsmEscaping && pfCheck.state === 'awaiting_more_sizes') {
      const product = session.products?.find(p => p.id === pfCheck.productId);
      const remainingSizes = product?.sizes?.filter(s => !pfCheck.addedSizes.includes(s)) ?? [];

      // Check if text mentions a remaining size → let through to AI
      const textUpper = text.trim().toUpperCase();
      const words = textUpper.split(/\s+/);
      const mentionsRemainingSize = remainingSizes.some(s => words.includes(s.toUpperCase().trim()));
      if (mentionsRemainingSize) {
        logger.info({ from, text, state: pfCheck.state }, '[FSM] Texto menciona tamanho restante — passando para IA');
        // Falls through to AI processing below
      } else {
        logger.info({ from, state: pfCheck.state }, '[FSM] Texto ambíguo em awaiting_more_sizes — re-enviando menu');
        await sendPostAddMenu(from, session, remainingSizes);
        persistSession(from);
        return;
      }
    }

    if (fsmEscaping && pfCheck.state !== 'idle') {
      logger.info({ from, text, state: pfCheck.state }, '[FSM] Comando de escape detectado — passando para IA');
    }
    // ─────────────────────────────────────────────────────────────────────────

    // FIX-16 — Saudação pura com histórico antigo: limpa contexto para novo atendimento.
    // Preserva carrinho e nome do cliente.
    const PURE_GREETING = /^(oi+|ol[aá]+|bom dia|boa tarde|boa noite|hey+|hello|hi|tudo bem|tudo bom|e a[ií]|eai|opa|boas|salve|vcs estao ai)(\s|[!?.,]|$)/i;
    let isFirstContact = false;
    const staleConversation = inactivityMs > SESSION_TIMEOUT_MS;

    // Se é a primeira mensagem ou uma saudação, reseta tudo para focar em lançamentos
    const fsmIsIdle = !session.purchaseFlow || session.purchaseFlow.state === 'idle';
    if (fsmIsIdle && (session.history.length === 0 || (PURE_GREETING.test(text.trim()) && staleConversation))) {
      logger.info({ phone: from, historyLen: session.history.length }, '[SessionReset] Forçando fluxo de lançamentos');
      
      session.history = [];
      session.products = [];
      session.currentProduct = null;
      session.currentCategory = null;
      session.activeCategory = null;
      session.currentPage = 0;
      session.totalPages = 1;
      session.totalProducts = 0;
      session.lastViewedProduct = null;
      session.lastViewedProductIndex = null;
      session.conversationMemory = conversationMemory.createDefaultConversationMemory();
      isFirstContact = true;
    }

    // Extrai o número do produto da legenda citada — independe de bold/markdown do WhatsApp.
    // Formato esperado: "✨ 3. Nome..." ou "✨ *3. Nome...*" (com ou sem asteriscos)
    let quotedProductIdx = null;
    let finalUserText = text;

    // ── Tentativa 0: referenceMessageId na raiz do body (Z-API button-list replies) ──
    // Z-API envia o ID da mensagem citada em body.referenceMessageId para mensagens interativas.
    // Este campo referencia o messageId retornado no POST de envio (não o zaapId).
    if (!quotedProductIdx && body?.referenceMessageId && session.messageProductMap) {
      const mapped = session.messageProductMap[body.referenceMessageId];
      if (mapped) {
        const productStillLoaded = session.products?.some(p => p.id === mapped.productId);
        if (productStillLoaded) {
          quotedProductIdx = mapped.productIdx;
          // Reconstruir contexto da citação para a IA (quotedText virá null para button messages)
          const prod = session.products.find(p => p.id === mapped.productId);
          if (prod) {
            const price = prod.salePrice
              ? `R$ ${parseFloat(prod.salePrice).toFixed(2).replace('.', ',')}`
              : `R$ ${parseFloat(prod.price).toFixed(2).replace('.', ',')}`;
            finalUserText = `[O cliente citou a vitrine do produto "${prod.name}" (${price})]\n\nMensagem do cliente: "${text}"`;
          }
          logger.info(
            { refMsgId: body.referenceMessageId, productId: mapped.productId, productIdx: mapped.productIdx },
            '[QuotedProduct] Resolvido via referenceMessageId (raiz) ✓'
          );
        }
      }
    }

    if (body?.quotedMessage) {
      // Log do payload bruto para diagnóstico de estrutura do Z-API
      logger.info({ quotedMessage: body.quotedMessage }, '[QuotedMsg] Raw payload');

      // Z-API pode entregar a caption em vários campos dependendo da versão
      // Tenta todos os paths conhecidos, incluindo estrutura aninhada (message.imageMessage)
      let quotedText =
        body.quotedMessage.text?.message ||
        body.quotedMessage.image?.caption ||
        body.quotedMessage.imageMessage?.caption ||
        body.quotedMessage.caption ||
        body.quotedMessage.message?.imageMessage?.caption ||
        body.quotedMessage.message?.extendedTextMessage?.text ||
        null;

      logger.info({ quotedText }, '[QuotedMsg] Extracted text');

      // Tenta extrair o número do produto da caption resolvida
      const tryExtractIdx = (src) => {
        if (!src || !session.products?.length) return null;
        const m = src.match(/\u2728[^0-9]*(\d+)\./);
        if (!m) return null;
        const n = parseInt(m[1], 10);
        return (n >= 1 && n <= session.products.length) ? n : null;
      };

      let extractedIdx = tryExtractIdx(quotedText);

      // Último recurso: varre o JSON bruto da quotedMessage em busca do padrão ✨N.
      // Cobre estruturas aninhadas que ainda não conhecemos.
      if (!extractedIdx && session.products?.length > 0) {
        const rawJson = JSON.stringify(body.quotedMessage);
        const mRaw = rawJson.match(/\\u2728[^0-9"\\]*(\d+)\.|✨[^0-9"]*(\d+)\./);
        if (mRaw) {
          const n = parseInt(mRaw[1] || mRaw[2], 10);
          if (n >= 1 && n <= session.products.length) {
            extractedIdx = n;
            logger.info({ method: 'brute-force', productIdx: n }, '[QuotedProduct] Extraído do JSON bruto');
          }
        }
      }

      // Tentativa 3 (messageProductMap): lookup pelo messageId do quotedMessage ou referenceMessageId
      if (!extractedIdx && session.products?.length > 0 && session.messageProductMap) {
        const mapMsgId = body.referenceMessageId          // ← NOVO: raiz do body
          || body.quotedMessage.messageId
          || body.quotedMessage.stanzaId
          || body.quotedMessage.id;
        if (mapMsgId && session.messageProductMap[mapMsgId]) {
          const mapped = session.messageProductMap[mapMsgId];
          const productStillLoaded = session.products.some(p => p.id === mapped.productId);
          if (productStillLoaded) {
            extractedIdx = mapped.productIdx;
            logger.info({ msgId: mapMsgId, productId: mapped.productId, productIdx: mapped.productIdx }, '[QuotedProduct] Resolvido via messageProductMap ✓');
          }
        }
      }

      // Tentativa 4 (nome do produto no texto citado)
      if (!extractedIdx && session.products?.length > 0 && quotedText) {
        const matchByName = session.products.findIndex(p =>
          quotedText.includes(p.name)
        );
        if (matchByName >= 0) {
          extractedIdx = matchByName + 1;
          logger.info({ productName: session.products[matchByName].name, productIdx: extractedIdx }, '[QuotedProduct] Resolvido via nome ✓');
        }
      }

      // Tentativa 5 (REST API fallback): busca mensagem completa pelo ID
      if (!extractedIdx && session.products?.length > 0) {
        const msgId = body.quotedMessage.messageId
          || body.quotedMessage.stanzaId
          || body.quotedMessage.id;

        if (msgId) {
          logger.info({ msgId }, '[Quote] Inline + brute-force failed, trying REST API');
          try {
            const fullMsg = await zapi.getMessageById(msgId);
            if (fullMsg) {
              const restCaption =
                fullMsg.caption ||
                fullMsg.text?.message ||
                fullMsg.image?.caption ||
                fullMsg.imageMessage?.caption ||
                null;

              if (restCaption) {
                logger.info({ method: 'REST', caption: restCaption.substring(0, 80) }, '[Quote] Caption found via REST');
                extractedIdx = tryExtractIdx(restCaption);
                if (!quotedText) quotedText = restCaption;
              } else {
                logger.warn({ fullMsgKeys: Object.keys(fullMsg) }, '[Quote] REST returned msg but no caption');
              }
            }
          } catch (restErr) {
            logger.error({ msgId, err: restErr.message }, '[Quote] REST fallback error');
          }
        } else {
          logger.warn({
            keys: Object.keys(body.quotedMessage),
          }, '[Quote] No messageId/stanzaId/id in quotedMessage');
        }
      }

      if (quotedText) {
        finalUserText = `[O cliente citou a seguinte mensagem sua: "${quotedText}"]\n\nMensagem do cliente: "${text}"`;
      }

      if (extractedIdx) {
        quotedProductIdx = extractedIdx;
        logger.info({ productIdx: quotedProductIdx }, '[QuotedProduct] Identificado na legenda citada');
      } else if (body.quotedMessage) {
        // Auditoria consolidada: quando TODAS as estratégias falham, dumpa
        // os IDs tentados vs. os disponíveis no map — essencial para
        // diagnosticar divergência de chaves Z-API (zaapId x messageId x stanzaId).
        const attemptedKeys = {
          referenceMessageId: body.referenceMessageId || null,
          quoteMessageId: body.quotedMessage.messageId || null,
          quoteStanzaId: body.quotedMessage.stanzaId || null,
          quoteId: body.quotedMessage.id || null,
        };
        const mapSample = Object.keys(session.messageProductMap || {}).slice(-10);
        logger.warn({
          attemptedKeys,
          mapSampleLast10: mapSample,
          quotedMessageKeys: Object.keys(body.quotedMessage),
          productsInSession: session.products?.length || 0,
        }, '[QuotedProduct] FALHA: nenhuma estratégia resolveu o produto citado');
        
        // Fallback: tentar usar o lastClickedProductId se o contexto for recente
        const PRODUCT_CONTEXT_TIMEOUT = 5 * 60 * 1000; // 5 minutos
        const pf = session.purchaseFlow;
        const isProductContextFresh = 
          pf.lastClickedProductTimestamp && 
          (Date.now() - pf.lastClickedProductTimestamp) < PRODUCT_CONTEXT_TIMEOUT;

        if (isProductContextFresh && pf.lastClickedProductId) {
          const product = session.products?.find(p => p.id === pf.lastClickedProductId);
          if (product) {
            quotedProductIdx = session.products.indexOf(product) + 1;
            logger.info(
              { productId: pf.lastClickedProductId, productName: pf.lastClickedProductName },
              '[QuotedProduct] Identificado via lastClickedProductId'
            );
          }
        }
      }
    }

    appendHistory(session, 'user', finalUserText);
    conversationMemory.refreshConversationMemory(session, { userText: text });

    // ── Grade Semântica via Produto Citado (FSM idle + quote) ─────────────────
    // Quando o cliente cita uma vitrine e digita grade ("Quero 3M 6P dessa"),
    // o produto vem do quotedProductIdx — não requer FSM ativa.
    if (quotedProductIdx && session.purchaseFlow?.state === 'idle') {
      const quotedProduct = session.products?.[quotedProductIdx - 1];
      if (quotedProduct?.sizes?.length) {
        const gradeFromQuote = parseGradeText(text, quotedProduct.sizes);
        if (gradeFromQuote) {
          logger.info({ from, grade: gradeFromQuote, product: quotedProduct.name }, '[Grade] Grade via produto citado (FSM idle)');
          const pf = session.purchaseFlow;
          const unitPrice = parseFloat(quotedProduct.salePrice || quotedProduct.price);
          pf.productId = quotedProduct.id;
          pf.productName = quotedProduct.name;
          pf.unitPrice = unitPrice;

          const addedItems = [];
          for (const { size, qty } of gradeFromQuote) {
            const validSize = quotedProduct.sizes.find(s => s.toUpperCase() === size);
            if (!validSize) continue;
            pushCartItem(session, quotedProduct.id, quotedProduct.name, validSize, qty, unitPrice);
            addedItems.push({ size: validSize, qty });
          }

          if (addedItems.length > 0) {
            const gradeLines = addedItems.map(({ size, qty }) => `• ${quotedProduct.name} (${size}) x${qty}`).join('\n');
            const cartTotal = session.items.reduce((acc, it) => acc + parseFloat(it.price || 0), 0);
            const { lineItems, totalPieces } = getCartStats(session);
            const confirmMsg = `✅ Grade separada!\n${gradeLines}\n\n🛒 Carrinho: ${totalPieces} ${totalPieces === 1 ? 'peça' : 'peças'} em ${lineItems} ${lineItems === 1 ? 'item' : 'itens'} — *${woocommerce.formatPrice(cartTotal)}*`;

            pf.state = 'awaiting_more_sizes';
            pf.selectedSize = null;
            if (!Array.isArray(pf.addedSizes)) pf.addedSizes = [];
            session.currentProduct = quotedProduct;

            appendHistory(session, 'assistant', confirmMsg);
            conversationMemory.refreshConversationMemory(session, { assistantText: confirmMsg, action: { type: 'CARRINHO' } });

            const remainingSizes = quotedProduct.sizes.filter(s => !pf.addedSizes.includes(s));
            await sendPostAddMenu(from, session, remainingSizes, confirmMsg);
            persistSession(from);
            return;
          }
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────────

    // Intent visual: EXIGE menção explícita a foto/imagem/vídeo.
    // Termos genéricos ("ver mais", "mostra mais", "tem mais") foram retirados —
    // colidiam com navegação de catálogo ("Ver Mais Produtos").
    const IS_PHOTO_REQUEST = /\b(fotos?|imagens?|v[ií]deos?)\b/i.test(text);

    if (IS_PHOTO_REQUEST && !quotedProductIdx && session.products?.length > 0) {
      const inlineNum = text.match(/\b(\d+)\b/);
      if (inlineNum) {
        const n = parseInt(inlineNum[1], 10);
        if (n >= 1 && n <= session.products.length) {
          quotedProductIdx = n;
          logger.info({ productIdx: n }, '[InlineNum] Produto extraído do texto');
        }
      }
    }

    // Se o cliente citou um produto (quotedProductIdx), qualquer mensagem curta ou pedido
    // de fotos/mais é tratado como solicitação de mais fotos daquele produto.
    const isShortMessage = text.trim().length <= 40;
    if (quotedProductIdx && (IS_PHOTO_REQUEST || isShortMessage)) {
      logger.info({ productIdx: quotedProductIdx }, '[Intercept] Pedido de fotos — resolvido em código');
      await showProductPhotos(from, quotedProductIdx, session);
      persistSession(from);
      return;
    }

    // Se o cliente citou uma imagem mas a caption era texto de trial (sem número),
    // e há um lastViewedProduct disponível, usa ele diretamente.
    // GUARD: se quotedMessage existe mas não extraímos o índice (falha de parsing),
    // NÃO usa lastViewedProduct — pode ser um produto diferente do citado.
    const quotedHasImage = !!(body?.quotedMessage && (
      body.quotedMessage.image ||
      body.quotedMessage.imageMessage ||
      body.quotedMessage.type === 'image' ||
      body.quotedMessage.message?.imageMessage
    ));
    const quotedRaw = body?.quotedMessage ? JSON.stringify(body.quotedMessage) : '';
    const quotedIsTrialArtifact = /CONTA EM TRIAL|MENSAGEM DE TESTE/i.test(quotedRaw);
    const hasQuotedMessage = !!body?.quotedMessage;
    const canUseLastViewedFallback = !hasQuotedMessage || quotedIsTrialArtifact;
    if ((IS_PHOTO_REQUEST || (quotedHasImage && isShortMessage)) && !quotedProductIdx && canUseLastViewedFallback && session.lastViewedProduct) {
      const idx = session.lastViewedProductIndex || 1;
      logger.info({ productIdx: idx, name: session.lastViewedProduct.name }, '[LastViewed] Usando último produto visto');
      await showProductPhotos(from, idx, session);
      persistSession(from);
      return;
    }

    if (IS_PHOTO_REQUEST && session.products?.length > 0) {
      const guide = 'Me diz o número da peça (tá no início da legenda de cada foto) e te mostro todas as imagens 😊';
      appendHistory(session, 'assistant', guide);
      conversationMemory.refreshConversationMemory(session, { assistantText: guide });
      await zapi.sendText(from, guide);
      persistSession(from);
      return;
    }

    // Intercept: botão "Ver Todos" — dispara showAllCategory com a categoria ativa da sessão
    if (text === 'VER_TODOS_CATEGORIA' && session.activeCategory) {
      logger.info({ phone: from, category: session.activeCategory }, '[Intercept] Ver Todos da categoria ativa');
      await showAllCategory(from, session.activeCategory, session);
      persistSession(from);
      return;
    }

    let systemNudge = null;
    if (isFirstContact) {
      systemNudge = `[BOAS-VINDAS: Este é o início do atendimento. Dê uma saudação rápida e carinhosa, e NÃO faça perguntas sobre o que o lojista procura. O sistema vai disparar os lançamentos logo após sua fala por meio do token [VER_TODOS:lancamento-da-semana].]`;
    }

    const promptContext = buildAiContext(session);
    let aiRaw = '';
    try {
      aiRaw = await ai.chat(session.history, promptContext, systemNudge);
    } catch (err) {
      logger.error({ err: err.message }, '[AI] Falha na chamada do Gemini');
      await zapi.sendText(from, 'Poxa, tive um pequeno problema aqui, mas já tô voltando! Pode repetir sua última mensagem? 😊');
      return;
    }
    logger.info({ phone: from, response: aiRaw }, '[AI] Response');

    let { cleanText, action } = ai.parseAction(aiRaw);

    // Mão de Ferro v3 — Se é primeiro contato ou o usuário pediu lançamentos/novidades, 
    // nós FORÇAMOS o catálogo e limpamos qualquer outra ação conflitante.
    const requestedLancamentos = /lan[çc]amento|novidade|o que chegou/i.test(text);
    if (isFirstContact || requestedLancamentos) {
      logger.info({ isFirstContact, requestedLancamentos }, '[HardForce] Forçando catálogo de lançamentos');
      action = { type: 'VER_TODOS', payload: 'lancamento-da-semana' };

      // Limpa qualquer pergunta sobre categorias — o sistema vai mostrar os produtos direto
      if (cleanText.includes('?')) {
        cleanText = cleanText.split('?')[0].trim() + ' 😊';
      }
    }

    // Guard: bloqueia VER/BUSCAR quando a IA pergunta QUAL categoria ver (sem que o cliente pediu).
    const askingForCategory = action &&
      (action.type === 'VER' || action.type === 'BUSCAR') &&
      action.type !== 'VER_TODOS' &&
      cleanText.includes('?') &&
      /qual.*categoria|que tipo|qual.*linha|por onde|qual.*prefer|começa por|começar por/i.test(cleanText);

    if (askingForCategory) {
      logger.info({ actionType: action.type }, '[Guard] Token descartado — IA perguntou sobre categoria → sendList');
      action = null;
      appendHistory(session, 'assistant', cleanText);
      conversationMemory.refreshConversationMemory(session, { assistantText: cleanText });
      await sendCategoryMenu(from, cleanText);
      persistSession(from);
      return;
    }

    // Guard: bloqueia VER/BUSCAR em saudações — IA não deve disparar catálogo em "boa tarde/oi/olá".
    const isGreeting = action &&
      (action.type === 'VER' || action.type === 'BUSCAR') &&
      action.type !== 'VER_TODOS' &&
      /^(o+i+|ol[aá]+|bom dia|boa tarde|boa noite|hey+|hello|tudo bem|tudo bom|e a[ií]|eai|opa|boas)(\s|[!?.,]|$)/i.test(text.trim());

    if (isGreeting) {
      logger.info({ actionType: action.type }, '[Guard] Token descartado — saudação, não pedido de catálogo');
      action = null;
    }

    // Guard: limpa texto quando ação de produto vai disparar (sistema mostra os produtos).
    // Também descarta qualquer lista inventada com preços (R$ ou R\$).
    // Quando o sistema vai mostrar produtos, qualquer texto da IA antes é ruído — descarta.
    // EXCETO para VER_TODOS inicial, onde queremos que a saudação apareça antes.
    if (action && ['VER', 'BUSCAR', 'PROXIMOS'].includes(action.type)) {
      if (cleanText) logger.info({ actionType: action.type }, '[Guard] Texto descartado — ação vai mostrar produtos');
      cleanText = '';
    } else if (action && action.type === 'VER_TODOS') {
      logger.info({ actionType: action.type }, '[Guard] Mantendo texto da saudação antes de exibir todos.');
    } else {
      // Descarta listas com preços em qualquer formato (R$ / R\$ / reais / número decimal)
      const hasNumberedItems = (cleanText.match(/^\s*\d+[\.\)]\s+\S/mg) || []).length >= 2;
      const hasPrices = /R\s*\\?\$\s*\d|reais|\d+[,\.]\d{2}/i.test(cleanText);
      if (hasNumberedItems && hasPrices) {
        logger.info('[Guard] Lista inventada descartada');
        cleanText = '';
      }
    }

    if (cleanText || action) {
      conversationMemory.refreshConversationMemory(session, { assistantText: cleanText, action });
    }
    if (cleanText) appendHistory(session, 'assistant', cleanText);

    // Se a IA está oferecendo categorias no texto (sem action), envia como List Message
    const offeringCategories = !action && cleanText &&
      /qual.*categoria|que tipo|qual.*linha|feminino|masculino|lançamentos/i.test(cleanText) &&
      cleanText.includes('?');

    if (offeringCategories) {
      logger.info('[ListMenu] IA ofereceu categorias no texto → sendList');
      await sendCategoryMenu(from, cleanText);
      persistSession(from);
      return;
    }

    if (cleanText) {
      const shouldSendGreetingAsAudioOnly = isFirstContact && TTS_ENABLED;

      if (shouldSendGreetingAsAudioOnly) {
        try {
          const { buffer, mimeType } = await tts.textToSpeech(cleanText);
          await zapi.sendAudio(from, buffer, mimeType);
        } catch (ttsErr) {
          logger.error({ err: ttsErr?.message || String(ttsErr) }, '[TTS] Greeting fallback to text');
          await zapi.replyText(from, cleanText, messageId);
        }
      } else {
        await zapi.replyText(from, cleanText, messageId);
        if (TTS_ENABLED) {
          try {
            const { buffer, mimeType } = await tts.textToSpeech(cleanText);
            await zapi.sendAudio(from, buffer, mimeType);
          } catch (ttsErr) {
            logger.error({ err: ttsErr?.message || String(ttsErr) }, '[TTS] Error');
          }
        }
      }
    }

    if (action) {
      await executeAction(from, action, session);
    }

    persistSession(from);

  } catch (error) {
    logger.error({ err: error }, '[Webhook] Error');
    const isRateLimit = error.status === 429 || error.message?.includes('429');
    if (isRateLimit && from) {
      await zapi.sendText(from, 'Estou sobrecarregada no momento 😅 Tenta de novo em alguns minutinhos!').catch(() => {});
    }
  }
});

// ── Action Executor ───────────────────────────────────────────────────────

async function executeAction(phone, action, session) {
  switch (action.type) {
    case 'VER_TODOS':
      await showAllCategory(phone, action.payload, session);
      break;

    case 'VER':
      await showCategory(phone, action.payload, session);
      break;

    case 'BUSCAR':
      await searchAndShowProducts(phone, action.payload, session);
      break;

    case 'PROXIMOS':
      await showNextPage(phone, session);
      break;

    case 'FOTOS':
      await showProductPhotos(phone, parseInt(action.payload, 10), session);
      break;

    case 'SELECIONAR': {
      const idx = parseInt(action.payload, 10) - 1;
      const product = session.products[idx];
      if (!product) {
        await zapi.sendText(phone, `❌ Produto #${action.payload} não encontrado na lista atual.`);
        return;
      }
      await startInteractivePurchase(phone, product, session);
      break;
    }

    case 'TAMANHO': {
      const product = session.currentProduct || session.products?.find(p => p.id === session.purchaseFlow.productId);
      if (!product) {
        await zapi.sendText(phone, '❌ Nenhum produto selecionado. Escolha um produto primeiro.');
        return;
      }

      // Resolve payload: can be index (e.g., "2") or size name (e.g., "G", "GG")
      let sizeIdx = -1;
      const numericIdx = parseInt(action.payload, 10);
      if (!isNaN(numericIdx) && numericIdx >= 1 && product.sizes[numericIdx - 1]) {
        sizeIdx = numericIdx - 1;
      } else {
        const sizeName = String(action.payload).toUpperCase().trim();
        sizeIdx = product.sizes.findIndex(s => s.toUpperCase().trim() === sizeName);
      }

      if (sizeIdx < 0 || !product.sizes[sizeIdx]) {
        await zapi.sendText(phone, `❌ Tamanho "${action.payload}" não encontrado. Disponíveis: ${product.sizes.join(' | ')}`);
        await zapi.sendSizeList(phone, product, session.purchaseFlow.interactiveVersion || Date.now());
        return;
      }

      session.purchaseFlow.productId = product.id;
      session.purchaseFlow.productName = product.name;
      session.purchaseFlow.price = parseFloat(product.salePrice || product.price);
      session.purchaseFlow.selectedSize = product.sizes[sizeIdx];
      session.purchaseFlow.state = 'awaiting_quantity';
      session.purchaseFlow.interactiveVersion = Date.now();
      await zapi.sendQuantityList(phone, session.purchaseFlow.selectedSize, session.purchaseFlow.interactiveVersion);
      break;
    }

    case 'QUANTIDADE': {
      const pf = session.purchaseFlow;
      if (pf.state !== 'awaiting_quantity' || !pf.productId || !pf.selectedSize) {
        await zapi.sendText(phone, '❌ Não há produto aguardando quantidade. Escolha um produto e tamanho primeiro.');
        return;
      }
      const qty = parseInt(action.payload, 10);
      if (isNaN(qty) || qty < 1 || qty > 999) {
        await zapi.sendText(phone, '❌ Quantidade inválida. Informe um número entre 1 e 999.');
        return;
      }
      await addToCart(phone, qty, session);
      break;
    }
    /* case '__LEGACY_TAMANHO_UNUSED__': {
      const product = session.currentProduct || session.products?.find(p => p.id === session.purchaseFlow.productId);
      if (!product) {
        await zapi.sendText(phone, '❌ Nenhum produto selecionado. Escolha um produto primeiro.');
        return;
      }
      const sizeIdx = parseInt(action.payload, 10) - 1;
      if (isNaN(sizeIdx) || !product.sizes[sizeIdx]) {
        await zapi.sendText(phone, `❌ Tamanho inválido. Escolha entre 1 e ${product.sizes.length}.`);
        await zapi.sendSizeList(phone, product, session.purchaseFlow.interactiveVersion || Date.now());
        return;
      }
      session.purchaseFlow.productId = product.id;
      session.purchaseFlow.productName = product.name;
        productId: product.id,
        productName: product.name,
        size,
        price: product.salePrice || product.price,
      });
      session.currentProduct = null;
      
      const itemCount = session.items.length;
      const cartTotal = session.items.reduce((acc, it) => acc + parseFloat(it.price), 0);
      const nudge = `[SISTEMA: O item "${product.name}" tamanho ${size} foi adicionado ao carrinho. Carrinho: ${itemCount} itens, total ${woocommerce.formatPrice(cartTotal)}. Confirme de forma natural e pergunte se quer mais algo ou finalizar.]`;
      appendHistory(session, 'system', nudge);
      conversationMemory.refreshConversationMemory(session, { action: { type: 'SELECIONAR', payload: String(idx + 1) } });

      try {
        const aiRaw = await ai.chat(session.history, buildAiContext(session));
        const { cleanText } = ai.parseAction(aiRaw);
        const reply = cleanText || `✅ *${product.name}* (${size}) adicionado! Quer mais algo?`;
        appendHistory(session, 'assistant', reply);
        conversationMemory.refreshConversationMemory(session, { assistantText: reply });
        await zapi.sendText(phone, reply);
      } catch (err) {
        await zapi.sendText(phone, `✅ *${product.name}* (${size}) adicionado!`);
      }
      break;
    }

    */
    case 'CARRINHO':
      await showCart(phone, session);
      break;

    case 'LIMPAR_CARRINHO':
      await clearCart(phone, session);
      break;

    case 'REMOVER': {
      const itemIdx = parseInt(action.payload, 10) - 1;
      if (isNaN(itemIdx) || !session.items[itemIdx]) {
        await showCart(phone, session);
        return;
      }
      const removed = session.items.splice(itemIdx, 1)[0];
      await zapi.sendText(phone, `🗑️ *${removed.productName}* removido.`);
      if (session.items.length > 0) await showCart(phone, session);
      break;
    }

    case 'COMPRAR_DIRETO': {
      const { productIdx, size, qty } = action.payload || {};
      const product = session.products?.[productIdx - 1];
      if (!product) {
        await zapi.sendText(phone, `❌ Produto #${productIdx} não encontrado na lista atual.`);
        return;
      }
      // Valida se o tamanho solicitado existe
      const sizeNorm = String(size).toUpperCase().trim();
      const matchedSize = product.sizes.find(s => s.toUpperCase().trim() === sizeNorm);
      if (!matchedSize) {
        let msg = `⚠️ Tamanho "${size}" não disponível para *${product.name}*.`;
        if (product.sizes.length > 0) {
          msg += `\nTamanhos disponíveis: ${product.sizes.join(' | ')}`;
        }
        await zapi.sendText(phone, msg);
        return;
      }
      // Configura o purchaseFlow e adiciona ao carrinho
      const pf = session.purchaseFlow;
      pf.productId = product.id;
      pf.productName = product.name;
      pf.price = parseFloat(product.salePrice || product.price);
      pf.selectedSize = matchedSize;
      await addToCart(phone, qty || 1, session);
      break;
    }

    case 'HANDOFF':
      await handoffToConsultant(phone, session);
      break;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function sendLoadingMessage(phone, textFallback, ttsPhrase) {
  if (TTS_ENABLED) {
    try {
      const { buffer, mimeType } = await tts.textToSpeech(ttsPhrase);
      await zapi.sendAudio(phone, buffer, mimeType);
      return;
    } catch (err) {
      logger.error({ err: err?.message || String(err) }, '[TTS] Fallback to text for loading msg');
    }
  }
  await zapi.sendText(phone, textFallback);
}

function registerMessageProduct(session, zaapId, messageId, product) {
  if (!product || !session.messageProductMap) return;
  const idx = session.products?.indexOf(product);
  const entry = { productId: product.id, productIdx: (idx >= 0 ? idx + 1 : null) };
  // Armazena pelo messageId (ID real do WhatsApp — usado no referenceMessageId do webhook)
  if (messageId) session.messageProductMap[messageId] = entry;
  // Também pelo zaapId como fallback de compatibilidade
  if (zaapId) session.messageProductMap[zaapId] = entry;
  const keys = Object.keys(session.messageProductMap);
  if (keys.length > 50) keys.slice(0, 25).forEach(k => delete session.messageProductMap[k]);
  // Auditoria estrutural: registra os IDs exatos persistidos para rastrear
  // o caminho ida→volta com o reply do webhook.
  logger.info({
    productId: product.id,
    productIdx: entry.productIdx,
    productName: product.name,
    zaapId: zaapId || null,
    messageId: messageId || null,
    mapSize: keys.length,
  }, '[MessageMap] Produto registrado');
}

/**
 * Adiciona um item ao carrinho silenciosamente (sem mensagem, sem menu).
 * Usado pelo grade parser para batch insert antes de enviar uma confirmação consolidada.
 */
function pushCartItem(session, productId, productName, size, qty, unitPrice) {
  if (!productId || !size || !qty || qty < 1) return;
  const price = unitPrice * qty;
  session.items.push({ productId, productName, size, quantity: qty, unitPrice, price });
  const pf = session.purchaseFlow;
  if (Array.isArray(pf.addedSizes) && !pf.addedSizes.includes(size)) {
    pf.addedSizes.push(size);
  }
}

function getCartStats(session) {
  const lineItems = Array.isArray(session.items) ? session.items.length : 0;
  const totalPieces = Array.isArray(session.items)
    ? session.items.reduce((acc, item) => acc + (parseInt(item.quantity, 10) || 1), 0)
    : 0;

  return { lineItems, totalPieces };
}

/**
 * Adiciona ao carrinho o item em foco na FSM (purchaseFlow.selectedSize + qty),
 * envia confirmação e chama sendPostAddMenu.
 * Chamado por: FSM qty_, texto manual de quantidade, executeAction QUANTIDADE/COMPRAR_DIRETO.
 */
async function addToCart(phone, qty, session) {
  const pf = session.purchaseFlow;

  if (!pf.productId || !pf.selectedSize) {
    await zapi.sendText(phone, '❌ Nenhum produto/tamanho em foco. Escolha um produto primeiro.');
    return;
  }

  const unitPrice = pf.price || 0;
  const price = unitPrice * qty;

  session.items.push({
    productId: pf.productId,
    productName: pf.productName,
    size: pf.selectedSize,
    quantity: qty,
    unitPrice,
    price,
  });

  if (!Array.isArray(pf.addedSizes)) pf.addedSizes = [];
  if (!pf.addedSizes.includes(pf.selectedSize)) {
    pf.addedSizes.push(pf.selectedSize);
  }

  const cartTotal = session.items.reduce((acc, it) => acc + parseFloat(it.price || 0), 0);
  const { lineItems, totalPieces } = getCartStats(session);
  const confirmMsg = `✅ *${pf.productName}* (${pf.selectedSize}) x${qty} adicionado!\n\n🛒 Carrinho: ${totalPieces} ${totalPieces === 1 ? 'peça' : 'peças'} em ${lineItems} ${lineItems === 1 ? 'item' : 'itens'} — *${woocommerce.formatPrice(cartTotal)}*`;

  appendHistory(session, 'assistant', confirmMsg);
  conversationMemory.refreshConversationMemory(session, { assistantText: confirmMsg, action: { type: 'CARRINHO' } });

  const product = session.products?.find(p => p.id === pf.productId);
  const remainingSizes = product?.sizes?.filter(s => !pf.addedSizes.includes(s)) ?? [];

  pf.state = 'awaiting_more_sizes';
  pf.selectedSize = null;
  pf.interactiveVersion = Date.now();

  logger.info({ phone, productId: pf.productId, qty, cartItems: session.items.length }, '[addToCart] Item adicionado');

  // Se há próximo produto na fila e não há mais tamanhos, processa a fila automaticamente
  if (remainingSizes.length === 0 && pf.buyQueue?.length > 0) {
    await sendPostAddMenu(phone, session, remainingSizes, confirmMsg);
  } else {
    await sendPostAddMenu(phone, session, remainingSizes, confirmMsg);
  }
}

/**
 * Intercepta cart_finalize quando há produtos na buyQueue.
 * Retorna true se interceptou (webhook deve dar return), false caso contrário.
 */
async function handleQueueGuard(phone, eventId, session) {
  const pf = session.purchaseFlow;
  const queueLength = pf?.buyQueue?.length || 0;

  // Usuário escolheu continuar com a fila
  if (eventId === 'queue_continue') {
    logger.info({ phone }, '[QueueGuard] Cliente escolheu processar fila');
    const hadNext = await processNextInQueue(phone, session);
    if (!hadNext) {
      await sendCartOptions(phone, session, '😊 Fila vazia! Quer revisar o carrinho ou finalizar?');
    }
    return true;
  }

  // Usuário escolheu finalizar mesmo assim → limpa fila e encaminha handoff
  if (eventId === 'queue_finalize_anyway') {
    logger.info({ phone, discarded: queueLength }, '[QueueGuard] Cliente optou finalizar ignorando fila');
    pf.buyQueue = [];
    await handoffToConsultant(phone, session);
    return true;
  }

  // Interceptar cart_finalize quando há fila
  if (eventId === 'cart_finalize' && queueLength > 0) {
    const queueNames = pf.buyQueue.map(q => `• ${q.productName}`).join('\n');
    const warningMsg = `⚠️ Amor, você ainda tem ${queueLength} ${queueLength === 1 ? 'produto' : 'produtos'} na fila:\n\n${queueNames}\n\nQuer separar esses antes de fechar o pedido?`;

    const options = [
      { id: 'queue_continue', title: 'Sim, separar a fila', description: `Continuar com ${pf.buyQueue[0].productName}` },
      { id: 'queue_finalize_anyway', title: 'Não, finalizar mesmo', description: 'Fechar pedido com o que tenho' },
      { id: 'cart_view', title: 'Ver Carrinho', description: 'Conferir antes de decidir' },
    ];

    logger.info({ phone, queueLength }, '[QueueGuard] Avisando sobre fila pendente');
    await zapi.sendOptionList(phone, warningMsg, 'Fila Pendente', 'Escolher', options);
    return true;
  }

  return false;
}

/**
 * Gerencia eventos interativos (botões e listas) da FSM de compra.
 * Prefixos tratados: buy_ | size_ | qty_ | add_size_ | skip_more_
 */
async function handlePurchaseFlowEvent(phone, eventId, session) {
  const pf = session.purchaseFlow;

  // ── buy_{productId}_v{version} ─────────────────────────────────────────
  if (eventId.startsWith('buy_')) {
    const parts = eventId.split('_');        // ['buy', '422', 'v12345']
    const productIdStr = parts[1];
    const productId = parseInt(productIdStr, 10);
    const product = session.products?.find(p => p.id === productId || String(p.id) === productIdStr)
                 || session.lastViewedProduct;

    if (!product) {
      await zapi.sendText(phone, '❌ Não consegui localizar esse produto. Me chama no catálogo que te mostro de novo 😊');
      return;
    }

    // Se outro produto já está em fluxo, enfileira o novo e aguarda
    if (pf.state !== 'idle' && pf.productId && pf.productId !== productId) {
      if (!Array.isArray(pf.buyQueue)) pf.buyQueue = [];
      const alreadyQueued = pf.buyQueue.some(q => q.productId === product.id);
      if (!alreadyQueued) {
        pf.buyQueue.push({ productId: product.id, productName: product.name });
        logger.info({ phone, productId: product.id, queueLength: pf.buyQueue.length }, '[FSM] Produto enfileirado');

        // Resolve o produto atualmente em foco para calcular tamanhos restantes
        const currentProduct = session.products?.find(p => p.id === pf.productId);
        const remainingSizes = currentProduct?.sizes?.filter(s => !pf.addedSizes?.includes(s)) ?? [];

        const queueMsg = `✅ *${product.name}* adicionado à fila! Termino o atual e já vamos pra ele 😊`;
        await sendPostAddMenu(phone, session, remainingSizes, queueMsg);
      } else {
        await zapi.sendText(phone, `🙂 *${product.name}* já estava na fila, amor!`);
      }
      return;
    }

    logger.info({ phone, productId: product.id }, '[FSM] buy_ → startInteractivePurchase');
    pf.lastClickedProductId = product.id;
    pf.lastClickedProductName = product.name;
    pf.lastClickedProductTimestamp = Date.now();
    await startInteractivePurchase(phone, product, session);
    return;
  }

  // ── size_{productId}_{size}_v{version} ────────────────────────────────
  if (eventId.startsWith('size_')) {
    // Formato: size_422_P_v1234567890  →  remove prefixo e sufixo de versão
    const withoutPrefix = eventId.slice('size_'.length);              // '422_P_v1234567890'
    const vIdx = withoutPrefix.lastIndexOf('_v');
    const withoutVersion = vIdx >= 0 ? withoutPrefix.slice(0, vIdx) : withoutPrefix;  // '422_P'
    const firstUnderscore = withoutVersion.indexOf('_');
    const productIdStr = withoutVersion.slice(0, firstUnderscore);    // '422'
    const size = withoutVersion.slice(firstUnderscore + 1);           // 'P'

    const product = session.products?.find(p => String(p.id) === productIdStr)
                 || session.products?.find(p => p.id === pf.productId);

    if (!product || !size) {
      await zapi.sendText(phone, '❌ Não consegui identificar o tamanho. Tenta de novo?');
      if (product) await zapi.sendSizeList(phone, product, pf.interactiveVersion || Date.now(), pf.addedSizes || []);
      return;
    }

    if (!product.sizes.includes(size)) {
      await zapi.sendText(phone, `❌ Tamanho "${size}" não disponível. Disponíveis: ${product.sizes.join(' | ')}`);
      await zapi.sendSizeList(phone, product, pf.interactiveVersion || Date.now(), pf.addedSizes || []);
      return;
    }

    pf.productId = product.id;
    pf.productName = product.name;
    pf.price = parseFloat(product.salePrice || product.price);
    pf.selectedSize = size;
    pf.state = 'awaiting_quantity';
    pf.interactiveVersion = Date.now();

    logger.info({ phone, productId: product.id, size }, '[FSM] size_ → awaiting_quantity');
    await zapi.sendQuantityList(phone, size, pf.interactiveVersion);
    return;
  }

  // ── qty_{qty}_v{version} ──────────────────────────────────────────────
  if (eventId.startsWith('qty_')) {
    // Formato: qty_3_v1234567890  →  extrai o número antes de '_v'
    const withoutPrefix = eventId.slice('qty_'.length);              // '3_v1234567890'
    const vIdx = withoutPrefix.indexOf('_v');
    const qtyStr = vIdx >= 0 ? withoutPrefix.slice(0, vIdx) : withoutPrefix;
    const qty = parseInt(qtyStr, 10);

    if (isNaN(qty) || qty < 1) {
      await zapi.sendText(phone, '❌ Quantidade inválida. Escolhe de novo?');
      if (pf.selectedSize) await zapi.sendQuantityList(phone, pf.selectedSize, pf.interactiveVersion || Date.now());
      return;
    }

    logger.info({ phone, qty }, '[FSM] qty_ → addToCart');
    await addToCart(phone, qty, session);
    return;
  }

  // ── add_size_v{version} ───────────────────────────────────────────────
  if (eventId.startsWith('add_size_')) {
    const product = session.products?.find(p => p.id === pf.productId);
    if (!product) {
      await zapi.sendText(phone, '❌ Produto não encontrado. Vamos voltar ao catálogo?');
      return;
    }

    const excludeSizes = Array.isArray(pf.addedSizes) ? [...pf.addedSizes] : [];
    pf.state = 'awaiting_size';
    pf.selectedSize = null;
    pf.interactiveVersion = Date.now();

    logger.info({ phone, productId: product.id, excludeSizes }, '[FSM] add_size_ → sendSizeList');
    await zapi.sendSizeList(phone, product, pf.interactiveVersion, excludeSizes);
    return;
  }

  // ── skip_more_v{version} ──────────────────────────────────────────────
  if (eventId.startsWith('skip_more_')) {
    logger.info({ phone }, '[FSM] skip_more_ → processNextInQueue');
    const hadNext = await processNextInQueue(phone, session);
    if (!hadNext) {
      await sendCartOptions(phone, session, '😊 Não tem mais produtos na fila! Quer revisar o carrinho ou continuar comprando?');
    }
    return;
  }

  logger.warn({ phone, eventId }, '[FSM] Evento não reconhecido');
}

function resetPurchaseFlow(session) {
  // Preserva a fila antes de resetar
  const savedQueue = session.purchaseFlow.buyQueue || [];
  session.purchaseFlow = createDefaultPurchaseFlow();
  session.purchaseFlow.buyQueue = savedQueue;
  session.currentProduct = null;
}

// Processa o próximo item da fila de compras
async function processNextInQueue(phone, session) {
  const pf = session.purchaseFlow;
  if (!pf.buyQueue || pf.buyQueue.length === 0) return false;

  const next = pf.buyQueue.shift();
  const product = session.products?.find(p => p.id === next.productId);

  if (!product) {
    logger.warn({ phone, productId: next.productId }, '[FSM] Produto da fila não encontrado, pulando');
    // Tenta o próximo da fila recursivamente
    return processNextInQueue(phone, session);
  }

  const remaining = pf.buyQueue.length;
  const queueMsg = remaining > 0
    ? `\n📋 Ainda ${remaining === 1 ? 'tem 1 peça' : `tem ${remaining} peças`} na fila!`
    : '';

  await zapi.sendText(phone, `Agora vamos para *${product.name}*! 😊${queueMsg}`);

  pf.state = 'awaiting_size';
  pf.productId = product.id;
  pf.productName = product.name;
  pf.price = parseFloat(product.salePrice || product.price);
  pf.selectedSize = null;
  pf.addedSizes = [];
  pf.interactiveVersion = Date.now();
  pf.lastClickedProductId = product.id;
  pf.lastClickedProductName = product.name;
  pf.lastClickedProductTimestamp = Date.now();

  logger.info({ phone, productId: product.id, queueRemaining: remaining }, '[FSM] Processando próximo da fila');
  await zapi.sendSizeList(phone, product, pf.interactiveVersion);
  return true;
}

function buildCartSummary(session, title = '🛒 *SEU CARRINHO*') {
  let total = 0;
  let summary = `${title}\n─────────────────\n`;

  session.items.forEach((item, idx) => {
    const qty = item.quantity || 1;
    const subtotal = parseFloat(item.price);
    total += subtotal;
    const qtyLabel = qty > 1 ? ` x${qty}` : '';
    summary += `${idx + 1}. *${item.productName}* (${item.size})${qtyLabel} — ${woocommerce.formatPrice(subtotal)}\n`;
  });

  summary += `─────────────────\n💰 *Total: ${woocommerce.formatPrice(total)}*`;
  return { summary, total };
}

async function showCart(phone, session) {
  if (!session.items || session.items.length === 0) {
    await zapi.sendText(phone, '🛒 Seu carrinho está vazio por enquanto. Quer dar uma olhadinha no catálogo?');
    return;
  }
  const { summary } = buildCartSummary(session);
  await sendCartOptions(phone, session, summary);
}

async function sendCartOptions(phone, session, text = 'O que você prefere fazer agora?') {
  const itemLabel = `${session.items.length} ${session.items.length === 1 ? 'item' : 'itens'}`;
  const options = [
    { id: 'cart_finalize', title: 'Finalizar Pedido', description: 'Encaminhar para fechamento' },
    { id: 'cart_view', title: 'Ver Carrinho', description: itemLabel },
    { id: 'cart_more_products', title: 'Ver Mais Produtos', description: 'Continuar comprando' },
    { id: 'falar_atendente', title: 'Falar com Humano', description: 'Tirar dúvidas agora' },
  ];

  await zapi.sendOptionList(phone, text, 'Próximo Passo', 'Escolher', options);
}

async function sendPostAddMenu(phone, session, remainingSizes, customText = null) {
  const pf = session.purchaseFlow;
  const queueLength = pf.buyQueue?.length || 0;
  const options = [];

  if (remainingSizes.length > 0) {
    options.push({
      id: `add_size_v${pf.interactiveVersion}`,
      title: 'Outro Tamanho',
      description: `Ainda temos ${remainingSizes.join(' | ')}`,
    });
  }

  // When there are queued products, show "Next Product" button (uses skip_more_ prefix → processed by FSM)
  if (queueLength > 0) {
    const nextInQueue = pf.buyQueue[0];
    options.push({
      id: `skip_more_v${pf.interactiveVersion}`,
      title: 'Próximo Produto',
      description: nextInQueue.productName,
    });
  }

  options.push(
    { id: 'cart_view', title: 'Ver Carrinho', description: 'Conferir os itens escolhidos' },
    { id: 'cart_finalize', title: 'Finalizar Pedido', description: 'Encaminhar para fechamento' },
  );

  // Only show "Ver Mais Produtos" when there are no queued items (queue takes priority)
  if (queueLength === 0) {
    options.push({ id: 'cart_more_products', title: 'Ver Mais Produtos', description: 'Continuar comprando' });
  }

  let menuText = customText;
  if (!menuText && queueLength > 0) {
    const queueInfo = queueLength === 1
      ? `Ainda tem *${pf.buyQueue[0].productName}* na fila!`
      : `Ainda tem *${queueLength} peças* na fila!`;
    menuText = remainingSizes.length > 0
      ? `Perfeito 😊 Quer outro tamanho de *${pf.productName}* ou vamos para o próximo? ${queueInfo}`
      : `Perfeito 😊 ${queueInfo} Vamos para o próximo produto?`;
  } else if (!menuText) {
    menuText = remainingSizes.length > 0
      ? `Perfeito 😊 Quer separar outro tamanho de *${pf.productName}* ou seguimos?`
      : 'Perfeito 😊 Quer revisar o carrinho, finalizar ou continuar comprando?';
  }

  await zapi.sendOptionList(phone, menuText, 'Próximo Passo', 'Escolher', options);
}

async function startInteractivePurchase(phone, product, session, introText = null) {
  if (!product) {
    await zapi.sendText(phone, '❌ Não consegui localizar esse produto. Me chama no catálogo que eu te mostro de novo 😊');
    return false;
  }

  session.currentProduct = product;
  session.purchaseFlow.state = 'awaiting_size';
  session.purchaseFlow.productId = product.id;
  session.purchaseFlow.productName = product.name;
  session.purchaseFlow.price = parseFloat(product.salePrice || product.price);
  session.purchaseFlow.selectedSize = null;
  session.purchaseFlow.addedSizes = [];
  session.purchaseFlow.interactiveVersion = Date.now();

  if (introText) {
    await zapi.sendText(phone, introText);
  }

  await zapi.sendSizeList(phone, product, session.purchaseFlow.interactiveVersion);
  return true;
}

// ── Flow Functions ────────────────────────────────────────────────────────

async function showCategory(phone, slug, session) {
  slug = normalizeCategorySlug(slug);
  await sendLoadingMessage(
    phone,
    `🔍 Buscando produtos *${slug.toUpperCase()}*...`,
    `Um momento, amor! Já estou separando os melhores modelos da linha ${slug} pra você!`
  );

  try {
    const result = await woocommerce.getProductsByCategory(slug, 10, 1);

    if (result.products.length === 0) {
      await zapi.sendText(phone, `😕 Nenhum produto encontrado em *${slug}*.`);
      return;
    }

    session.products = result.products;
    session.currentCategory = slug;
    session.activeCategory = slug;
    session.currentPage = result.page;
    session.totalPages = result.totalPages;
    session.totalProducts = result.total;

    await sendProductPage(phone, result, session);
  } catch (err) {
    logger.error({ slug, code: err.code, status: err.response?.status, err: err.message }, '[showCategory] Error');
    await zapi.sendText(phone, '⚠️ Erro ao buscar produtos.');
  }
}

async function showAllCategory(phone, slug, session) {
  slug = normalizeCategorySlug(slug);
  await sendLoadingMessage(
    phone,
    `🔍 Buscando os melhores modelos para você...`,
    `Um momento, amor! Estou te encaminhando todos os nossos modelos dessa linha!`
  );

  try {
    // Busca em blocos de 100 e agrega todas as páginas para realmente exibir "todos".
    const firstPage = await woocommerce.getProductsByCategory(slug, 100, 1);

    if (firstPage.products.length === 0) {
      await zapi.sendText(phone, `😕 Nenhum produto da categoria *${slug}* disponível no momento.`);
      return;
    }

    let allProducts = [...firstPage.products];
    for (let page = 2; page <= firstPage.totalPages; page++) {
      const next = await woocommerce.getProductsByCategory(slug, 100, page);
      allProducts = [...allProducts, ...next.products];
      await zapi.delay(200);
    }

    session.products = allProducts;
    session.currentCategory = slug;
    session.activeCategory = slug;
    session.currentPage = 1;
    session.totalPages = 1; // Já agregamos tudo na sessão.
    session.totalProducts = allProducts.length;

    let msg = `✨ *${slug.toUpperCase()}* ✨\n\n`;
    
    allProducts.forEach((p, i) => {
      const price = woocommerce.formatPrice(p.salePrice || p.price);
      msg += `${i + 1}. *${p.name}* — ${price}\n`;
    });

    await zapi.sendText(phone, msg);

    // Gera a versão UMA VEZ antes do loop — todos os botões do lote compartilham a mesma versão
    session.purchaseFlow.interactiveVersion = Date.now();
    for (const [i, product] of allProducts.entries()) {
      if (product.imageUrl) {
        try {
          const scRes = await zapi.sendProductShowcase(phone, product, session.purchaseFlow.interactiveVersion);
          registerMessageProduct(session, scRes?.data?.zaapId, scRes?.data?.messageId, product);
        } catch {
          // Fallback para sendImage se o endpoint de botão não suportar imagem
          const imgRes = await zapi.sendImage(phone, product.imageUrl, woocommerce.buildCaption(product, i + 1));
          registerMessageProduct(session, imgRes?.data?.zaapId, imgRes?.data?.messageId, product);
        }
        await zapi.delay(400);
      }
    }

    if (allProducts.length > 0) {
      session.lastViewedProduct = allProducts[allProducts.length - 1];
      session.lastViewedProductIndex = allProducts.length;
    }

    const nudge = `[SISTEMA: Você acabou de mostrar a lista inteira de lançamentos da semana de uma única vez. Pergunte com carisma se a cliente gostou de alguma peça (ela pode dizer o número da peça) ou se prefere ver outras categorias (feminino, masculino ou infantil e se preferir ir além, ver as promoções).]`;
    appendHistory(session, 'system', nudge);
    conversationMemory.refreshConversationMemory(session, { action: { type: 'VER_TODOS', payload: slug } });
    
    const aiRaw = await ai.chat(session.history, buildAiContext(session));
    const { cleanText } = ai.parseAction(aiRaw);
    if (cleanText) {
      appendHistory(session, 'assistant', cleanText);
      conversationMemory.refreshConversationMemory(session, { assistantText: cleanText });
      
      if (session.items.length > 0) {
        await sendCartOptions(phone, session, cleanText);
      } else {
        await sendCategoryMenu(phone, cleanText);
      }
    }
  } catch (err) {
    logger.error({ slug, code: err.code, err: err.message }, '[showAllCategory] Error');
    await zapi.sendText(phone, '⚠️ Erro ao buscar itens de uma vez só.');
  }
}

async function showNextPage(phone, session) {
  if (!session.currentCategory || session.currentPage >= session.totalPages) {
    await zapi.sendText(phone, '✅ Todos os produtos já foram mostrados.');
    return;
  }

  try {
    const nextPage = session.currentPage + 1;
    const result = await woocommerce.getProductsByCategory(session.currentCategory, 10, nextPage);

    const startIdx = session.products.length;
    session.products = [...session.products, ...result.products];
    session.currentPage = result.page;

    await sendProductPage(phone, result, session, startIdx);
  } catch (err) {
    logger.error({ err: err.message }, '[showNextPage] Error');
    await zapi.sendText(phone, '⚠️ Erro ao carregar mais produtos.');
  }
}

async function sendProductPage(phone, result, session, startIdx = 0) {
  let msg = `📦 *${session.currentCategory.toUpperCase()}* — Produtos ${startIdx + 1}–${session.products.length} de ${result.total}:\n`;

  result.products.forEach((p, i) => {
    const price = woocommerce.formatPrice(p.salePrice || p.price);
    msg += `${startIdx + i + 1}. *${p.name}* — ${price}\n`;
  });

  await zapi.sendText(phone, msg);

  session.purchaseFlow.interactiveVersion = Date.now();
  for (const [i, product] of result.products.entries()) {
    if (product.imageUrl) {
      try {
        const scRes = await zapi.sendProductShowcase(phone, product, session.purchaseFlow.interactiveVersion);
        registerMessageProduct(session, scRes?.data?.zaapId, scRes?.data?.messageId, product);
      } catch {
        const imgRes = await zapi.sendImage(phone, product.imageUrl, woocommerce.buildCaption(product, startIdx + i + 1));
        registerMessageProduct(session, imgRes?.data?.zaapId, imgRes?.data?.messageId, product);
      }
      await zapi.delay(400);
    }
  }

  if (result.products.length > 0) {
    session.lastViewedProduct = result.products[result.products.length - 1];
    session.lastViewedProductIndex = session.products.length;
  }

  const hasMore = session.currentPage < session.totalPages;
  const nudge = hasMore
    ? `[SISTEMA: Você mostrou a página ${session.currentPage} de ${session.totalPages}. Pergunte se a cliente gostou de alguma peça ou se quer ver mais produtos (ação PROXIMOS).]`
    : `[SISTEMA: Você mostrou todos os produtos disponíveis. Pergunte se a cliente gostou de alguma peça ou quer ver outra categoria.]`;
  appendHistory(session, 'system', nudge);
  conversationMemory.refreshConversationMemory(session, { action: { type: 'VER_CATEGORIA', payload: session.currentCategory } });

  const aiRaw = await ai.chat(session.history, buildAiContext(session));
  const { cleanText } = ai.parseAction(aiRaw);
  if (cleanText) {
    appendHistory(session, 'assistant', cleanText);
    conversationMemory.refreshConversationMemory(session, { assistantText: cleanText });
    if (session.items.length > 0) {
      await sendCartOptions(phone, session, cleanText);
    } else {
      await sendCategoryMenu(phone, cleanText);
    }
  }
}

app.get('/', (_req, res) => res.json({ status: 'online', activeSessions: Object.keys(sessions).length }));

app.listen(PORT, () => {
  logger.info({ port: PORT }, '🚀 Agente Belux running');
});
