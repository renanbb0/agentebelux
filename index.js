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
const semantic = require('./services/semantic');

const TTS_ENABLED = process.env.TTS_ENABLED === 'true';

const app = express();
app.use(express.json());

const http = require('http');
const { Server } = require('socket.io');
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
global.visualIo = io;

const PORT = process.env.PORT || 3000;
const ADMIN_PHONE = process.env.ADMIN_PHONE || null;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes inactivity
const MAX_HISTORY_MESSAGES = parseInt(process.env.MAX_HISTORY_MESSAGES || '80', 10);
// Janela deslizante de contexto enviada ao Gemini. Turnos mais antigos que
// CONTEXT_WINDOW_MS são arquivados em conversationMemory.archivedSummary.
// SESSION_TIMEOUT_MS (30min) continua sendo o TTL do carrinho/FSM — a janela
// de 20min afeta apenas o que a IA vê no prompt.
const CONTEXT_WINDOW_MS = parseInt(process.env.CONTEXT_WINDOW_MS || String(20 * 60 * 1000), 10);
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

  // Produto de tamanho único: aceita qualquer número digitado como quantidade
  // Ex: "5", "5 pacotes", "5 unidades", "quero 5", "5 peças"
  if (knownSizes.length === 1) {
    const singleMatch = text.trim().match(/^(?:quero\s+)?(\d{1,3})\s*(?:pe[çc]as?|unidades?|pacotes?|pares?|itens?|pc|pcs|un?)?$/i);
    if (singleMatch) {
      const qty = parseInt(singleMatch[1], 10);
      if (qty > 0 && qty <= 999) {
        return [{ size: knownSizes[0], qty }];
      }
    }
  }

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
const sessionLoadLocks = new Map();
const persistQueues = new Map();

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

const CATEGORY_DISPLAY_NAMES = {
  'feminino':             'Feminino',
  'femininoinfantil':     'Feminino Infantil',
  'masculino':            'Masculino',
  'masculinoinfantil':    'Masculino Infantil',
  'lancamento-da-semana': 'Lançamentos da Semana',
};

function getCategoryDisplayName(slug) {
  return CATEGORY_DISPLAY_NAMES[slug] || slug;
}

const CAT_SENTINELS = {
  'CAT_FEMININO':          'feminino',
  'CAT_FEMININOINFANTIL':  'femininoinfantil',
  'CAT_MASCULINO':         'masculino',
  'CAT_MASCULINOINFANTIL': 'masculinoinfantil',
  'CAT_LANCAMENTOS':       'lancamento-da-semana',
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
    // Fonte do último commit de grade: 'text' (cliente mandou grade textual,
    // ex.: "3P 2M") ou 'button' (clicou em tamanho+quantidade pelo menu).
    // Commit textual é tratado como "grade fechada" no switchFsmFocus —
    // não enfileira o produto antigo, focando direto no novo citado.
    lastCommitSource: null,
    // Fila de compras: acumula buy_ clicks enquanto FSM está ocupada
    buyQueue: [],
  };
}

const MAX_HISTORY_BYTES = 30 * 1024; // 30 KB

function trimSessionHistory(session) {
  if (!Array.isArray(session.history)) return;

  // Limite por contagem
  if (session.history.length > MAX_HISTORY_MESSAGES) {
    session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
  }

  // Limite secundário por bytes
  while (session.history.length > 1) {
    const bytes = Buffer.byteLength(JSON.stringify(session.history), 'utf8');
    if (bytes <= MAX_HISTORY_BYTES) break;
    session.history = session.history.slice(1); // remove a mensagem mais antiga
  }
}

function appendHistory(session, role, content) {
  if (!content) return;
  session.history.push({ role, content, ts: Date.now() });
  trimSessionHistory(session);
}

/**
 * Retorna as mensagens da janela deslizante de CONTEXT_WINDOW_MS.
 * Turnos mais antigos são movidos para o arquivo resumido (archivedSummary)
 * via conversationMemory.archiveStaleTurns e REMOVIDOS de session.history
 * — assim o prompt do Gemini só recebe o que está dentro da janela.
 *
 * Entradas legadas sem `ts` são tratadas como recentes (não arquivadas)
 * para evitar regressão em sessões persistidas antes desta mudança.
 */
function getActiveHistoryWindow(session) {
  if (!Array.isArray(session.history) || session.history.length === 0) return [];

  const cutoff = Date.now() - CONTEXT_WINDOW_MS;
  const stale = [];
  const active = [];

  for (const entry of session.history) {
    // Sem ts (legado) → considera dentro da janela
    if (!entry.ts || entry.ts >= cutoff) {
      active.push(entry);
    } else {
      stale.push(entry);
    }
  }

  if (stale.length > 0) {
    conversationMemory.archiveStaleTurns(session, stale);
    session.history = active;
    logger.info(
      { archived: stale.length, remaining: active.length },
      '[ContextWindow] Turnos antigos comprimidos para archivedSummary'
    );
  }

  return active;
}

function buildFsmContext(session) {
  const pf = session.purchaseFlow;
  if (!pf || pf.state === 'idle') return null;

  const product = getLoadedProductById(session, pf.productId) || session.currentProduct;
  const lines = [
    `[ESTADO ATUAL DA COMPRA]`,
    `Produto em foco: ${pf.productName || 'desconhecido'}`,
    `Etapa: ${pf.state}`,
  ];

  if (pf.state === 'awaiting_size' && product?.sizes?.length) {
    const availableSizes = getAvailableSizesForSession(session, product);
    lines.push(`Tamanhos disponíveis: ${availableSizes.map((s, i) => `${i + 1}=${s}`).join(', ')}`);
    lines.push(`→ O cliente precisa escolher UM tamanho. Se ele disser "G", "M", "P" etc., use [TAMANHO:G]. Se disser o número, use [TAMANHO:2].`);
  }

  if (pf.state === 'awaiting_quantity') {
    lines.push(`Tamanho já escolhido: ${pf.selectedSize}`);
    lines.push(`→ O cliente precisa dizer QUANTAS peças quer. Use [QUANTIDADE:N] com o número.`);
  }

  if (pf.state === 'awaiting_more_sizes') {
    lines.push(`Tamanhos já adicionados: ${pf.addedSizes?.join(', ') || 'nenhum'}`);
    const remaining = getAvailableSizesForSession(session, product, pf.addedSizes || []);
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

function buildAiContext(session, extraBlocks = []) {
  const blocks = [conversationMemory.buildConversationContext(session)];
  const fsmContext = buildFsmContext(session);
  const catalogContext = woocommerce.buildCatalogContext(session);

  if (fsmContext) blocks.push(fsmContext);
  if (catalogContext) blocks.push(catalogContext);
  if (Array.isArray(extraBlocks)) blocks.push(...extraBlocks);

  return blocks.filter(Boolean).join('\n\n');
}

function normalizeCategorySlug(slug) {
  if (!slug) return null;
  return SLUG_MAP[slug.toLowerCase()] || slug.toLowerCase();
}

function clearSupportMode(session, reason = 'unknown') {
  if (!session?.supportMode) return;
  logger.info({ supportMode: session.supportMode, reason }, '[SupportMode] Clearing support mode');
  session.supportMode = null;
}

function isShoppingResumeIntent(analysis) {
  if (!analysis) return false;
  return Boolean(
    analysis.wantsBrowse
    || analysis.wantsLaunches
    || analysis.wantsMoreProducts
    || analysis.wantsProductSelection
    || analysis.wantsCheckout
    || analysis.wantsPhotosExplicit
    || analysis.wantsSize
    || analysis.wantsQuantity
    || analysis.categories?.length > 0
  );
}

async function cancelCurrentFlow(phone, session, userText = null) {
  if (session.purchaseFlow) {
    session.purchaseFlow.buyQueue = [];
  }
  resetPurchaseFlow(session);
  clearSupportMode(session, 'cancel_current_flow');

  if (userText) {
    appendHistory(session, 'user', userText);
    conversationMemory.refreshConversationMemory(session, { userText });
  }

  await zapi.sendText(phone, 'Sem problemas! 😊 O que você gostaria de fazer agora?');
  await sendCategoryMenu(phone, 'Quer ver alguma linha específica?');
}

async function getSession(phone) {
  if (sessions[phone]) {
    sessions[phone].previousLastActivity = sessions[phone].lastActivity || null;
    sessions[phone].lastActivity = Date.now();
    return sessions[phone];
  }

  // Se já há um load em andamento para este phone, aguarda para evitar race condition
  if (sessionLoadLocks.has(phone)) {
    await sessionLoadLocks.get(phone);
    return sessions[phone];
  }

  const loadPromise = (async () => {
    const stored = await db.getSession(phone);
    const defaultPurchaseFlow = createDefaultPurchaseFlow();
    const storedPurchaseFlow = stored?.purchase_flow ? { ...stored.purchase_flow } : null;
    // Compatibilidade: lê contextMemory de purchase_flow se conversation_memory ainda não existe
    const storedConversationMemory =
      stored?.conversation_memory || storedPurchaseFlow?.contextMemory || null;
    if (storedPurchaseFlow?.contextMemory) delete storedPurchaseFlow.contextMemory;

    sessions[phone] = stored
      ? {
          history:         stored.history         || [],
          items:           stored.items            || [],
          products:        stored.products         || [],
          currentProduct:  stored.current_product  || null,
          customerName:    stored.customer_name    || null,
          currentCategory: normalizeCategorySlug(stored.current_category) || null,
          activeCategory:  normalizeCategorySlug(stored.active_category || stored.current_category) || null,
          currentPage:     stored.current_page     || 0,
          totalPages:      stored.total_pages      || 1,
          totalProducts:   stored.total_products   || 0,
          lastViewedProduct: stored.last_viewed_product || null,
          lastViewedProductIndex: stored.last_viewed_product_index || null,
          handoffDone: storedPurchaseFlow?.handoffDone || false,
          purchaseFlow: storedPurchaseFlow
            ? { ...defaultPurchaseFlow, ...storedPurchaseFlow, addedSizes: storedPurchaseFlow.addedSizes || [], buyQueue: storedPurchaseFlow.buyQueue || [] }
            : defaultPurchaseFlow,
          conversationMemory: storedConversationMemory || conversationMemory.createDefaultConversationMemory(),
          messageProductMap: stored.message_product_map || {},
          supportMode:     stored.support_mode || null,
          cartNotified:    stored.cart_notified || false,
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
          handoffDone: false,
          purchaseFlow: defaultPurchaseFlow,
          conversationMemory: conversationMemory.createDefaultConversationMemory(),
          messageProductMap: {},
          supportMode: null,
          cartNotified: false,
          previousLastActivity: null,
          lastActivity: Date.now(),
        };
  })();

  sessionLoadLocks.set(phone, loadPromise);
  try {
    await loadPromise;
  } finally {
    sessionLoadLocks.delete(phone);
  }

  return sessions[phone];
}

function persistSession(phone) {
  const session = sessions[phone];
  if (!session) return Promise.resolve();

  const previous = persistQueues.get(phone) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => db.upsertSession(phone, session))
    .catch(err => logger.error({ err: err.message }, '[Supabase] upsertSession'));

  persistQueues.set(phone, next);
  next.finally(() => {
    if (persistQueues.get(phone) === next) persistQueues.delete(phone);
  });
  return next;
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
        await sendCartOptions(
          phone,
          session,
          'Oii! Vi que você deixou alguns itens no carrinho 🛒 Quer revisar, finalizar ou continuar vendo novidades?'
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
      if (listId === 'cat_feminina') return 'CAT_FEMININO';
      if (listId === 'cat_feminino_infantil') return 'CAT_FEMININOINFANTIL';
      if (listId === 'cat_masculina') return 'CAT_MASCULINO';
      if (listId === 'cat_masculino_infantil') return 'CAT_MASCULINOINFANTIL';
      if (listId === 'cat_lancamentos') return 'CAT_LANCAMENTOS';
      if (listId === 'btn_ver_todos') return 'VER_TODOS_CATEGORIA';
      if (listId === 'cart_view') return 'CART_VIEW';
      if (listId === 'cart_finalize') return 'CART_FINALIZE';
      if (listId === 'cart_other_category') return 'VER_OUTRA_CATEGORIA';
      // Sentinela determinístico — evita colisão com detector de fotos ("ver mais").
      // Interceptado no webhook e roteado direto para navegação/catálogo.
      if (listId === 'cart_more_products') return 'VER_MAIS_PRODUTOS';
      if (listId === 'falar_atendente') return 'FALAR_ATENDENTE';
      return listId;
    }

    // Intercepta botões da Z-API e trata como texto transparente para a IA
    if (event.type === 'button_reply' && event.buttonReply?.id) {
       if (event.buttonReply.id === 'btn_outra_cat') return 'OUTRA CATEGORIA';
       if (event.buttonReply.id === 'cart_view') return 'CART_VIEW';
       if (event.buttonReply.id === 'cart_finalize') return 'CART_FINALIZE';
       if (event.buttonReply.id === 'cart_other_category') return 'VER_OUTRA_CATEGORIA';
       if (event.buttonReply.id === 'cart_more_products') return 'VER_MAIS_PRODUTOS';
       if (event.buttonReply.id === 'falar_atendente') return 'FALAR_ATENDENTE';
       return event.buttonReply.id;
    }

    // Suporte para múltiplos formatos de payload da Z-API
    if (typeof event.text === 'string') return event.text;
    if (event.text && typeof event.text.message === 'string') return event.text.message;
    if (event.content && typeof event.content === 'string') return event.content;
    if (event.audio || event?.message?.audio) return '[Áudio_STT]';
    if (event.image?.caption) return event.image.caption.trim();
    if (event.sticker) return '[Sticker]';

    // Fallback para objetos complexos
    return event.text?.message || event.content || '';
  } catch (err) {
    return '';
  }
}

function extractAudioUrl(event) {
  return event?.audio?.audioUrl
    || event?.audio?.url
    || event?.audioUrl
    || event?.message?.audioUrl
    || event?.message?.audio?.audioUrl
    || event?.message?.audio?.url
    || null;
}

// ── Webhook ───────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  let from = '';
  try {
    const body = req.body;
    logger.info({ body }, '[Webhook] Evento recebido');
    from = body?.phone || '';
    if (!from) return;
    if (body?.fromMe || body?.isGroup || body?.isStatusReply || body?.broadcast) return;
    if (body?.type === 'DeliveryCallback' || body?.type === 'ReadCallback') return;

    const messageId = body?.messageId;

    // ── FSM Interceptor ───────────────────────────────────────────────────
    const fsmButtonId = body?.buttonsResponseMessage?.buttonId;
    const fsmListId   = body?.listResponseMessage?.selectedRowId;
    const fsmEventId  = fsmButtonId || fsmListId;

    if (fsmEventId && /^(buy_|size_|qty_|add_size_|skip_more_|queue_continue|queue_finalize_anyway)/.test(fsmEventId)) {
      if (messageId) zapi.readMessage(from, messageId);
      logger.info({ from, fsmEventId }, '[FSM] Evento interativo capturado');
      const session = await getSession(from);
      await handlePurchaseFlowEvent(from, fsmEventId, session);
      persistSession(from);
      return;
    }
    // ─────────────────────────────────────────────────────────────────────

    if (!body.text && !body.listResponseMessage && !body.buttonsResponseMessage) {
      logger.info({
        bodyKeys: Object.keys(body),
        hasAudio: Boolean(body.audio),
        hasMessageAudio: Boolean(body?.message?.audio),
      }, '[Webhook] Payload sem texto — inspecionando tipo');
    }

    let text = extractTextFromEvent(body);
    if (!text) return;

    // Fallbacks de áudio/sticker que NÃO precisam de sessão (respondem direto)
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

    // Carrega sessão ANTES do bloco de STT — o log de FSM ativa durante
    // transcrição precisa acessar session.purchaseFlow (ADR-026).
    const session = await getSession(from);

    if (/^\[.*udio_STT\]$/i.test(text)) {
      const audioUrl = extractAudioUrl(body);
      logger.info({ from, hasAudioUrl: Boolean(audioUrl) }, '[Intercept] Áudio recebido — iniciando STT');
      if (!audioUrl) {
        logger.warn({ from, bodyKeys: Object.keys(body) }, '[STT] audioUrl não encontrado em nenhum campo esperado');
        await zapi.replyText(from, 'Puts amada, não recebi o áudio direitinho 😅. Consegue mandar de novo ou em texto?', messageId);
        return;
      }
      const transcription = await stt.transcribe(audioUrl);
      if (!transcription) {
        await zapi.replyText(from, 'Puts amada, não consegui entender o áudio direitinho 😅. Consegue me mandar em texto rapidinho?', messageId);
        return;
      }
      text = transcription.trim();
      logger.info({ from, transcriptionPreview: text.slice(0, 80) }, '[Intercept] Áudio transcrito com sucesso');
      if (session.purchaseFlow?.state !== 'idle') {
        logger.info({
          from,
          transcription: text.slice(0, 80),
          fsmState: session.purchaseFlow.state,
        }, '[STT] Áudio transcrito durante FSM ativa');
      }
    }

    const inactivityMs = session.previousLastActivity
      ? Date.now() - session.previousLastActivity
      : 0;

    // Rotas determinísticas de carrinho
    if (text === 'CART_VIEW') {
      logger.info({ from }, '[Intercept] Visualização de carrinho');
      await showCart(from, session);
      persistSession(from);
      return;
    }

    if (text === 'CART_FINALIZE') {
      logger.info({ from }, '[Intercept] Finalização de carrinho determinística');
      const intercepted = await handleQueueGuard(from, 'cart_finalize', session);
      if (!intercepted) {
        await handoffToConsultant(from, session);
      }
      persistSession(from);
      return;
    }

    if (text === 'FALAR_ATENDENTE') {
      logger.info({ from }, '[Intercept] Encaminhamento humano determinístico');
      await handoffToHuman(from, session);
      persistSession(from);
      return;
    }

    // Sprint 1 — Interceptor global: limpeza de carrinho com linguagem natural
    const semanticQuick = semantic.analyzeUserMessage(text);
    if (semanticQuick.wantsClearCart) {
      logger.info({ from, text: text.slice(0, 80) }, '[Intercept] Limpeza de carrinho via semântica');
      await clearCart(from, session);
      persistSession(from);
      return;
    }

    // Sprint 1 — Interceptor global: handoff humano com linguagem natural
    if (semanticQuick.wantsHuman) {
      logger.info({ from, text: text.slice(0, 80) }, '[Intercept] Handoff humano via semântica');
      await handoffToHuman(from, session);
      persistSession(from);
      return;
    }

    // Sprint 1 — Interceptor global: cancelar fluxo com linguagem natural
    if (semanticQuick.wantsCancelFlow && session.purchaseFlow?.state !== 'idle') {
      logger.info({ from, text: text.slice(0, 80), state: session.purchaseFlow.state }, '[Intercept] Cancelamento de fluxo via semântica');
      await cancelCurrentFlow(from, session, text);
      persistSession(from);
      return;
    }

    // Sprint 1 — Limpa supportMode quando o cliente retoma a conversa com intenção de compra
    if (session.supportMode === 'human_pending') {
      if (isShoppingResumeIntent(semanticQuick)) {
        logger.info({ from }, '[SupportMode] Cliente retomou interesse de compra — saindo de human_pending');
        clearSupportMode(session, 'shopping_resumed');
      }
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

    if (text === 'VER_OUTRA_CATEGORIA' || text === 'OUTRA CATEGORIA') {
      logger.info({ phone: from, currentCategory: session.activeCategory, cartItems: session.items?.length || 0 }, '[Intercept] VER_OUTRA_CATEGORIA — seletor de coleções');
      await sendCategoryMenu(from, session.items?.length > 0
        ? 'Claro 😊 Seu carrinho continua salvo. Qual outra linha você quer ver agora?'
        : 'Claro 😊 Qual linha você quer ver agora?');
      persistSession(from);
      return;
    }

    // ── Seleção determinística de categoria (menu de listas) ──────────────────
    // Seleções de menu NÃO passam pela IA — roteamento direto por sentinela.
    // Evita que a IA re-interprete a categoria e gere o slug errado.
    if (CAT_SENTINELS[text]) {
      const slug = CAT_SENTINELS[text];
      logger.info({ phone: from, sentinel: text, slug }, '[Intercept] Seleção de categoria determinística');
      appendHistory(session, 'user', `quero ver a linha ${getCategoryDisplayName(slug)}`);
      conversationMemory.refreshConversationMemory(session, { userText: text });
      await showCategory(from, slug, session);
      persistSession(from);
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

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

    // ── Escape hatch: intenção de navegação durante FSM ativa ────────────────
    // Se o cliente claramente quer navegar para outros produtos/categorias
    // durante awaiting_size ou awaiting_quantity, reseta o estado para idle
    // para que buildFsmContext retorne null e a IA possa responder livremente.
    {
      const NAV_ESCAPE = /\b(outras?\s+op[çc][õo]es?|outras?\s+categor|ver\s+outra[s]?\s+|n[aã]o\s+quero\s+mais|desistir|cancelar|voltar)\b/i;
      const pf = session.purchaseFlow;
      if (pf?.state !== 'idle' && NAV_ESCAPE.test(text)) {
        logger.info({ from, state: pf.state, text: text.slice(0, 60) }, '[FSM] Navigation escape — resetting to idle');
        pf.state = 'idle';
      }
    }

    // ── Grade Semântica: parser determinístico de tamanho+quantidade ──────────
    // Só dispara quando a FSM está ativa e o produto está em foco.
    // Processa toda a grade em batch (pushCartItem) e envia confirmação única.
    const pfGrade = session.purchaseFlow;
    if (pfGrade.state !== 'idle' && pfGrade.productId) {
      // R1: Quote resolve o alvo ANTES da FSM.
      // Usa resolveQuotedProduct (map → caption:ref → caption:name) pra encontrar
      // o produto citado; se diferente do foco, troca via switchFsmFocus.
      const hasQuote = Boolean(
        body?.referenceMessageId
        || body?.quotedMessage?.messageId
        || body?.quotedMessage?.stanzaId
        || body?.quotedMessage?.id
      );
      if (hasQuote) {
        const resolved = await resolveQuotedProduct(session, body);
        if (resolved?.product && String(resolved.product.id) !== String(pfGrade.productId)) {
          logger.info(
            {
              prev: pfGrade.productId,
              next: resolved.product.id,
              prevName: pfGrade.productName,
              nextName: resolved.product.name,
              strategy: resolved.strategy,
            },
            '[Grade] switchFsmFocus via quote reply'
          );
          switchFsmFocus(session, resolved.product);
        }
      }

      const focusedProduct = await ensureProductStockData(
        session.products?.find(p => String(p.id) === String(pfGrade.productId))
        || await resolveProductById(session, pfGrade.productId)
      );

      // Suporte a tamanho único: produto sem variações usa ['ÚNICO'] como sizes
      const effectiveSizes = focusedProduct
        ? (() => {
            const rawSizes = (focusedProduct.sizes || []).filter(Boolean);
            if (rawSizes.length === 0) return ['ÚNICO'];
            return buildSessionSizeDetails(session, focusedProduct).map(d => d.size);
          })()
        : [];

      if (effectiveSizes.length > 0) {
        const allSizes = effectiveSizes;
        const availableSizes = getAvailableSizesForSession(session, focusedProduct);
        const grade = parseGradeText(text, allSizes);

        if (grade) {
          logger.info({ from, grade, product: pfGrade.productName }, '[Grade] Grade semântica detectada');
          appendHistory(session, 'user', text);
          conversationMemory.refreshConversationMemory(session, { userText: text });

          const unitPrice = parseFloat(focusedProduct.salePrice || focusedProduct.price);
          const addable = [];
          const unavailable = [];
          const unknown = [];

          for (const { size, qty } of grade) {
            const upperSize = size.toUpperCase();
            const matchedSize = allSizes.find(s => s.toUpperCase() === upperSize);

            if (!matchedSize) {
              unknown.push({ size, qty });
              continue;
            }

            const availability = getSizeAvailability(session, focusedProduct, matchedSize);

            if (availability?.isAvailable === false) {
              unavailable.push({ size: matchedSize, qty, available: availability.availableQuantity || 0 });
              continue;
            }

            if (availability && typeof availability.availableQuantity === 'number' && qty > availability.availableQuantity) {
              unavailable.push({ size: matchedSize, qty, available: availability.availableQuantity });
              continue;
            }

            addable.push({ size: matchedSize, qty });
          }

          logger.info({
            from,
            product: pfGrade.productName,
            allSizes,
            gradeRequested: grade,
            addable,
            unavailable,
            unknown,
          }, '[Grade] Resultado do parsing com validação de estoque');

          const addedItems = [];
          for (const { size, qty } of addable) {
            pushCartItem(session, focusedProduct.id, focusedProduct.name, size, qty, unitPrice, focusedProduct.imageUrl || null);
            addedItems.push({ size, qty });
          }

          const parts = [];

          if (addedItems.length > 0) {
            const gradeLines = addedItems.map(({ size, qty }) =>
              `• ${focusedProduct.name} (${size}) x${qty}`
            ).join('\n');
            const cartTotal = session.items.reduce((acc, it) => acc + parseFloat(it.price || 0), 0);
            const { lineItems, totalPieces } = getCartStats(session);
            parts.push(`✅ Grade separada!\n${gradeLines}\n\n🛒 Carrinho: ${totalPieces} ${totalPieces === 1 ? 'peça' : 'peças'} em ${lineItems} ${lineItems === 1 ? 'item' : 'itens'} — *${woocommerce.formatPrice(cartTotal)}*`);
          }

          if (unavailable.length > 0) {
            const unavailLines = unavailable.map(({ size, qty, available }) =>
              available > 0
                ? `• ${size}: pediu ${qty}, só tem ${available} disponível`
                : `• ${size}: indisponível no momento`
            ).join('\n');
            parts.push(`⚠️ Não consegui incluir:\n${unavailLines}`);
          }

          if (unknown.length > 0) {
            const unknownList = unknown.map(u => u.size).join(', ');
            const validList = allSizes.join(', ');
            parts.push(`❓ Tamanho(s) *${unknownList}* não existe(m) neste produto. Disponíveis: *${validList}*`);
          }

          if (addedItems.length === 0) {
            parts.push(`Me manda as quantidades ajustadas ou escolhe pela lista abaixo 😊`);
          }

          const confirmMsg = parts.join('\n\n');

          appendHistory(session, 'assistant', confirmMsg);
          conversationMemory.refreshConversationMemory(session, { assistantText: confirmMsg, action: { type: 'CARRINHO' } });

          if (addedItems.length > 0) {
            pfGrade.state = 'awaiting_more_sizes';
            pfGrade.selectedSize = null;
            if (!Array.isArray(pfGrade.addedSizes)) pfGrade.addedSizes = [];
            // Marca grade como "commit explícito via texto" — se cliente citar
            // outro produto depois, switchFsmFocus NÃO enfileira este.
            pfGrade.lastCommitSource = 'text';
            session.currentProduct = focusedProduct;
            const remainingSizes = getAvailableSizesForSession(session, focusedProduct, pfGrade.addedSizes || []);
            await sendPostAddMenu(from, session, remainingSizes, confirmMsg);
          } else {
            pfGrade.state = 'awaiting_size';
            pfGrade.interactiveVersion = Date.now();
            session.currentProduct = focusedProduct;
            await zapi.sendText(from, confirmMsg);
            await sendStockAwareSizeList(from, session, focusedProduct, pfGrade.interactiveVersion, pfGrade.addedSizes || []);
          }
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
    const fsmEscaping = Boolean(
      semanticQuick.wantsClearCart
      || semanticQuick.wantsHuman
      || semanticQuick.wantsCancelFlow
      || semanticQuick.wantsCart
      || semanticQuick.wantsCheckout
      || semanticQuick.wantsBrowse
      || semanticQuick.wantsLaunches
      || semanticQuick.wantsMoreProducts
      || semanticQuick.wantsProductSearch
      || semanticQuick.categories.length > 0
    );

    if (!fsmEscaping && pfCheck.state === 'awaiting_size') {
      const product = await ensureProductStockData(session.products?.find(p => p.id === pfCheck.productId));
      if (product) {
        const textUpper = text.trim().toUpperCase();
        const availableSizes = getAvailableSizesForSession(session, product);

        // Direct match: text IS a size name → process immediately without AI roundtrip
        const directSizeIdx = availableSizes.findIndex(s => s.toUpperCase().trim() === textUpper);
        if (directSizeIdx >= 0) {
          logger.info({ from, size: availableSizes[directSizeIdx] }, '[FSM] Tamanho digitado — processando direto');
          const pf = session.purchaseFlow;
          pf.selectedSize = availableSizes[directSizeIdx];
          pf.state = 'awaiting_quantity';
          pf.interactiveVersion = Date.now();
          appendHistory(session, 'user', text);
          conversationMemory.refreshConversationMemory(session, { userText: text });
          await sendStockAwareQuantityList(from, session, pf.selectedSize, pf.interactiveVersion, product);
          persistSession(from);
          return;
        }

        // Direct match: text is a valid size index number
        const numericIdx = parseInt(textUpper, 10);
        if (!isNaN(numericIdx) && numericIdx >= 1 && numericIdx <= availableSizes.length) {
          logger.info({ from, sizeIdx: numericIdx, size: availableSizes[numericIdx - 1] }, '[FSM] Índice de tamanho digitado — processando direto');
          const pf = session.purchaseFlow;
          pf.selectedSize = availableSizes[numericIdx - 1];
          pf.state = 'awaiting_quantity';
          pf.interactiveVersion = Date.now();
          appendHistory(session, 'user', text);
          conversationMemory.refreshConversationMemory(session, { userText: text });
          await sendStockAwareQuantityList(from, session, pf.selectedSize, pf.interactiveVersion, product);
          persistSession(from);
          return;
        }

        // Text mentions a known size in natural language → let through to AI
        const words = textUpper.split(/\s+/);
        const mentionsSize = availableSizes.some(s => words.includes(s.toUpperCase().trim()));
        const isPhotoRequestInSize = semantic.isLikelyPhotoRequest(text, { hasProductContext: true });
        if (mentionsSize) {
          logger.info({ from, text, state: pfCheck.state }, '[FSM] Texto menciona tamanho — passando para IA');
          // Falls through to AI processing below
        } else if (isPhotoRequestInSize) {
          logger.info({ from, text }, '[FSM] Pedido de foto em awaiting_size — passando para foto handler');
          // Falls through to photo request handler below
        } else {
          const wordCount = text.trim().split(/\s+/).length;
          if (wordCount <= 2) {
            logger.info({ from, text, state: pfCheck.state }, '[FSM] Texto curto ambíguo em awaiting_size — re-enviando menu');
            await zapi.sendText(from, `😊 Escolhe o tamanho de *${pfCheck.productName}* pelo botão abaixo!`);
            await sendStockAwareSizeList(from, session, product, pfCheck.interactiveVersion);
            persistSession(from);
            return;
          }
          // Mensagem com 3+ palavras → provavelmente tem intenção real → passa para IA
          logger.info({ from, text, wordCount, state: pfCheck.state }, '[FSM] Texto com intenção em awaiting_size — passando para IA');
          // Falls through to AI processing below
        }
      }
    }

    if (!fsmEscaping && pfCheck.state === 'awaiting_more_sizes') {
      const product = await ensureProductStockData(session.products?.find(p => p.id === pfCheck.productId));
      const remainingSizes = getAvailableSizesForSession(session, product, pfCheck.addedSizes || []);

      // Check if text mentions a remaining size → let through to AI
      const textUpper = text.trim().toUpperCase();
      const words = textUpper.split(/\s+/);
      const mentionsRemainingSize = remainingSizes.some(s => words.includes(s.toUpperCase().trim()));
      const isPhotoRequestEarly = semantic.isLikelyPhotoRequest(text, { hasProductContext: true });
      if (mentionsRemainingSize) {
        logger.info({ from, text, state: pfCheck.state }, '[FSM] Texto menciona tamanho restante — passando para IA');
        // Falls through to AI processing below
      } else if (isPhotoRequestEarly) {
        logger.info({ from, text }, '[FSM] Pedido de foto em awaiting_more_sizes — passando para foto handler');
        // Falls through to photo request handler below
      } else {
        const wordCount = text.trim().split(/\s+/).length;
        if (wordCount <= 2) {
          logger.info({ from, text, state: pfCheck.state }, '[FSM] Texto curto ambíguo em awaiting_more_sizes — re-enviando menu');
          await sendPostAddMenu(from, session, remainingSizes);
          persistSession(from);
          return;
        }
        // Mensagem com 3+ palavras → provavelmente tem intenção real → passa para IA
        logger.info({ from, text, wordCount, state: pfCheck.state }, '[FSM] Texto com intenção em awaiting_more_sizes — passando para IA');
        // Falls through to AI processing below
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
    const hasActiveCart = session.items?.length > 0;
    if (fsmIsIdle && !hasActiveCart && (session.history.length === 0 || (PURE_GREETING.test(text.trim()) && staleConversation))) {
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
    let quotedProduct = null;
    let finalUserText = text;

    // ── Tentativa 0: referenceMessageId na raiz do body (Z-API button-list replies) ──
    // Z-API envia o ID da mensagem citada em body.referenceMessageId para mensagens interativas.
    // Este campo referencia o messageId retornado no POST de envio (não o zaapId).
    if (!quotedProductIdx && body?.referenceMessageId && session.messageProductMap) {
      const mapped = session.messageProductMap[body.referenceMessageId];
      if (mapped) {
        quotedProduct = await resolveProductById(session, mapped.productId);
        if (quotedProduct) {
          const loadedIdx = session.products?.findIndex(p => String(p.id) === String(mapped.productId)) ?? -1;
          quotedProductIdx = loadedIdx >= 0 ? loadedIdx + 1 : mapped.productIdx || null;
          const price = quotedProduct.salePrice
            ? `R$ ${parseFloat(quotedProduct.salePrice).toFixed(2).replace('.', ',')}`
            : `R$ ${parseFloat(quotedProduct.price).toFixed(2).replace('.', ',')}`;
          finalUserText = `[O cliente citou a vitrine do produto "${quotedProduct.name}" (${price})]\n\nMensagem do cliente: "${text}"`;
          logger.info(
            { refMsgId: body.referenceMessageId, productId: mapped.productId, productIdx: quotedProductIdx },
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
      if (!extractedIdx && session.messageProductMap) {
        const mapMsgId = body.referenceMessageId          // ← NOVO: raiz do body
          || body.quotedMessage.messageId
          || body.quotedMessage.stanzaId
          || body.quotedMessage.id;
        if (mapMsgId && session.messageProductMap[mapMsgId]) {
          const mapped = session.messageProductMap[mapMsgId];
          quotedProduct = quotedProduct || await resolveProductById(session, mapped.productId);
          if (quotedProduct) {
            const loadedIdx = session.products?.findIndex(p => String(p.id) === String(mapped.productId)) ?? -1;
            extractedIdx = loadedIdx >= 0 ? loadedIdx + 1 : mapped.productIdx || null;
            logger.info({ msgId: mapMsgId, productId: mapped.productId, productIdx: extractedIdx }, '[QuotedProduct] Resolvido via messageProductMap ✓');
          }
        }
      }

      // Tentativa 3.5 (caption:ref): extrai "Ref XXX" da caption do quote.
      // Cobre o caso em que o card é muito antigo (fora do messageProductMap)
      // mas ainda está carregado em session.products.
      if (!extractedIdx && session.products?.length > 0 && quotedText) {
        const refMatch = quotedText.match(/ref\s*([0-9]+[a-z]?)/i);
        if (refMatch) {
          const refCode = refMatch[1];
          const refRegex = new RegExp(`ref\\s*${refCode}\\b`, 'i');
          const byRef = session.products.findIndex(p => refRegex.test(p.name || ''));
          if (byRef >= 0) {
            extractedIdx = byRef + 1;
            quotedProduct = session.products[byRef];
            logger.info({ refCode, productName: quotedProduct.name, productIdx: extractedIdx }, '[QuotedProduct] Resolvido via caption:ref ✓');
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
        quotedProduct = quotedProduct || session.products?.[quotedProductIdx - 1] || null;
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
          const product = await resolveProductById(session, pf.lastClickedProductId);
          if (product) {
            const loadedIdx = session.products?.findIndex(p => String(p.id) === String(product.id)) ?? -1;
            quotedProductIdx = loadedIdx >= 0 ? loadedIdx + 1 : null;
            quotedProduct = product;
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
    const quotedProductRef = await ensureProductStockData(
      quotedProduct || (quotedProductIdx ? session.products?.[quotedProductIdx - 1] : null)
    );

    if (quotedProductRef && session.purchaseFlow?.state === 'idle') {
      // Suporte a tamanho único: produtos sem sizes[] também entram no grade parser
      const rawSizesQuote = (quotedProductRef?.sizes || []).filter(Boolean);
      const allSizesQuote = rawSizesQuote.length > 0
        ? buildSessionSizeDetails(session, quotedProductRef).map(d => d.size)
        : ['ÚNICO'];
      if (allSizesQuote.length > 0) {
        const gradeFromQuote = parseGradeText(text, allSizesQuote);
        if (gradeFromQuote) {
          logger.info({ from, grade: gradeFromQuote, product: quotedProductRef.name }, '[Grade] Grade via produto citado (FSM idle)');
          const pf = session.purchaseFlow;
          const unitPrice = parseFloat(quotedProductRef.salePrice || quotedProductRef.price);
          pf.productId = quotedProductRef.id;
          pf.productName = quotedProductRef.name;
          pf.unitPrice = unitPrice;

          const addableQuote = [];
          const unavailableQuote = [];
          const unknownQuote = [];

          for (const { size, qty } of gradeFromQuote) {
            const upperSize = size.toUpperCase();
            const matchedSize = allSizesQuote.find(s => s.toUpperCase() === upperSize);

            if (!matchedSize) {
              unknownQuote.push({ size, qty });
              continue;
            }

            const availability = getSizeAvailability(session, quotedProductRef, matchedSize);

            if (availability?.isAvailable === false) {
              unavailableQuote.push({ size: matchedSize, qty, available: availability.availableQuantity || 0 });
              continue;
            }

            if (availability && typeof availability.availableQuantity === 'number' && qty > availability.availableQuantity) {
              unavailableQuote.push({ size: matchedSize, qty, available: availability.availableQuantity });
              continue;
            }

            addableQuote.push({ size: matchedSize, qty });
          }

          logger.info({
            from,
            product: quotedProductRef.name,
            allSizes: allSizesQuote,
            gradeRequested: gradeFromQuote,
            addable: addableQuote,
            unavailable: unavailableQuote,
            unknown: unknownQuote,
          }, '[Grade] Resultado do parsing (produto citado) com validação de estoque');

          const addedItems = [];
          for (const { size, qty } of addableQuote) {
            pushCartItem(session, quotedProductRef.id, quotedProductRef.name, size, qty, unitPrice, quotedProductRef.imageUrl || null);
            addedItems.push({ size, qty });
          }

          const parts = [];

          if (addedItems.length > 0) {
            const gradeLines = addedItems.map(({ size, qty }) => `• ${quotedProductRef.name} (${size}) x${qty}`).join('\n');
            const cartTotal = session.items.reduce((acc, it) => acc + parseFloat(it.price || 0), 0);
            const { lineItems, totalPieces } = getCartStats(session);
            parts.push(`✅ Grade separada!\n${gradeLines}\n\n🛒 Carrinho: ${totalPieces} ${totalPieces === 1 ? 'peça' : 'peças'} em ${lineItems} ${lineItems === 1 ? 'item' : 'itens'} — *${woocommerce.formatPrice(cartTotal)}*`);
          }

          if (unavailableQuote.length > 0) {
            const unavailLines = unavailableQuote.map(({ size, qty, available }) =>
              available > 0
                ? `• ${size}: pediu ${qty}, só tem ${available} disponível`
                : `• ${size}: indisponível no momento`
            ).join('\n');
            parts.push(`⚠️ Não consegui incluir:\n${unavailLines}`);
          }

          if (unknownQuote.length > 0) {
            const unknownList = unknownQuote.map(u => u.size).join(', ');
            const validList = allSizesQuote.join(', ');
            parts.push(`❓ Tamanho(s) *${unknownList}* não existe(m) neste produto. Disponíveis: *${validList}*`);
          }

          if (addedItems.length === 0) {
            parts.push(`Me manda as quantidades ajustadas ou escolhe pela lista abaixo 😊`);
          }

          const confirmMsg = parts.join('\n\n');

          appendHistory(session, 'assistant', confirmMsg);
          conversationMemory.refreshConversationMemory(session, { assistantText: confirmMsg, action: { type: 'CARRINHO' } });

          if (addedItems.length > 0) {
            pf.state = 'awaiting_more_sizes';
            pf.selectedSize = null;
            if (!Array.isArray(pf.addedSizes)) pf.addedSizes = [];
            session.currentProduct = quotedProductRef;
            const remainingSizes = getAvailableSizesForSession(session, quotedProductRef, pf.addedSizes || []);
            await sendPostAddMenu(from, session, remainingSizes, confirmMsg);
          } else {
            pf.state = 'awaiting_size';
            pf.interactiveVersion = Date.now();
            session.currentProduct = quotedProductRef;
            await zapi.sendText(from, confirmMsg);
            await sendStockAwareSizeList(from, session, quotedProductRef, pf.interactiveVersion, pf.addedSizes || []);
          }
          persistSession(from);
          return;
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────────

    // Intent visual: EXIGE menção explícita a foto/imagem/vídeo.
    // Termos genéricos ("ver mais", "mostra mais", "tem mais") foram retirados —
    // colidiam com navegação de catálogo ("Ver Mais Produtos").
    const IS_PHOTO_REQUEST = /\b(fotos?|imagens?|v[ií]deos?)\b/i.test(text);

    const semanticHint = semantic.buildSemanticContext(text, session);
    const photoContextActive = Boolean(quotedProductIdx || session.lastViewedProduct || session.currentProduct);
    const EFFECTIVE_PHOTO_REQUEST = IS_PHOTO_REQUEST || semantic.isLikelyPhotoRequest(text, { hasProductContext: photoContextActive });

    if (EFFECTIVE_PHOTO_REQUEST && !quotedProductIdx && session.products?.length > 0) {
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
    const photoProductRef = quotedProduct || (quotedProductIdx ? session.products?.[quotedProductIdx - 1] : null);
    if (photoProductRef && (EFFECTIVE_PHOTO_REQUEST || isShortMessage)) {
      logger.info({ productId: photoProductRef.id, productIdx: quotedProductIdx }, '[Intercept] Pedido de fotos — resolvido em código');
      await showProductPhotos(from, quotedProductIdx || photoProductRef.id, session);
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
    // Se o cliente menciona categoria/linha/coleção/todos/tudo, NÃO é pedido de fotos
    // de um produto específico — é intenção de ver a categoria inteira. Libera a mensagem
    // para o roteador determinístico "ver todos" ou para a IA resolver.
    const CATEGORY_INTENT = /\b(categoria|linha|cole[çc][ãa]o|todos|todas|tudo|modelos)\b/i.test(text);
    if (!CATEGORY_INTENT && (EFFECTIVE_PHOTO_REQUEST || (quotedHasImage && isShortMessage)) && !quotedProductIdx && canUseLastViewedFallback && session.lastViewedProduct) {
      const idx = session.lastViewedProductIndex || 1;
      logger.info({ productIdx: idx, name: session.lastViewedProduct.name }, '[LastViewed] Usando último produto visto');
      await showProductPhotos(from, idx, session);
      persistSession(from);
      return;
    }

    if (EFFECTIVE_PHOTO_REQUEST && session.products?.length > 0) {
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

    // Roteamento determinístico: "ver todos/todas/tudo" + categoria ativa → showAllCategory.
    // Evita dependência do Gemini nesse caminho crítico — se a API falhar ou a IA
    // interpretar errado, o cliente já fica em silêncio ou recebe produto errado.
    const WANTS_ALL = /\b(ver\s+todos|ver\s+todas|todas?\s+as\s+fotos|mostra(?:r)?\s+tudo|quero\s+ver\s+tudo|quero\s+ver\s+todos|quero\s+ver\s+todas)\b/i.test(text);
    if (WANTS_ALL && session.activeCategory) {
      logger.info({ phone: from, category: session.activeCategory }, '[Intercept] "Ver todos" determinístico — bypass IA');
      appendHistory(session, 'user', text);
      conversationMemory.refreshConversationMemory(session, { userText: text });
      await showAllCategory(from, session.activeCategory, session);
      persistSession(from);
      return;
    }

    let systemNudge = null;
    if (isFirstContact) {
      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'bom dia' : hour < 18 ? 'boa tarde' : 'boa noite';
      systemNudge = `[BOAS-VINDAS: Primeiro contato do dia (${greeting}). 1 linha curta e carinhosa no ritmo de zap. Os lançamentos vão aparecer logo em seguida pelo token [VER_TODOS:lancamento-da-semana] — não precisa perguntar nada.]`;
    }

    // Janela deslizante de 20min: mensagens antigas são movidas para
    // archivedSummary ANTES de montar o prompt — assim buildAiContext já
    // reflete o estado pós-compressão.
    const activeHistory = getActiveHistoryWindow(session);
    const promptContext = buildAiContext(session, [semanticHint]);
    let aiRaw = '';
    try {
      aiRaw = await ai.chat(activeHistory, promptContext, systemNudge);
    } catch (err) {
      logger.error(
        { err: err?.message || String(err), stack: err?.stack || null, isFirstContact, text },
        '[AI] Falha na chamada do Gemini'
      );

      if (isFirstContact) {
        const fallbackGreeting = 'Oii, amor 😊 Separa um instantinho que já vou te mostrar nossos lançamentos.';
        appendHistory(session, 'assistant', fallbackGreeting);
        conversationMemory.refreshConversationMemory(session, { assistantText: fallbackGreeting });
        await zapi.sendText(from, fallbackGreeting);
        await showAllCategory(from, 'lancamento-da-semana', session);
        persistSession(from);
        return;
      }

      await zapi.sendText(from, 'Poxa, tive um pequeno problema aqui, mas já tô voltando! Pode repetir sua última mensagem? 😊');
      return;
    }
    logger.info({ phone: from, response: aiRaw }, '[AI] Response');

    let { cleanText, action } = ai.parseAction(aiRaw);
    const semanticFallbackAction = semantic.inferActionFromSemantics(text, session);
    if (!action && semanticFallbackAction) {
      action = semanticFallbackAction;
      logger.info({ actionType: action.type, payload: action.payload || null }, '[SemanticFallback] Acao inferida por sentido');
    }

    // Mão de Ferro v3 — Se é primeiro contato ou o usuário pediu lançamentos/novidades, 
    // nós FORÇAMOS o catálogo e limpamos qualquer outra ação conflitante.
    const semanticAnalysis = semantic.analyzeUserMessage(text);
    if (action?.type === 'HANDOFF' && semanticAnalysis.wantsHuman) {
      action = { type: 'FALAR_ATENDENTE', payload: null };
      logger.info('[SemanticGuard] HANDOFF convertido para FALAR_ATENDENTE');
    }
    const requestedLancamentos = semanticAnalysis.wantsLaunches;
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
      await executeAction(from, action, session, { isFirstContact });
    }

    if (!cleanText && !action) {
      logger.warn({ from, originalText: text.slice(0, 120) }, '[Fallback] IA sem texto e sem ação — enviando recuperação contextual');
      await sendContextualFallback(from, session);
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

async function executeAction(phone, action, session, opts = {}) {
  switch (action.type) {
    case 'VER_TODOS':
      await showAllCategory(phone, action.payload, session, opts);
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
      const product = await ensureProductStockData(
        session.currentProduct || session.products?.find(p => p.id === session.purchaseFlow.productId)
      );
      if (!product) {
        await zapi.sendText(phone, '❌ Nenhum produto selecionado. Escolha um produto primeiro.');
        return;
      }

      // Resolve payload: can be index (e.g., "2") or size name (e.g., "G", "GG")
      const availableSizes = getAvailableSizesForSession(session, product);
      let sizeIdx = -1;
      const numericIdx = parseInt(action.payload, 10);
      if (!isNaN(numericIdx) && numericIdx >= 1 && availableSizes[numericIdx - 1]) {
        sizeIdx = numericIdx - 1;
      } else {
        const sizeName = String(action.payload).toUpperCase().trim();
        sizeIdx = availableSizes.findIndex(s => s.toUpperCase().trim() === sizeName);
      }

      if (sizeIdx < 0 || !availableSizes[sizeIdx]) {
        await zapi.sendText(phone, `❌ Tamanho "${action.payload}" não encontrado. Disponíveis: ${availableSizes.join(' | ')}`);
        await sendStockAwareSizeList(phone, session, product, session.purchaseFlow.interactiveVersion || Date.now());
        return;
      }

      session.purchaseFlow.productId = product.id;
      session.purchaseFlow.productName = product.name;
      session.purchaseFlow.price = parseFloat(product.salePrice || product.price);
      session.purchaseFlow.selectedSize = availableSizes[sizeIdx];
      session.purchaseFlow.state = 'awaiting_quantity';
      session.purchaseFlow.interactiveVersion = Date.now();
      await sendStockAwareQuantityList(phone, session, session.purchaseFlow.selectedSize, session.purchaseFlow.interactiveVersion, product);
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
      const product = await ensureProductStockData(session.products?.[productIdx - 1]);
      if (!product) {
        await zapi.sendText(phone, `❌ Produto #${productIdx} não encontrado na lista atual.`);
        return;
      }
      // Valida se o tamanho solicitado existe
      const sizeNorm = String(size).toUpperCase().trim();
      const availableSizes = getAvailableSizesForSession(session, product);
      const matchedSize = availableSizes.find(s => s.toUpperCase().trim() === sizeNorm);
      if (!matchedSize) {
        let msg = `⚠️ Tamanho "${size}" não disponível para *${product.name}*.`;
        if (availableSizes.length > 0) {
          msg += `\nTamanhos disponíveis: ${availableSizes.join(' | ')}`;
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

    case 'HANDOFF': {
      const intercepted = await handleQueueGuard(phone, 'cart_finalize', session);
      if (!intercepted) {
        await handoffToConsultant(phone, session);
      }
      break;
    }

    case 'FALAR_ATENDENTE':
      await handoffToHuman(phone, session);
      break;

    case 'CANCELAR_FLUXO':
      await cancelCurrentFlow(phone, session);
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
      logger.error({
        err: err?.message || String(err),
        stack: err?.stack,
        ttsPhrase: ttsPhrase?.slice(0, 80),
      }, '[TTS] Fallback to text — INVESTIGAR CAUSA (créditos, API key, formato de áudio)');
    }
  }
  await zapi.sendText(phone, textFallback);
}

/**
 * Mensagens humanas para o momento em que a Bela vai carregar produtos.
 * Substitui o antigo "🔍 Buscando os melhores modelos de X pra você..."
 * que o lojista achava robótico demais.
 *
 * @param {string} displayName — nome da categoria ("Feminino", "Lançamentos da Semana")
 * @param {object} opts
 * @param {boolean} opts.isFirstContact — se é o primeiro turno da conversa
 * @returns {{ text: string, tts: string }}
 */
function pickLoadingPhrase(displayName, { isFirstContact = false } = {}) {
  if (isFirstContact) {
    const text = `Vou começar te mostrando nossos *${displayName}* 😊 já já você vê por aqui.`;
    const tts  = `Amor, vou começar te mostrando nossos ${displayName}. Já já você vê por aqui.`;
    return { text, tts };
  }

  const variants = [
    {
      text: `Fica comigo um instantinho que eu separo *${displayName}* pra você 😊`,
      tts:  `Fica comigo um instantinho que eu separo ${displayName} pra você!`,
    },
    {
      text: `Já te mostro as peças de *${displayName}* 😉`,
      tts:  `Já te mostro as peças de ${displayName}!`,
    },
    {
      text: `Peraí que eu vou te trazer *${displayName}* agora 💛`,
      tts:  `Peraí que eu vou te trazer ${displayName} agora!`,
    },
    {
      text: `Deixa eu dar uma olhadinha em *${displayName}* pra você 😊`,
      tts:  `Deixa eu dar uma olhadinha em ${displayName} pra você!`,
    },
  ];

  return variants[Math.floor(Math.random() * variants.length)];
}

function pickSearchLoadingPhrase(query) {
  const variants = [
    {
      text: `Deixa eu procurar *${query}* aqui no nosso estoque 😊`,
      tts:  `Deixa eu procurar ${query} aqui no nosso estoque!`,
    },
    {
      text: `Vou dar uma olhadinha em *${query}* pra você 💛`,
      tts:  `Vou dar uma olhadinha em ${query} pra você!`,
    },
    {
      text: `Peraí que eu já te trago o que temos de *${query}* 😉`,
      tts:  `Peraí que eu já te trago o que temos de ${query}!`,
    },
  ];
  return variants[Math.floor(Math.random() * variants.length)];
}

/**
 * Resolve o produto citado num quote/reply usando 4 estratégias em ordem:
 *   1. messageProductMap via referenceMessageId
 *   2. messageProductMap via quotedMessage.messageId / stanzaId / id
 *   3. Fallback textual por "Ref XXX" na caption do quote
 *   4. Fallback textual por nome aproximado no caption do quote
 *
 * Retorna { product, strategy } ou null. A strategy vira log estruturado
 * pra rastrear qual caminho resolveu (ou por que tudo falhou).
 */
async function resolveQuotedProduct(session, body) {
  if (!body) return null;

  // Coleta todos os IDs candidatos do payload Z-API
  const candidateIds = [
    body.referenceMessageId,
    body.quotedMessage?.messageId,
    body.quotedMessage?.stanzaId,
    body.quotedMessage?.id,
  ].filter(Boolean);

  // Estratégia 1+2: lookup direto no map
  for (const id of candidateIds) {
    const mapped = session.messageProductMap?.[id];
    if (mapped?.productId) {
      const product =
        session.products?.find(p => String(p.id) === String(mapped.productId))
        || await resolveProductById(session, mapped.productId);
      if (product) return { product, strategy: `map:${id === body.referenceMessageId ? 'refId' : 'quoteId'}` };
    }
  }

  // Estratégia 3+4: fallback textual via caption do quote
  const caption =
    body.quotedMessage?.caption
    || body.quotedMessage?.imageMessage?.caption
    || body.quotedMessage?.text
    || '';

  if (caption) {
    // Estratégia 3: match por "Ref XXX" (ex: "Ref 414L", "Ref 501S")
    const refMatch = caption.match(/ref\s*([0-9]+[a-z]?)/i);
    if (refMatch) {
      const refCode = refMatch[1];
      const refRegex = new RegExp(`ref\\s*${refCode}\\b`, 'i');
      const found = session.products?.find(p => refRegex.test(p.name || ''));
      if (found) return { product: found, strategy: `caption:ref:${refCode}` };
    }

    // Estratégia 4: match por nome aproximado (primeiras 3 palavras do caption)
    const captionWords = caption
      .replace(/[^a-záàâãéèêíïóôõöúçñ\s]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3)
      .slice(0, 3);
    if (captionWords.length >= 2) {
      const found = session.products?.find(p => {
        const name = (p.name || '').toLowerCase();
        return captionWords.every(w => name.includes(w.toLowerCase()));
      });
      if (found) return { product: found, strategy: `caption:name` };
    }
  }

  // Auditoria: nada resolveu
  logger.warn({
    candidateIds,
    mapSize: Object.keys(session.messageProductMap || {}).length,
    mapKeys: Object.keys(session.messageProductMap || {}).slice(-5),
    caption: caption?.slice(0, 120),
  }, '[QuoteReply] Resolução falhou — nenhuma estratégia pegou');

  return null;
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
  // Aumentado para 200 (antes 50) — cobre sessões B2B longas onde o lojista
  // cita cards antigos após 60+ mensagens. Purga os 50 mais antigos.
  if (keys.length > 200) keys.slice(0, 50).forEach(k => delete session.messageProductMap[k]);
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

function getLoadedProductById(session, productId) {
  if (!productId) return null;

  const normalizedId = String(productId);
  return session.products?.find(p => String(p.id) === normalizedId)
    || (session.currentProduct && String(session.currentProduct.id) === normalizedId ? session.currentProduct : null)
    || (session.lastViewedProduct && String(session.lastViewedProduct.id) === normalizedId ? session.lastViewedProduct : null)
    || null;
}

async function resolveProductById(session, productId) {
  const loaded = getLoadedProductById(session, productId);
  if (loaded) return loaded;

  try {
    const fetched = await woocommerce.getProductById(productId);
    if (fetched) {
      logger.info({ productId: fetched.id, productName: fetched.name }, '[ProductResolve] Produto resolvido fora da lista atual');
    }
    return fetched;
  } catch (err) {
    logger.error({ productId, err: err?.message || String(err) }, '[ProductResolve] Falha ao buscar produto por ID');
    return null;
  }
}

function normalizeSizeValue(size) {
  return String(size || '').trim().toUpperCase();
}

function getReservedCartQuantity(session, productId, size) {
  if (!Array.isArray(session?.items) || !productId || !size) return 0;

  return session.items.reduce((acc, item) => {
    const sameProduct = String(item.productId) === String(productId);
    const sameSize = normalizeSizeValue(item.size) === normalizeSizeValue(size);
    return sameProduct && sameSize ? acc + (parseInt(item.quantity, 10) || 0) : acc;
  }, 0);
}

async function ensureProductStockData(product) {
  if (!product) return null;
  await woocommerce.enrichProductWithStock(product);
  return product;
}

function buildSessionSizeDetails(session, product) {
  if (!product) return [];

  const baseDetails = Array.isArray(product.sizeDetails) && product.sizeDetails.length > 0
    ? product.sizeDetails
    : (product.sizes || []).map((size) => ({
        size,
        stockQuantity: null,
        isAvailable: true,
        stockLabel: 'Disponível',
      }));

  return baseDetails.map((detail) => {
    const reservedQuantity = getReservedCartQuantity(session, product.id, detail.size);
    if (typeof detail.stockQuantity !== 'number') {
      return {
        ...detail,
        reservedQuantity,
        availableQuantity: null,
        stockLabel: detail.stockLabel || 'Disponível',
      };
    }

    const availableQuantity = Math.max(detail.stockQuantity - reservedQuantity, 0);
    return {
      ...detail,
      reservedQuantity,
      availableQuantity,
      isAvailable: availableQuantity > 0,
      stockLabel: availableQuantity > 0 ? `Disponível: ${availableQuantity}` : 'Indisponível',
    };
  });
}

function getAvailableSizesForSession(session, product, excludeSizes = []) {
  return buildSessionSizeDetails(session, product)
    .filter((detail) => detail.isAvailable !== false)
    .filter((detail) => !excludeSizes.includes(detail.size))
    .map((detail) => detail.size);
}

function getSizeAvailability(session, product, size) {
  return buildSessionSizeDetails(session, product).find(
    (detail) => normalizeSizeValue(detail.size) === normalizeSizeValue(size)
  ) || null;
}

async function sendStockAwareSizeList(phone, session, product, version, excludeSizes = []) {
  const stockProduct = await ensureProductStockData(product);
  if (!stockProduct) return;

  const sizeDetails = buildSessionSizeDetails(session, stockProduct);
  const productForList = {
    ...stockProduct,
    sizeDetails,
    sizes: sizeDetails
      .filter((detail) => detail.isAvailable !== false)
      .map((detail) => detail.size),
  };

  await zapi.sendSizeList(phone, productForList, version, excludeSizes);
}

async function sendStockAwareQuantityList(phone, session, size, version, product = null) {
  const stockProduct = await ensureProductStockData(
    product || getLoadedProductById(session, session.purchaseFlow?.productId) || session.currentProduct
  );
  const availability = stockProduct ? getSizeAvailability(session, stockProduct, size) : null;
  const availableQty = availability && typeof availability.availableQuantity === 'number'
    ? availability.availableQuantity
    : null;

  if (availableQty !== null && availableQty < 1) {
    await zapi.sendText(phone, `⚠️ O tamanho *${size}* ficou sem estoque agora. Vou te mostrar os tamanhos atualizados 😊`);
    if (stockProduct) {
      const nextVersion = Date.now();
      if (session.purchaseFlow) {
        session.purchaseFlow.selectedSize = null;
        session.purchaseFlow.state = 'awaiting_size';
        session.purchaseFlow.interactiveVersion = nextVersion;
      }
      await sendStockAwareSizeList(phone, session, stockProduct, nextVersion, session.purchaseFlow?.addedSizes || []);
    }
    return;
  }

  await zapi.sendQuantityList(phone, size, version, availableQty);
}


/**
 * Adiciona um item ao carrinho silenciosamente (sem mensagem, sem menu).
 * Usado pelo grade parser para batch insert antes de enviar uma confirmação consolidada.
 */
function pushCartItem(session, productId, productName, size, qty, unitPrice, imageUrl = null) {
  if (!productId || !size || !qty || qty < 1) return;

  const existingIdx = session.items.findIndex(
    it => it.productId === productId && it.size === size
  );
  if (existingIdx >= 0) {
    const existing = session.items[existingIdx];
    existing.quantity += qty;
    const resolvedUnitPrice = existing.unitPrice || unitPrice || 0;
    existing.unitPrice = resolvedUnitPrice;
    existing.price = resolvedUnitPrice * existing.quantity;
    if (imageUrl && !existing.imageUrl) existing.imageUrl = imageUrl;
  } else {
    session.items.push({ productId, productName, size, quantity: qty, unitPrice, price: unitPrice * qty, imageUrl });
  }
  session.handoffDone = false;

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
    return false;
  }

  const selectedSize = pf.selectedSize;
  const productRef = await ensureProductStockData(
    getLoadedProductById(session, pf.productId) || session.currentProduct || await resolveProductById(session, pf.productId)
  );
  const sizeAvailability = productRef ? getSizeAvailability(session, productRef, selectedSize) : null;

  if (sizeAvailability?.isAvailable === false) {
    pf.selectedSize = null;
    pf.state = 'awaiting_size';
    pf.interactiveVersion = Date.now();
    await zapi.sendText(phone, `⚠️ O tamanho *${selectedSize}* de *${pf.productName}* não está mais disponível agora. Vou te mostrar os tamanhos atualizados 😊`);
    if (productRef) await sendStockAwareSizeList(phone, session, productRef, pf.interactiveVersion, pf.addedSizes || []);
    return false;
  }

  if (sizeAvailability && typeof sizeAvailability.availableQuantity === 'number' && qty > sizeAvailability.availableQuantity) {
    pf.interactiveVersion = Date.now();
    await zapi.sendText(
      phone,
      `⚠️ No tamanho *${selectedSize}* de *${pf.productName}* eu tenho ${sizeAvailability.availableQuantity} ${sizeAvailability.availableQuantity === 1 ? 'peça disponível' : 'peças disponíveis'} no momento.`
    );
    await sendStockAwareQuantityList(phone, session, selectedSize, pf.interactiveVersion, productRef);
    return false;
  }

  const unitPrice = pf.price || 0;
  const price = unitPrice * qty;
  const imageUrl = productRef?.imageUrl || null;

  const existingIdx = session.items.findIndex(
    it => it.productId === pf.productId && it.size === selectedSize
  );
  if (existingIdx >= 0) {
    const existing = session.items[existingIdx];
    existing.quantity += qty;
    const resolvedUnitPrice = existing.unitPrice || unitPrice || 0;
    existing.unitPrice = resolvedUnitPrice;
    existing.price = resolvedUnitPrice * existing.quantity;
    if (imageUrl && !existing.imageUrl) existing.imageUrl = imageUrl;
  } else {
    session.items.push({
      productId: pf.productId,
      productName: pf.productName,
      size: selectedSize,
      quantity: qty,
      unitPrice,
      price,
      imageUrl,
    });
  }
  session.handoffDone = false;

  if (!Array.isArray(pf.addedSizes)) pf.addedSizes = [];
  if (!pf.addedSizes.includes(selectedSize)) {
    pf.addedSizes.push(selectedSize);
  }

  const cartTotal = session.items.reduce((acc, it) => acc + parseFloat(it.price || 0), 0);
  const { lineItems, totalPieces } = getCartStats(session);
  const confirmMsg = `✅ *${pf.productName}* (${selectedSize}) x${qty} adicionado!\n\n🛒 Carrinho: ${totalPieces} ${totalPieces === 1 ? 'peça' : 'peças'} em ${lineItems} ${lineItems === 1 ? 'item' : 'itens'} — *${woocommerce.formatPrice(cartTotal)}*`;

  appendHistory(session, 'assistant', confirmMsg);
  conversationMemory.refreshConversationMemory(session, { assistantText: confirmMsg, action: { type: 'CARRINHO' } });

  const product = productRef || getLoadedProductById(session, pf.productId) || session.currentProduct;
  const remainingSizes = getAvailableSizesForSession(session, product, pf.addedSizes || []);

  pf.state = 'awaiting_more_sizes';
  pf.selectedSize = null;
  pf.interactiveVersion = Date.now();
  // Commit via menu interativo — grade considerada "em progresso", mantém
  // comportamento de enfileirar o produto no switchFsmFocus (ADR-022).
  pf.lastCommitSource = 'button';

  logger.info({ phone, productId: pf.productId, qty, cartItems: session.items.length }, '[addToCart] Item adicionado');

  if (remainingSizes.length === 0 && pf.buyQueue?.length > 0) {
    logger.info({ phone }, '[addToCart] Auto-avançando fila pendente');
    await zapi.sendText(phone, confirmMsg);
    await processNextInQueue(phone, session);
  } else {
    await sendPostAddMenu(phone, session, remainingSizes, confirmMsg);
  }

  return true;
}

/**
 * Extrai o timestamp de versão do sufixo `_v{timestamp}` de um eventId interativo.
 * Retorna o número ou null se não houver sufixo de versão.
 */
function extractEventVersion(eventId) {
  const match = eventId.match(/_v(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Retorna true se o evento veio de um menu desatualizado (versão menor que a sessão atual).
 * Botões de menus antigos devem ser rejeitados para evitar efeitos colaterais.
 */
function isStaleEvent(eventId, session) {
  const eventVersion = extractEventVersion(eventId);
  if (eventVersion === null) return false;
  const sessionVersion = session.purchaseFlow?.interactiveVersion;
  if (!sessionVersion) return false;
  return eventVersion < sessionVersion;
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

  // Opções do guard de fila chegam como cliques interativos e precisam ser
  // tratadas antes da FSM principal.
  if (eventId === 'queue_continue' || eventId === 'queue_finalize_anyway') {
    await handleQueueGuard(phone, eventId, session);
    return;
  }

  // ── buy_{productId}_v{version} ─────────────────────────────────────────
  if (eventId.startsWith('buy_')) {
    const parts = eventId.split('_');        // ['buy', '422', 'v12345']
    const productIdStr = parts[1];
    const productId = parseInt(productIdStr, 10);
    const product = await resolveProductById(session, productId);
    // No fallback to unrelated lastViewedProduct — old product cards are resolved by ID, not by current focus.

    if (!product) {
      await zapi.sendText(phone, '❌ Não consegui localizar esse produto. Me chama no catálogo que te mostro de novo 😊');
      return;
    }

    // Se outro produto já está em fluxo, enfileira o novo e aguarda
    if (pf.state !== 'idle' && pf.productId && pf.productId !== productId) {
      if (!Array.isArray(pf.buyQueue)) pf.buyQueue = [];
      const alreadyQueued = pf.buyQueue.some(q => q.productId === product.id);
      if (!alreadyQueued) {
        pf.buyQueue.push({ productId: product.id, productName: product.name, productSnapshot: product });
        logger.info({ phone, productId: product.id, queueLength: pf.buyQueue.length }, '[FSM] Produto enfileirado');

        // Resolve o produto atualmente em foco para calcular tamanhos restantes
        const currentProduct = await ensureProductStockData(getLoadedProductById(session, pf.productId) || session.currentProduct);
        const remainingSizes = getAvailableSizesForSession(session, currentProduct, pf.addedSizes || []);

        const queueMsg = `✅ *${product.name}* adicionado à fila!`;
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
    if (isStaleEvent(eventId, session)) {
      const staleProd = await ensureProductStockData(getLoadedProductById(session, pf.productId) || session.currentProduct);
      logger.info({ phone, eventId }, '[FSM] size_ expirado → reenviando menu de tamanhos');
      await zapi.sendText(phone, '⏱️ Esse menu expirou! Enviando a lista de tamanhos atualizada...');
      if (staleProd) await sendStockAwareSizeList(phone, session, staleProd, pf.interactiveVersion, pf.addedSizes || []);
      return;
    }
    // Formato: size_422_P_v1234567890  →  remove prefixo e sufixo de versão
    const withoutPrefix = eventId.slice('size_'.length);              // '422_P_v1234567890'
    const vIdx = withoutPrefix.lastIndexOf('_v');
    const withoutVersion = vIdx >= 0 ? withoutPrefix.slice(0, vIdx) : withoutPrefix;  // '422_P'
    const firstUnderscore = withoutVersion.indexOf('_');
    const productIdStr = withoutVersion.slice(0, firstUnderscore);    // '422'
    const size = withoutVersion.slice(firstUnderscore + 1);           // 'P'

    const product = await ensureProductStockData(
      getLoadedProductById(session, productIdStr)
      || getLoadedProductById(session, pf.productId)
      || session.currentProduct
    );
    const availableSizes = getAvailableSizesForSession(session, product, pf.addedSizes || []);

    if (!product || !size) {
      await zapi.sendText(phone, '❌ Não consegui identificar o tamanho. Tenta de novo?');
      if (product) await sendStockAwareSizeList(phone, session, product, pf.interactiveVersion || Date.now(), pf.addedSizes || []);
      return;
    }

    if (!availableSizes.includes(size)) {
      await zapi.sendText(phone, `❌ Tamanho "${size}" não disponível. Disponíveis: ${availableSizes.join(' | ')}`);
      await sendStockAwareSizeList(phone, session, product, pf.interactiveVersion || Date.now(), pf.addedSizes || []);
      return;
    }

    pf.productId = product.id;
    pf.productName = product.name;
    pf.price = parseFloat(product.salePrice || product.price);
    pf.selectedSize = size;
    pf.state = 'awaiting_quantity';
    pf.interactiveVersion = Date.now();

    logger.info({ phone, productId: product.id, size }, '[FSM] size_ → awaiting_quantity');
    await sendStockAwareQuantityList(phone, session, size, pf.interactiveVersion, product);
    return;
  }

  // ── qty_{qty}_v{version} ──────────────────────────────────────────────
  if (eventId.startsWith('qty_')) {
    if (isStaleEvent(eventId, session)) {
      logger.info({ phone, eventId }, '[FSM] qty_ expirado → reenviando menu de quantidade');
      await zapi.sendText(phone, '⏱️ Esse menu expirou! Enviando as opções de quantidade atualizadas...');
      if (pf.selectedSize) await sendStockAwareQuantityList(phone, session, pf.selectedSize, pf.interactiveVersion);
      return;
    }
    // Formato: qty_3_v1234567890  →  extrai o número antes de '_v'
    const withoutPrefix = eventId.slice('qty_'.length);              // '3_v1234567890'
    const vIdx = withoutPrefix.indexOf('_v');
    const qtyStr = vIdx >= 0 ? withoutPrefix.slice(0, vIdx) : withoutPrefix;
    const qty = parseInt(qtyStr, 10);

    if (isNaN(qty) || qty < 1) {
      await zapi.sendText(phone, '❌ Quantidade inválida. Escolhe de novo?');
      if (pf.selectedSize) await sendStockAwareQuantityList(phone, session, pf.selectedSize, pf.interactiveVersion || Date.now());
      return;
    }

    logger.info({ phone, qty }, '[FSM] qty_ → addToCart');
    await addToCart(phone, qty, session);
    return;
  }

  // ── add_size_v{version} ───────────────────────────────────────────────
  if (eventId.startsWith('add_size_')) {
    if (isStaleEvent(eventId, session)) {
      const staleProd = await ensureProductStockData(getLoadedProductById(session, pf.productId) || session.currentProduct);
      const staleRemaining = getAvailableSizesForSession(session, staleProd, pf.addedSizes || []);
      logger.info({ phone, eventId }, '[FSM] add_size_ expirado → reenviando menu pós-adição');
      await zapi.sendText(phone, '⏱️ Esse menu expirou! Enviando as opções atualizadas...');
      await sendPostAddMenu(phone, session, staleRemaining);
      return;
    }
    const product = await ensureProductStockData(getLoadedProductById(session, pf.productId) || session.currentProduct);
    if (!product) {
      await zapi.sendText(phone, '❌ Produto não encontrado. Vamos voltar ao catálogo?');
      return;
    }

    const excludeSizes = Array.isArray(pf.addedSizes) ? [...pf.addedSizes] : [];
    pf.state = 'awaiting_size';
    pf.selectedSize = null;
    pf.interactiveVersion = Date.now();

    logger.info({ phone, productId: product.id, excludeSizes }, '[FSM] add_size_ → sendSizeList');
    await sendStockAwareSizeList(phone, session, product, pf.interactiveVersion, excludeSizes);
    return;
  }

  // ── skip_more_v{version} ──────────────────────────────────────────────
  if (eventId.startsWith('skip_more_')) {
    if (isStaleEvent(eventId, session)) {
      const staleProd = await ensureProductStockData(getLoadedProductById(session, pf.productId) || session.currentProduct);
      const staleRemaining = getAvailableSizesForSession(session, staleProd, pf.addedSizes || []);
      logger.info({ phone, eventId }, '[FSM] skip_more_ expirado → reenviando menu pós-adição');
      await zapi.sendText(phone, '⏱️ Esse menu expirou! Enviando as opções atualizadas...');
      await sendPostAddMenu(phone, session, staleRemaining);
      return;
    }
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
  const product = await ensureProductStockData(next.productSnapshot || await resolveProductById(session, next.productId));

  if (!product) {
    logger.warn({ phone, productId: next.productId }, '[FSM] Produto da fila não encontrado, pulando');
    // Tenta o próximo da fila recursivamente
    return processNextInQueue(phone, session);
  }

  const remaining = pf.buyQueue.length;
  const queueMsg = remaining > 0
    ? `\n📋 *Ainda na fila:* ${remaining === 1 ? 'mais 1 produto aguardando' : `mais ${remaining} produtos aguardando`}`
    : '';

  await zapi.sendText(phone, `🎯 *Produto atual:* ${product.name}\nVamos continuar por ele agora 😊${queueMsg}`);

  pf.state = 'awaiting_size';
  pf.productId = product.id;
  pf.productName = product.name;
  pf.price = parseFloat(product.salePrice || product.price);
  pf.selectedSize = null;
  // Restaura tamanhos já adicionados do snapshot (lojista pode ter adicionado alguns antes de ser interrompido)
  pf.addedSizes = Array.isArray(next.addedSizes) ? [...next.addedSizes] : [];
  pf.interactiveVersion = Date.now();
  pf.lastClickedProductId = product.id;
  pf.lastClickedProductName = product.name;
  pf.lastClickedProductTimestamp = Date.now();

  logger.info({ phone, productId: product.id, queueRemaining: remaining, restoredSizes: pf.addedSizes }, '[FSM] Processando próximo da fila');
  await sendStockAwareSizeList(phone, session, product, pf.interactiveVersion, pf.addedSizes);
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

/**
 * Agrupa os itens do carrinho por productId para envio visual à vendedora.
 * Cada grupo contém: productId, productName, imageUrl, variações (size+qty) e subtotal.
 * Usado por handoffToConsultant para enviar 1 foto por produto distinto.
 */
function buildProductGroupsFromCart(session) {
  const groups = {};

  for (const item of session.items) {
    const key = item.productId;
    if (!groups[key]) {
      groups[key] = {
        productId: item.productId,
        productName: item.productName,
        imageUrl: item.imageUrl || null,
        variations: [],
        subtotal: 0,
        totalPieces: 0,
      };
    }
    groups[key].variations.push({
      size: item.size,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    });
    groups[key].subtotal += parseFloat(item.price || 0);
    groups[key].totalPieces += item.quantity;
  }

  return Object.values(groups);
}

/**
 * Clears the cart, resets purchase state, and enables a new handoff.
 */
async function clearCart(phone, session) {
  session.items = [];
  session.currentProduct = null;
  session.handoffDone = false;       // allow a new handoff after clearing
  if (session.purchaseFlow) {
    session.purchaseFlow.buyQueue = [];
  }
  resetPurchaseFlow(session);
  clearSupportMode(session, 'cart_cleared');
  logger.info({ phone }, '[Cart] Carrinho limpo');
  await zapi.sendText(phone, '🗑️ Carrinho esvaziado! Quer escolher outros produtos?');
  await sendCategoryMenu(phone, 'Qual linha você quer ver agora? 😊');
}

async function sendContextualFallback(phone, session) {
  // Sprint 1 — Não reenvia menus automaticamente após handoff humano
  if (session.supportMode === 'human_pending') {
    logger.info({ phone }, '[Fallback] supportMode=human_pending — suprimindo menu automático');
    await zapi.sendText(phone, 'Nossa consultora já vai te atender! Qualquer coisa é só chamar 😊');
    return;
  }

  const pf = session.purchaseFlow || createDefaultPurchaseFlow();

  if (pf.state === 'awaiting_size' && pf.productId) {
    const product = await ensureProductStockData(getLoadedProductById(session, pf.productId) || session.currentProduct);
    if (product) {
      await zapi.sendText(phone, `Me confirma o tamanho de *${product.name}* por aqui 😊`);
      await sendStockAwareSizeList(phone, session, product, pf.interactiveVersion || Date.now(), pf.addedSizes || []);
      return;
    }
  }

  if (pf.state === 'awaiting_quantity' && pf.selectedSize) {
    await zapi.sendText(phone, `Me diz quantas peças você quer no tamanho *${pf.selectedSize}* 😊`);
    await sendStockAwareQuantityList(phone, session, pf.selectedSize, pf.interactiveVersion || Date.now());
    return;
  }

  if (pf.state === 'awaiting_more_sizes' && pf.productId) {
    const product = await ensureProductStockData(getLoadedProductById(session, pf.productId) || session.currentProduct);
    const remainingSizes = getAvailableSizesForSession(session, product, pf.addedSizes || []);
    await sendPostAddMenu(phone, session, remainingSizes, 'Me confirma aqui como você quer seguir 😊');
    return;
  }

  if (session.items?.length > 0) {
    await sendCartOptions(phone, session, 'Me confirma por aqui se você quer revisar o carrinho, continuar nesta linha, ver outra categoria ou finalizar 😊');
    return;
  }

  // Sprint 1 — Fallback mais inteligente: se tem catálogo ativo, oferece continuar
  if (session.products?.length > 0 && session.activeCategory) {
    await sendCatalogBrowseOptions(phone, session, 'Não entendi direito 😅 Você quer que eu continue nesta linha ou prefere ver outra categoria?');
    return;
  }

  await sendCategoryMenu(phone, 'Me diz qual linha você quer ver que eu te mostro agora 😊');
}

async function showCart(phone, session) {
  if (!session.items || session.items.length === 0) {
    await sendCategoryMenu(phone, '🛒 Seu carrinho está vazio por enquanto. Qual linha você quer ver agora?');
    return;
  }
  const { summary } = buildCartSummary(session);
  await sendCartOptions(phone, session, summary);
}

/**
 * Monta a descrição dinâmica do botão "Ver Mais Produtos" mostrando
 * quantos produtos ainda restam na categoria atual.
 * - Se há categoria ativa e sabemos o total → "Mais N produtos de <linha>"
 * - Se não há contagem disponível → fallback textual estático
 */
function buildMoreProductsDescription(session, { fallback = 'Continuar comprando' } = {}) {
  const total = Number(session.totalProducts) || 0;
  const shown = Array.isArray(session.products) ? session.products.length : 0;
  const remaining = Math.max(0, total - shown);
  const displayName = session.activeCategory ? getCategoryDisplayName(session.activeCategory) : null;

  if (remaining > 0 && displayName) {
    const plural = remaining === 1 ? 'produto' : 'produtos';
    return `Mais ${remaining} ${plural} de ${displayName}`;
  }
  if (remaining > 0) {
    const plural = remaining === 1 ? 'produto' : 'produtos';
    return `Mais ${remaining} ${plural} pra ver`;
  }
  if (displayName) {
    return `Continuar em ${displayName}`;
  }
  return fallback;
}

async function sendCartOptions(phone, session, text = 'O que você prefere fazer agora?') {
  const itemLabel = `${session.items.length} ${session.items.length === 1 ? 'item' : 'itens'}`;
  const categoryLabel = session.activeCategory
    ? `Trocar de ${session.activeCategory.replace(/-/g, ' ')}`
    : 'Escolher outra linha';
  const options = [
    { id: 'cart_finalize', title: 'Finalizar Pedido', description: 'Encaminhar para fechamento' },
    { id: 'cart_view', title: 'Ver Carrinho', description: itemLabel },
    { id: 'cart_more_products', title: 'Ver Mais Produtos', description: buildMoreProductsDescription(session) },
    { id: 'cart_other_category', title: 'Ver Outra Categoria', description: categoryLabel },
    { id: 'falar_atendente', title: 'Falar com Humano', description: 'Tirar dúvidas agora' },
  ];

  await zapi.sendOptionList(phone, text, 'Próximo Passo', 'Escolher', options);
}

async function sendCatalogBrowseOptions(phone, session, text = 'O que você prefere fazer agora?') {
  const displayName = session.activeCategory ? getCategoryDisplayName(session.activeCategory) : null;
  const options = [];

  if (session.activeCategory) {
    options.push({
      id: 'btn_ver_todos',
      title: 'Ver Todos',
      description: `Todos os modelos de ${displayName}`,
    });
  }

  options.push(
    { id: 'cart_more_products', title: 'Ver Mais Produtos', description: buildMoreProductsDescription(session, { fallback: 'Continuar vendo peças' }) },
    { id: 'cart_other_category', title: 'Ver Outra Categoria', description: 'Trocar de linha agora' },
    { id: 'falar_atendente', title: 'Falar com Humano', description: 'Tirar dúvidas agora' },
  );

  await zapi.sendOptionList(phone, text, 'Próximo Passo', 'Escolher', options);
}

function buildPurchaseFlowFocusLines(session) {
  const pf = session.purchaseFlow || createDefaultPurchaseFlow();
  const queueLength = pf.buyQueue?.length || 0;
  const lines = [];

  if (pf.productName) {
    lines.push(`🎯 *Produto atual:* ${pf.productName}`);
  }

  if (queueLength > 0) {
    lines.push(`⏭️ *Próximo da fila:* ${pf.buyQueue[0].productName}`);
    if (queueLength > 1) {
      const extraPending = queueLength - 1;
      lines.push(`📋 *Depois disso:* ${extraPending === 1 ? 'mais 1 produto aguardando' : `mais ${extraPending} produtos aguardando`}`);
    }
  }

  return lines;
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
    options.push({ id: 'cart_more_products', title: 'Ver Mais Produtos', description: buildMoreProductsDescription(session) });
    options.push({ id: 'cart_other_category', title: 'Ver Outra Categoria', description: 'Trocar de linha agora' });
  }

  const focusLines = buildPurchaseFlowFocusLines(session);
  let promptText = customText;
  if (!promptText && queueLength > 0) {
    promptText = remainingSizes.length > 0
      ? 'Perfeito 😊 Quer separar outro tamanho do produto atual ou prefere ir para o próximo da fila?'
      : 'Perfeito 😊 Quer seguir para o próximo da fila ou prefere revisar o carrinho?';
  } else if (!promptText) {
    promptText = remainingSizes.length > 0
      ? `Perfeito 😊 Quer separar outro tamanho de *${pf.productName}* ou seguimos?`
      : 'Perfeito 😊 Quer revisar o carrinho, finalizar, ver mais produtos ou trocar de categoria?';
  }

  const menuText = [...focusLines, promptText].filter(Boolean).join('\n\n');
  await zapi.sendOptionList(phone, menuText, 'Próximo Passo', 'Escolher', options);
}

/**
 * Troca o foco da FSM para um novo produto, preservando o produto antigo na buyQueue
 * se ele ainda tiver tamanhos pendentes.
 * Chamado quando o lojista dá reply em um card diferente do produto em foco.
 */
function switchFsmFocus(session, newProduct) {
  const pf = session.purchaseFlow;

  // Se havia produto em foco, decidir se enfileira.
  // Regra (ADR-024): commit textual explícito (lastCommitSource === 'text')
  // é tratado como "grade fechada" — NÃO enfileira. O cliente já expressou
  // a quantidade desejada; preservar na fila geraria UX confusa.
  // Commit via botão continua enfileirando se ainda restam tamanhos (ADR-022).
  if (pf.productId && String(pf.productId) !== String(newProduct.id) && pf.state !== 'idle') {
    const oldProduct = getLoadedProductById(session, pf.productId) || session.currentProduct;
    if (oldProduct) {
      const isExplicitTextCommit =
        pf.lastCommitSource === 'text' && (pf.addedSizes?.length || 0) > 0;

      if (isExplicitTextCommit) {
        logger.info(
          { oldProduct: oldProduct.id, oldName: oldProduct.name, newProduct: newProduct.id, addedSizes: pf.addedSizes },
          '[FSM] switchFsmFocus: grade textual explícita — produto fechado, NÃO enfileira'
        );
      } else {
        const remaining = getAvailableSizesForSession(session, oldProduct, pf.addedSizes || []);
        const alreadyQueued = (pf.buyQueue || []).some(q => String(q.productId) === String(oldProduct.id));
        if (remaining.length > 0 && !alreadyQueued) {
          if (!Array.isArray(pf.buyQueue)) pf.buyQueue = [];
          pf.buyQueue.unshift({
            productId: oldProduct.id,
            productName: oldProduct.name,
            productSnapshot: oldProduct,
            addedSizes: [...(pf.addedSizes || [])],
          });
          logger.info(
            { oldProduct: oldProduct.id, newProduct: newProduct.id, queueSize: pf.buyQueue.length },
            '[FSM] switchFsmFocus: produto anterior enfileirado no topo'
          );
        }
      }
    }
  }

  pf.productId   = newProduct.id;
  pf.productName = newProduct.name;
  pf.price       = parseFloat(newProduct.salePrice || newProduct.price) || 0;
  pf.addedSizes  = [];
  pf.selectedSize = null;
  pf.state       = 'awaiting_size';
  pf.interactiveVersion = Date.now();
  // Reset do commit source — novo produto começa sem histórico de commit
  pf.lastCommitSource = null;
  pf.lastClickedProductId = newProduct.id;
  pf.lastClickedProductName = newProduct.name;
  pf.lastClickedProductTimestamp = Date.now();
  session.currentProduct = newProduct;
}

async function startInteractivePurchase(phone, product, session, introText = null) {
  if (!product) {
    await zapi.sendText(phone, '❌ Não consegui localizar esse produto. Me chama no catálogo que eu te mostro de novo 😊');
    return false;
  }

  clearSupportMode(session, 'start_interactive_purchase');
  session.currentProduct = product;
  session.handoffDone = false;        // enable new handoff when starting fresh purchase
  session.purchaseFlow.state = 'awaiting_size';
  session.purchaseFlow.productId = product.id;
  session.purchaseFlow.productName = product.name;
  session.purchaseFlow.price = parseFloat(product.salePrice || product.price);
  session.purchaseFlow.selectedSize = null;
  session.purchaseFlow.addedSizes = [];
  session.purchaseFlow.interactiveVersion = Date.now();
  // Sync lastClickedProduct* so quote-reply fallback always resolves the current product
  session.purchaseFlow.lastClickedProductId = product.id;
  session.purchaseFlow.lastClickedProductName = product.name;
  session.purchaseFlow.lastClickedProductTimestamp = Date.now();

  if (introText) {
    await zapi.sendText(phone, introText);
  }

  // Short-circuit para produtos com 0 ou 1 tamanho — pula awaiting_size
  const productWithStock = await ensureProductStockData(product);
  const productSizes = (productWithStock?.sizes || []).filter(Boolean);

  if (productSizes.length === 0) {
    // Produto sem variação de tamanho — usar 'ÚNICO' como tamanho padrão
    session.purchaseFlow.selectedSize = 'ÚNICO';
    session.purchaseFlow.state = 'awaiting_quantity';
    await zapi.sendText(phone, `📦 *${product.name}* — produto sem variação de tamanho. Quantas unidades você quer?`);
    await sendStockAwareQuantityList(phone, session, 'ÚNICO', session.purchaseFlow.interactiveVersion, productWithStock);
    return true;
  }

  if (productSizes.length === 1) {
    // Produto com único tamanho — seleciona automaticamente e pede quantidade
    const singleSize = productSizes[0];
    session.purchaseFlow.selectedSize = singleSize;
    session.purchaseFlow.state = 'awaiting_quantity';
    await zapi.sendText(phone, `📦 *${product.name}* vem em *${singleSize}*. Quantas unidades você quer?`);
    await sendStockAwareQuantityList(phone, session, singleSize, session.purchaseFlow.interactiveVersion, productWithStock);
    return true;
  }

  await sendStockAwareSizeList(phone, session, productWithStock, session.purchaseFlow.interactiveVersion);
  return true;
}

// ── Flow Functions ────────────────────────────────────────────────────────


async function showProductPhotos(phone, productRef, session) {
  let product = null;

  // PRIORIDADE 1 (ADR-026): se a FSM está ativa, o produto em foco é a
  // resposta correta para "tem foto dele?" / "manda a foto". A IA pode
  // emitir [FOTOS:N] baseada em posição de session.products[] que ainda
  // contém uma lista anterior — ignorar o N quando há produto em foco.
  const pf = session.purchaseFlow;
  const fsmActive = pf && pf.state !== 'idle' && pf.productId;
  if (fsmActive) {
    product = getLoadedProductById(session, pf.productId)
      || session.currentProduct
      || await resolveProductById(session, pf.productId);
    if (product) {
      logger.info(
        { productId: product.id, productName: product.name, fsmState: pf.state, ignoredRef: productRef },
        '[showProductPhotos] FSM ativa — priorizando produto em foco'
      );
    }
  }

  if (!product) {
    if (productRef && typeof productRef === 'object' && productRef.id) {
      product = productRef;
    } else if (Number.isInteger(productRef) && productRef >= 1 && session.products?.[productRef - 1]) {
      product = session.products[productRef - 1];
    } else if (productRef) {
      product = await resolveProductById(session, productRef);
    }
  }

  if (!product) {
    await zapi.sendText(phone, `❌ Não consegui localizar esse produto agora. Me chama no catálogo que eu te mostro de novo 😊`);
    return;
  }
  
  if (!product.images || product.images.length === 0) {
    await zapi.sendText(phone, `😕 Não encontrei fotos adicionais para *${product.name}*.`);
    return;
  }
  
  try {
    await zapi.sendText(phone, `📸 Enviando as fotos de *${product.name}*...`);
    for (const [i, url] of product.images.entries()) {
      await zapi.sendImage(phone, url, `Foto ${i + 1} de ${product.images.length} - ${product.name}`);
      await zapi.delay(400);
    }
    
    await startInteractivePurchase(phone, product, session, 'Qualquer coisa é só clicar no botão abaixo, ou me mandar o tamanho!');
  } catch (err) {
    logger.error({ err: err.message, productId: product.id }, '[showProductPhotos] Error');
    await zapi.sendText(phone, '⚠️ Erro ao buscar fotos do produto.');
  }
}

async function searchAndShowProducts(phone, query, session) {
  clearSupportMode(session, 'search_products');
  const phrase = pickSearchLoadingPhrase(query);
  await sendLoadingMessage(phone, phrase.text, phrase.tts);

  let searchResult;
  try {
    searchResult = await woocommerce.searchProducts(query, 10, 1);
  } catch (err) {
    logger.error({ query, err: err.message }, '[searchAndShowProducts] Erro na busca WooCommerce');
    await zapi.sendText(phone, `⚠️ Não consegui buscar "${query}" agora. Tenta de novo em instantes? 😊`);
    return;
  }

  const products = searchResult.products;
  if (!products || products.length === 0) {
    await zapi.sendText(phone, `😕 Poxa, não encontrei nada buscando por "${query}".`);
    return;
  }

  session.products = products;
  session.currentCategory = null;
  session.activeCategory = null;
  session.currentPage = 1;
  session.totalPages = 1; // Paginação de search ainda não encadeada em showNextPage — preserva comportamento antigo
  session.totalProducts = products.length;

  // Enviar cards (sem lista de texto redundante)
  session.purchaseFlow.interactiveVersion = Date.now();
  for (const [i, product] of products.entries()) {
    if (product.imageUrl) {
      try {
        const scRes = await zapi.sendProductShowcase(phone, product, session.purchaseFlow.interactiveVersion);
        registerMessageProduct(session, scRes?.data?.zaapId, scRes?.data?.messageId, product);
      } catch {
        try {
          const imgRes = await zapi.sendImage(phone, product.imageUrl, woocommerce.buildCaption(product, i + 1));
          registerMessageProduct(session, imgRes?.data?.zaapId, imgRes?.data?.messageId, product);
        } catch (imgErr) {
          logger.warn({ productId: product.id, err: imgErr?.message }, '[searchAndShowProducts] Falha ao enviar imagem');
        }
      }
      await zapi.delay(400);
    }
  }

  if (products.length > 0) {
    session.lastViewedProduct = products[products.length - 1];
    session.lastViewedProductIndex = products.length;
  }

  // Follow-up da IA — try/catch separado: falha da IA não mata o fluxo nem mostra "Erro ao buscar"
  try {
    const nudge = '[SISTEMA: Os produtos da busca foram exibidos. Reagir naturalmente — pode ser curto, tipo "gostou?" ou "tem mais coisa?". NÃO liste produtos, NÃO dê instruções de número. Mantenha o ritmo de WhatsApp.]';
    appendHistory(session, 'system', nudge);
    conversationMemory.refreshConversationMemory(session, { action: { type: 'BUSCAR', payload: query } });

    const aiRaw = await ai.chat(getActiveHistoryWindow(session), buildAiContext(session));
    const { cleanText } = ai.parseAction(aiRaw);
    if (cleanText) {
      appendHistory(session, 'assistant', cleanText);
      conversationMemory.refreshConversationMemory(session, { assistantText: cleanText });
      if (session.items.length > 0) {
        await sendCartOptions(phone, session, cleanText);
      } else {
        // Após busca: só texto da IA, sem menu forçado.
        // O menu de categorias só aparece se o cliente pedir explicitamente.
        await zapi.sendText(phone, cleanText);
      }
    }
  } catch (aiErr) {
    logger.error({ query, err: aiErr.message }, '[searchAndShowProducts] Erro na IA — usando fallback');
    const fallbacks = [
      'Gostou de alguma? Me manda o número pra eu separar o tamanho 😊',
      'Achou o que procurava? É só me dizer o número da peça!',
      'Quer saber mais sobre alguma dessas? Só falar 😄',
    ];
    const fallback = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    await zapi.sendText(phone, fallback);
  }
}

async function showCategory(phone, slug, session) {

  slug = normalizeCategorySlug(slug);
  clearSupportMode(session, 'show_category');
  const displayName = getCategoryDisplayName(slug);
  const phrase = pickLoadingPhrase(displayName);
  await sendLoadingMessage(phone, phrase.text, phrase.tts);

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

async function showAllCategory(phone, slug, session, opts = {}) {
  slug = normalizeCategorySlug(slug);
  clearSupportMode(session, 'show_all_category');
  const displayNameAll = getCategoryDisplayName(slug);
  const phrase = pickLoadingPhrase(displayNameAll, { isFirstContact: !!opts.isFirstContact });
  await sendLoadingMessage(phone, phrase.text, phrase.tts);

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

    // Gera a versão UMA VEZ antes do loop — todos os botões do lote compartilham a mesma versão
    session.purchaseFlow.interactiveVersion = Date.now();
    let showcaseFailures = 0;
    for (const [i, product] of allProducts.entries()) {
      if (product.imageUrl) {
        try {
          let sent = false;

          try {
            const scRes = await zapi.sendProductShowcase(phone, product, session.purchaseFlow.interactiveVersion);
            registerMessageProduct(session, scRes?.data?.zaapId, scRes?.data?.messageId, product);
            sent = true;
          } catch (showcaseErr) {
            logger.warn(
              { productId: product.id, err: showcaseErr?.message || String(showcaseErr) },
              '[showAllCategory] sendProductShowcase falhou — tentando sendImage'
            );
          }

          if (!sent) {
            try {
              const imgRes = await zapi.sendImage(phone, product.imageUrl, woocommerce.buildCaption(product, i + 1));
              registerMessageProduct(session, imgRes?.data?.zaapId, imgRes?.data?.messageId, product);
              sent = true;
            } catch (imageErr) {
              showcaseFailures += 1;
              logger.error(
                { productId: product.id, err: imageErr?.message || String(imageErr) },
                '[showAllCategory] Falha ao enviar vitrine do produto'
              );
            }
          }

          if (!sent) {
            continue;
          }
        } catch (loopErr) {
          showcaseFailures += 1;
          logger.error(
            { productId: product.id, err: loopErr?.message || String(loopErr) },
            '[showAllCategory] Erro inesperado ao processar produto da vitrine'
          );
        }
        await zapi.delay(400);
      }
    }

    if (allProducts.length > 0) {
      session.lastViewedProduct = allProducts[allProducts.length - 1];
      session.lastViewedProductIndex = allProducts.length;
    }

    if (showcaseFailures > 0) {
      logger.warn({ slug, showcaseFailures }, '[showAllCategory] Alguns produtos falharam na vitrine, mas o fluxo continuou');
    }

    try {
      const followUpText = session.items.length > 0
        ? 'Separei tudo aqui 😊 Se quiser, me fala o número da peça que gostou ou escolhe abaixo se quer revisar o carrinho, finalizar ou ver outra coleção.'
        : 'Me diz o número da peça que você gostou, ou se preferir escolhe outra coleção aqui embaixo 😊';

      appendHistory(session, 'assistant', followUpText);
      conversationMemory.refreshConversationMemory(session, {
        assistantText: followUpText,
        action: { type: 'VER_TODOS', payload: slug },
      });

      if (session.items.length > 0) {
        await sendCartOptions(phone, session, followUpText);
      } else {
        await sendCategoryMenu(phone, followUpText);
      }
    } catch (followUpErr) {
      logger.error(
        { slug, err: followUpErr?.message || String(followUpErr) },
        '[showAllCategory] Falha no follow-up determinístico após vitrine completa'
      );
    }
  } catch (err) {
    logger.error({ slug, code: err.code, err: err.message }, '[showAllCategory] Error');
    await zapi.sendText(phone, '⚠️ Erro ao buscar itens de uma vez só.');
  }
}

function mergeProductsUnique(existing, incoming) {
  const seen = new Set(existing.map(p => p.id));
  const merged = [...existing];
  for (const p of incoming) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      merged.push(p);
    }
  }
  return merged;
}

async function showNextPage(phone, session) {
  if (!session.currentCategory || session.currentPage >= session.totalPages) {
    await zapi.sendText(phone, '✅ Todos os produtos já foram mostrados.');
    return;
  }

  try {
    clearSupportMode(session, 'show_next_page');
    const nextPage = session.currentPage + 1;
    const result = await woocommerce.getProductsByCategory(session.currentCategory, 10, nextPage);

    const startIdx = session.products.length;
    const mergedProducts = mergeProductsUnique(session.products, result.products);
    const newlyAdded = mergedProducts.slice(startIdx);
    session.products = mergedProducts;
    session.currentPage = result.page;

    // Enviar apenas os produtos recém-adicionados (únicos), preservando indexação do carrinho
    await sendProductPage(phone, { ...result, products: newlyAdded }, session, startIdx);
  } catch (err) {
    logger.error({ err: err.message }, '[showNextPage] Error');
    await zapi.sendText(phone, '⚠️ Erro ao carregar mais produtos.');
  }
}

async function sendProductPage(phone, result, session, startIdx = 0) {
  session.purchaseFlow.interactiveVersion = Date.now();
  for (const [i, product] of result.products.entries()) {
    if (product.imageUrl) {
      try {
        let sent = false;

        try {
          const scRes = await zapi.sendProductShowcase(phone, product, session.purchaseFlow.interactiveVersion);
          registerMessageProduct(session, scRes?.data?.zaapId, scRes?.data?.messageId, product);
          sent = true;
        } catch (showcaseErr) {
          logger.warn(
            { productId: product.id, err: showcaseErr?.message || String(showcaseErr) },
            '[sendProductPage] sendProductShowcase falhou — tentando sendImage'
          );
        }

        if (!sent) {
          try {
            const imgRes = await zapi.sendImage(phone, product.imageUrl, woocommerce.buildCaption(product, startIdx + i + 1));
            registerMessageProduct(session, imgRes?.data?.zaapId, imgRes?.data?.messageId, product);
          } catch (imageErr) {
            logger.error(
              { productId: product.id, err: imageErr?.message || String(imageErr) },
              '[sendProductPage] Falha ao enviar imagem fallback — produto pulado'
            );
          }
        }
      } catch (loopErr) {
        logger.error(
          { productId: product.id, err: loopErr?.message || String(loopErr) },
          '[sendProductPage] Erro inesperado ao processar produto'
        );
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
    ? `[SISTEMA: Página ${session.currentPage} de ${session.totalPages} exibida. Papo fluindo — próxima pode ser "PROXIMOS" se ela quiser. Reação curta no ritmo de zap, sem listar nada.]`
    : `[SISTEMA: Todos os produtos da categoria já foram exibidos. Conversa aberta — reação curta e natural, sem listar, sem menu.]`;
  appendHistory(session, 'system', nudge);
  conversationMemory.refreshConversationMemory(session, { action: { type: 'VER_CATEGORIA', payload: session.currentCategory } });

  // Follow-up da IA — try/catch separado: falha da IA não mata o fluxo nem gera "Erro ao buscar produtos"
  let followUpText = '';
  try {
    const aiRaw = await ai.chat(getActiveHistoryWindow(session), buildAiContext(session));
    const parsed = ai.parseAction(aiRaw);
    followUpText = parsed.cleanText || '';
    if (followUpText) {
      appendHistory(session, 'assistant', followUpText);
      conversationMemory.refreshConversationMemory(session, { assistantText: followUpText });
    } else {
      logger.warn({ category: session.currentCategory, aiRawLen: aiRaw?.length || 0 }, '[sendProductPage] IA retornou texto vazio — usando fallback');
    }
  } catch (aiErr) {
    logger.error({ err: aiErr.message, category: session.currentCategory }, '[sendProductPage] Erro na IA — produtos já exibidos');
  }

  // Fallback determinístico: garante que o menu SEMPRE é enviado após os produtos,
  // mesmo que a IA tenha falhado ou retornado vazio. Nunca deixa a conversa morrer.
  if (!followUpText) {
    const fallbacks = [
      'Gostou de alguma? 😊 Me diz o número pra gente seguir!',
      'Achou algo que curtiu? Só falar qual 😄',
      'Alguma dessas te chamou atenção? Me conta!',
    ];
    followUpText = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    appendHistory(session, 'assistant', followUpText);
    conversationMemory.refreshConversationMemory(session, { assistantText: followUpText });
  }

  if (session.items.length > 0) {
    await sendCartOptions(phone, session, followUpText);
  } else if (hasMore && session.activeCategory) {
    await sendCatalogBrowseOptions(phone, session, followUpText);
  } else {
    await sendCategoryMenu(phone, followUpText);
  }
}

/**
 * Finalizes the order by notifying the customer and forwarding the order summary to the admin.
 * Called when the AI emits [HANDOFF] or the customer confirms checkout with a pending queue.
 *
 * @param {string} phone - Customer phone number
 * @param {object} session - Current session object
 */
async function handoffToHuman(phone, session) {
  if (session.supportMode === 'human_pending') {
    logger.info({ phone }, '[HumanHandoff] Duplicate request while already pending');
    await zapi.sendText(phone, 'Perfeito 😊 Nossa consultora já foi avisada e vai seguir com você por aqui.');
    return;
  }

  const itemCount = session.items?.length || 0;
  const cartBlock = itemCount > 0
    ? `\n\n${buildCartSummary(session, '🛒 *CARRINHO ATUAL*').summary}`
    : '\n\n🛒 *Carrinho atual:* vazio';

  // Sprint 1 — Reseta FSM e buyQueue para impedir que o sistema
  // continue insistindo em perguntas de tamanho/quantidade após handoff.
  if (session.purchaseFlow) {
    session.purchaseFlow.buyQueue = [];
  }
  resetPurchaseFlow(session);
  session.supportMode = 'human_pending';

  await zapi.sendText(
    phone,
    'Perfeito 😊 Vou sinalizar nossa consultora aqui para seguir com você no atendimento.'
  );

  if (!ADMIN_PHONE) {
    logger.warn({ phone }, '[HumanHandoff] ADMIN_PHONE not configured — skipping admin notification');
    return;
  }

  const adminMsg =
    `🙋 *ATENDIMENTO HUMANO SOLICITADO*\n` +
    `📱 wa.me/${phone}\n` +
    (session.customerName ? `👤 ${session.customerName}\n` : '') +
    `${cartBlock}`;

  try {
    await zapi.sendText(ADMIN_PHONE, adminMsg);
    logger.info({ phone, adminPhone: ADMIN_PHONE, itemCount }, '[HumanHandoff] Admin notified');
  } catch (err) {
    logger.error({ err: err?.message || String(err), adminPhone: ADMIN_PHONE }, '[HumanHandoff] Failed to notify admin');
  }
}

async function handoffToConsultant(phone, session) {
  // Guard: prevent duplicate handoff in the same session
  if (session.handoffDone) {
    logger.warn({ phone }, '[Handoff] Duplicated handoff blocked');
    return;
  }

  if (!session.items || session.items.length === 0) {
    await zapi.sendText(phone, '😊 Seu carrinho está vazio! Adicione alguns produtos antes de fechar o pedido.');
    return;
  }

  const { summary, total } = buildCartSummary(session, '🛒 *RESUMO DO SEU PEDIDO*');

  // ── 1. Notify the customer ──────────────────────────────────────────────
  const customerMsg =
    `${summary}\n\n` +
    `✅ *Pedido recebido!*\n` +
    `Nossa consultora já foi notificada e vai entrar em contato em breve para confirmar os detalhes e combinar a forma de pagamento. 😊\n\n` +
    `_Qualquer dúvida, é só chamar!_ 💕`;

  await zapi.sendText(phone, customerMsg);
  logger.info({ phone, total, itemCount: session.items.length }, '[Handoff] Order summary sent to customer');

  // ── 2. Notify the admin (ADMIN_PHONE) ──────────────────────────────────
  if (ADMIN_PHONE) {
    // 2a. Resumo em texto com header do pedido
    const adminHeader =
      `📦 *NOVO PEDIDO — Agente Belux*\n` +
      `─────────────────\n` +
      `📱 *Lojista:* wa.me/${phone}\n` +
      (session.customerName ? `👤 *Nome:* ${session.customerName}\n` : '') +
      `─────────────────\n` +
      `${summary}\n\n` +
      `📸 _Enviando fotos dos produtos a seguir..._`;

    try {
      await zapi.sendText(ADMIN_PHONE, adminHeader);
      logger.info({ phone, adminPhone: ADMIN_PHONE }, '[Handoff] Text summary sent to admin');

      // 2b. Uma foto por produto distinto (identificação visual sem SKU)
      const groups = buildProductGroupsFromCart(session);
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const variationsText = g.variations
          .map(v => `${v.size} x${v.quantity}`)
          .join(' · ');

        const caption =
          `📦 *Produto ${i + 1}/${groups.length}*\n` +
          `*${g.productName}*\n` +
          `Tamanhos: ${variationsText}\n` +
          `Total: ${g.totalPieces} ${g.totalPieces === 1 ? 'peça' : 'peças'} — ${woocommerce.formatPrice(g.subtotal)}`;

        if (g.imageUrl) {
          try {
            await zapi.sendImage(ADMIN_PHONE, g.imageUrl, caption);
            await zapi.delay(400); // evita flood Z-API
          } catch (err) {
            logger.error({ err: err?.message, productId: g.productId }, '[Handoff] Falha ao enviar foto, fallback para texto');
            await zapi.sendText(ADMIN_PHONE, caption);
          }
        } else {
          // Fallback: produto sem imagem cadastrada
          await zapi.sendText(ADMIN_PHONE, caption + '\n⚠️ _Produto sem foto cadastrada._');
        }
      }

      logger.info({ phone, groupCount: groups.length }, '[Handoff] Photos forwarded to admin');
    } catch (err) {
      logger.error({ err: err?.message || String(err), adminPhone: ADMIN_PHONE }, '[Handoff] Failed to notify admin');
    }
  } else {
    logger.warn({ phone }, '[Handoff] ADMIN_PHONE not configured — skipping admin notification');
  }

  // ── 3. Persist order to Supabase (audit trail) ───────────────────────────
  try {
    await db.saveOrder({
      phone,
      customerName: session.customerName || null,
      items: session.items,
      total,
    });
    logger.info({ phone, total }, '[Handoff] Order persisted to Supabase');
  } catch (err) {
    // Non-blocking: do not abort handoff if persistence fails
    logger.error({ err: err?.message || String(err) }, '[Handoff] Failed to persist order — handoff continues');
  }

  // ── 4. Reset purchase flow (keep items for audit) ──────────────────
  resetPurchaseFlow(session);
  session.handoffDone = true;

  await persistSession(phone);
  logger.info({ phone }, '[Handoff] Session handed off successfully');
}

app.get('/', (_req, res) => res.json({ status: 'online', activeSessions: Object.keys(sessions).length }));

server.listen(PORT, () => {
  logger.info({ port: PORT }, '🚀 Agente Belux running');
});
