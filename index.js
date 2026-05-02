require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
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
const archiver = require('./services/session-archiver');
const shadowV2 = require('./services/agent-v2/shadow-router');
const imageMatcher = require('./services/image-matcher');
const catalogSync  = require('./services/catalog-sync');
const catalogQueryResolver = require('./services/catalog-query-resolver');
const catalogSearch = require('./services/catalog-search');
const pdfService = require('./services/pdf');
const { buildProductGroupsFromCart, buildProductGroupsFromMatched } = require('./services/order-groups');
const { distributeCompoundGrade } = require('./services/grade-distributor');
const phoneUtils = require('./src/utils/phone');
const { parseBelaPauseCommand, parseTrackingCommand } = require('./src/inbound/command-parsers');
const { HUMAN_PAUSE_MODES, isBotSuspendedForHuman, shouldSkipBotAutomation } = require('./src/session/flags');
const { isHumanPauseResumeIntent } = require('./src/ai/intent');
const { parseGradeText, parseMultiVariantGrade, normalizeVariantText, matchVariant, normalizeSizeValue } = require('./src/utils/variant-text');
const { parseCompoundSpec } = require('./src/utils/compound-parser');
const { extractTextFromEvent, extractAudioUrl, extractEventVersion, parseSizeQtyEvent } = require('./src/utils/event-extractor');
const { getPublicBaseUrl, buildPublicAssetUrl } = require('./src/utils/public-url');
const { digitsOnly, normalizeWhatsAppPhone } = phoneUtils;

const TTS_ENABLED = process.env.TTS_ENABLED === 'true';

const app = express();
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const http = require('http');
const { Server } = require('socket.io');
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
global.visualIo = io;

const PORT = process.env.PORT || 3000;
const ORDER_GUIDE_IMAGE_PATH = '/assets/order-guide.png';
const ORDER_GUIDE_IMAGE_FILE = path.join(__dirname, 'assets', 'order-guide.png');
const ADMIN_PHONES = (process.env.ADMIN_PHONES || process.env.ADMIN_PHONE || '')
  .split(',').map(n => n.trim()).filter(Boolean);
const HANDOFF_PIX_DISCOUNT_PCT = parseFloat(process.env.PIX_DISCOUNT_PCT || '10');
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes inactivity
// Timestamp do momento em que o servidor foi iniciado.
// Sessões carregadas do Supabase com last_activity anterior a este momento
// têm o histórico de conversa zerado — o cliente começa "do zero" após reinício.
const SERVER_START_TIME = Date.now();
const MAX_HISTORY_MESSAGES = parseInt(process.env.MAX_HISTORY_MESSAGES || '80', 10);
// Janela deslizante de contexto enviada ao Gemini. Turnos mais antigos que
// CONTEXT_WINDOW_MS são arquivados em conversationMemory.archivedSummary.
// SESSION_TIMEOUT_MS (30min) continua sendo o TTL do carrinho/FSM — a janela
// de 20min afeta apenas o que a IA vê no prompt.
const CONTEXT_WINDOW_MS = parseInt(process.env.CONTEXT_WINDOW_MS || String(20 * 60 * 1000), 10);
const INACTIVITY_GREETING_MS = parseInt(process.env.INACTIVITY_GREETING_MS || String(20 * 60 * 1000), 10);
const CATALOG_RESOLVER_ENABLED = String(process.env.CATALOG_RESOLVER_ENABLED || '').toLowerCase() !== 'false';

// Wrapper que injeta ADMIN_PHONES na função pura de src/utils/phone.js.
const isAdminPhone = (phone) => phoneUtils.isAdminPhone(phone, ADMIN_PHONES);

// (helpers de pause/tracking/intent movidos para src/)

// (grade parser movido para src/utils/compound-parser.js e src/utils/variant-text.js)

// ── Sessions ──────────────────────────────────────────────────────────────
const inboundTextDebounceBuffer = new Map();
const INBOUND_TEXT_DEBOUNCE_MS = parseInt(process.env.INBOUND_TEXT_DEBOUNCE_MS || '2500', 10);

function shouldDebounceInboundText(body, text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (body?.image?.imageUrl) return false;
  if (body?.listResponseMessage || body?.buttonsResponseMessage) return false;
  if (body?.quotedMessage || body?.referenceMessageId) return false;
  if (/^\[(?:audio|audio_stt|sticker)\]$/i.test(value.normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) return false;
  if (/^(CART_VIEW|CART_REMOVE_ITEM|CART_FINALIZE|FALAR_ATENDENTE|BTN_FECHAR_PEDIDO|BUSCAR_PRODUTO_MENU|VER_TODOS_CATEGORIA)$/i.test(value)) return false;
  if (value.includes('CONTA EM TRIAL') || value.includes('MENSAGEM DE TESTE')) return false;
  return true;
}

function formatBufferedInboundMessages(messages) {
  const texts = (messages || [])
    .map(entry => String(entry?.text || '').trim())
    .filter(Boolean);

  if (texts.length <= 1) return texts[0] || '';

  return [
    `Cliente enviou ${texts.length} mensagens em sequencia. Leia como uma unica fala e responda ao pedido completo, sem responder item por item:`,
    ...texts.map(text => `- ${text}`),
  ].join('\n');
}

function enqueueInboundTextDebounce(phone, body, text, opts = {}) {
  const bufferMap = opts.bufferMap || inboundTextDebounceBuffer;
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : INBOUND_TEXT_DEBOUNCE_MS;
  const setTimer = opts.setTimeout || setTimeout;
  const clearTimer = opts.clearTimeout || clearTimeout;

  const message = {
    body,
    text: String(text || '').trim(),
    messageId: body?.messageId || null,
    ts: Date.now(),
  };

  const existing = bufferMap.get(phone);
  if (existing) {
    existing.messages.push(message);
    clearTimer(existing.timer);
    existing.timer = setTimer(() => {
      bufferMap.delete(phone);
      existing.resolve(buildInboundTextFlush(existing.messages));
    }, debounceMs);
    return null;
  }

  let resolveFlush;
  const firstFlush = new Promise(resolve => {
    resolveFlush = resolve;
  });

  const entry = {
    messages: [message],
    resolve: resolveFlush,
    timer: null,
  };

  entry.timer = setTimer(() => {
    bufferMap.delete(phone);
    resolveFlush(buildInboundTextFlush(entry.messages));
  }, debounceMs);

  bufferMap.set(phone, entry);
  return firstFlush;
}

function buildInboundTextFlush(messages) {
  const last = messages[messages.length - 1] || {};
  const text = formatBufferedInboundMessages(messages);
  const body = JSON.parse(JSON.stringify(last.body || {}));
  body.text = { ...(body.text || {}), message: text };

  return {
    body,
    text,
    messageId: last.messageId || null,
    messageIds: messages.map(entry => entry.messageId).filter(Boolean),
    messages,
  };
}

// -- Sessions
const sessions = {};
const sessionLoadLocks = new Map();
const persistQueues = new Map();

/**
 * ⚠️ ÁREA SENSÍVEL — Deduplicação de eventos webhook (ADR-034)
 *
 * Z-API pode reenviar o mesmo webhook em caso de timeout ou falha de entrega.
 * Sem essa proteção, uma mensagem inicial (history.length === 0) pode disparar
 * a saudação de boas-vindas duas vezes, pois ambos os webhooks passam pelo
 * sessionLoadLocks e avaliam isFirstContact = true antes de appendHistory ser
 * chamado (race condition comprovada em testes).
 *
 * COMO FUNCIONA: Map de phone:messageId → timestamp. TTL de 30s.
 * Qualquer webhook com messageId já visto no intervalo é descartado antes de
 * qualquer processamento, incluindo getSession.
 *
 * NÃO REMOVER nem aumentar o TTL abaixo de 15s.
 * NÃO desabilitar para "testar" sem ambiente isolado — em produção o efeito
 * é imediato (cliente recebe saudação duplicada + catálogo duplicado).
 */
const SEEN_MESSAGE_IDS = new Map();
const SEEN_MSG_TTL_MS  = 30_000; // 30s — margem acima do retry típico do Z-API

/** Debounce de seleções múltiplas: acumula buy_ events por telefone por 15s */
const buyDebounceBuffer = new Map();
// Estrutura: phone → { products: [productSnapshot], timer: Timeout }

/** Debounce de silêncio pós-adição: agenda resumo do carrinho após inatividade */
const silentAddDebounce = new Map();
// Estrutura: phone → { timer: Timeout }

/** Fila de processamento por telefone — garante serialização (evita race conditions) */
const phoneProcessingQueue = new Map();
// Estrutura: phone → Promise (resolve quando o processamento em curso terminar)

/** Timer de upsell pós-checkout: atrasa envio para admin em 5min, mostra categoria não vista */
const upsellHandoffTimers = new Map();
// Estrutura: phone → { timer: Timeout }

/** Timer de inatividade pós "fechar pedido": 90s sem mensagem → notifica vendedora */
const fecharPedidoInactivityTimers = new Map();
// Estrutura: phone → Timeout

/** Timer de debounce do caso composto multimodal: 3s sem mensagem → Bela confirma grade */
const compoundConfirmationTimers = new Map();
// Estrutura: phone → Timeout
const COMPOUND_DEBOUNCE_MS = 3000;

/** Timer de debounce do compound em modo normal (ver lançamento, catálogo): 1.5s */
const normalCompoundTimers = new Map();
// Estrutura: phone → Timeout
const NORMAL_COMPOUND_DEBOUNCE_MS = 1500;
const MAX_WAIT_FOR_FLIGHT = 30_000;
/** Janela máxima desde a primeira foto até detecção compound em modo normal.
 *  5 minutos — cliente B2B naturalmente navega pelo catálogo, manda fotos em
 *  momentos distintos e só capta a legenda na última. O pool é zerado após
 *  cada compound aceito, então não há risco de arrastar fotos de pedidos passados. */
const NORMAL_COMPOUND_WINDOW_MS = 5 * 60 * 1000; // 5 min

function markImageMatchStarted(session) {
  if (!session) return;
  session.pendingImageMatches = (session.pendingImageMatches || 0) + 1;
  session.firstPhotoAt = session.firstPhotoAt || Date.now();
}

function markImageMatchFinished(session) {
  if (!session) return;
  session.pendingImageMatches = Math.max(0, (session.pendingImageMatches || 0) - 1);
  if (session.pendingImageMatches === 0) {
    session.imageMatchesCompletedAt = Date.now();
    session.firstPhotoAt = null;
  }
}

/**
 * Aguarda até `timeoutMs` que session.pendingImageMatches caia para 0.
 * Evita race condition: cliente clica "Finalizar" enquanto matchProductFromImage
 * (até 8s) ainda não terminou — handoff veria session.items vazio.
 */
async function awaitPendingImageMatches(session, timeoutMs = 8000) {
  if (!session) return;
  const start = Date.now();
  while ((session.pendingImageMatches || 0) > 0 && (Date.now() - start) < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

const SLUG_MAP = {
  'feminina': 'feminino',
  'feminino': 'feminino',
  'feminino_infantil': 'femininoinfantil',
  'masculina': 'masculino',
  'masculino': 'masculino',
  'masculino_infantil': 'masculinoinfantil',
  'lancamentos': 'lancamento-da-semana',
  'lancamento': 'lancamento-da-semana',
  'promocao': 'promocao',
  'promocoes': 'promocao',
  'promoção': 'promocao',
  'promocoes-semanal': 'promocao'
};

const CATEGORY_DISPLAY_NAMES = {
  'feminino':             'Feminino',
  'femininoinfantil':     'Feminino Infantil',
  'masculino':            'Masculino',
  'masculinoinfantil':    'Masculino Infantil',
  'lancamento-da-semana': 'Lançamentos da Semana',
  'promocao':             'Promoção',
};

function getCategoryDisplayName(slug) {
  return CATEGORY_DISPLAY_NAMES[slug] || slug;
}

const CAT_SENTINELS = {
  'CAT_LANCAMENTOS':       'lancamento-da-semana',
  'CAT_FEMININO':          'feminino',
  'CAT_FEMININOINFANTIL':  'femininoinfantil',
  'CAT_MASCULINO':         'masculino',
  'CAT_MASCULINOINFANTIL': 'masculinoinfantil',
  'CAT_PROMOCAO':          'promocao',
};
const CATEGORY_OPTIONS = [
  { id: 'cat_lancamentos', title: 'Lançamentos', description: 'As novidades da semana' },
  { id: 'cat_feminina', title: 'Feminino', description: 'Moda íntima feminina' },
  { id: 'cat_feminino_infantil', title: 'Feminino Infantil', description: 'Conforto para as meninas' },
  { id: 'cat_masculina', title: 'Masculino', description: 'Moda íntima masculina' },
  { id: 'cat_masculino_infantil', title: 'Masculino Infantil', description: 'Conforto para os meninos' },
  { id: 'cat_promocao', title: 'Promoção', description: 'Peças com preços especiais' },
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

function buildAdminPdfHeader(phone, customerName, productGroups, totalToSend) {
  const totalPieces = productGroups.reduce((sum, group) => sum + (group.totalPieces || 0), 0);
  const pixTotal = totalToSend * (1 - (HANDOFF_PIX_DISCOUNT_PCT / 100));

  return (
    `📦 *NOVO PEDIDO - Agente Belux*\n` +
    `📱 wa.me/${phone}\n` +
    (customerName ? `👤 *Nome:* ${customerName}\n` : '') +
    `🧾 *Itens:* ${productGroups.length} produtos | ${totalPieces} peças\n` +
    `💰 *Total:* ${woocommerce.formatPrice(totalToSend)}\n` +
    `💸 *PIX (${HANDOFF_PIX_DISCOUNT_PCT}%):* ${woocommerce.formatPrice(pixTotal)}\n\n` +
    `_PDF do pedido abaixo._`
  );
}

async function sendLegacyHandoffToAdmin(adminPhone, phone, session, summaryToSend, itemsToSend) {
  const adminHeader =
    `📦 *NOVO PEDIDO — Agente Belux*\n` +
    `─────────────────\n` +
    `📱 *Lojista:* wa.me/${phone}\n` +
    (session.customerName ? `👤 *Nome:* ${session.customerName}\n` : '') +
    `─────────────────\n` +
    `${summaryToSend}\n\n` +
    `📸 _Enviando fotos dos produtos a seguir..._`;

  const groups = buildProductGroupsFromCart({ items: itemsToSend });

  await zapi.sendText(adminPhone, adminHeader);
  logger.info({ phone, adminPhone }, '[Handoff] Text summary sent to admin');

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const variationsText = g.variations.map(v => {
      const sizeLabel = v.variant ? `${v.variant} - ${v.size}` : v.size;
      return `${sizeLabel} x${v.quantity}`;
    }).join(' · ');
    const caption =
      `📦 *Produto ${i + 1}/${groups.length}*\n` +
      `*${g.productName}*\n` +
      `Tamanhos: ${variationsText}\n` +
      `Total: ${g.totalPieces} ${g.totalPieces === 1 ? 'peça' : 'peças'} — ${woocommerce.formatPrice(g.subtotal)}`;

    if (g.imageUrl) {
      try {
        await zapi.sendImage(adminPhone, g.imageUrl, caption);
        await zapi.delay(400);
      } catch (err) {
        logger.error({ err: err?.message, productId: g.productId }, '[Handoff] Falha ao enviar foto, fallback para texto');
        await zapi.sendText(adminPhone, caption);
      }
    } else {
      await zapi.sendText(adminPhone, caption + '\n⚠️ _Produto sem foto cadastrada._');
    }
  }

  logger.info({ phone, adminPhone, groupCount: groups.length }, '[Handoff] Photos forwarded to admin');
}

async function sendLegacyHandoffToAdmins(phone, session, summaryToSend, itemsToSend) {
  if (!ADMIN_PHONES.length) {
    logger.warn({ phone }, '[Handoff] ADMIN_PHONES not configured — skipping admin notification');
    return;
  }

  for (const adminPhone of ADMIN_PHONES) {
    try {
      await sendLegacyHandoffToAdmin(adminPhone, phone, session, summaryToSend, itemsToSend);
    } catch (err) {
      logger.error({ err: err?.message || String(err), adminPhone }, '[Handoff] Failed to notify admin');
    }
  }
}

/**
 * Envia texto ao cliente. Se TTS estiver ativo, envia também o áudio em paralelo.
 * Mensagens de sistema (emojis, avisos) ou muito curtas não disparam áudio.
 *
 * @param {string} phone 
 * @param {string} text 
 * @param {object} options 
 * @param {boolean} options.tts - Força ativação/desativação (opcional)
 * @param {string} options.replyTo - ID da mensagem para responder (opcional)
 */
async function sendTextWithTTS(phone, text, options = {}) {
  const { tts: forceTTS = null, replyTo = null } = options;
  const useTTS = forceTTS !== null ? forceTTS : TTS_ENABLED;

  if (!text) return;

  // Envia o texto imediatamente
  if (replyTo) {
    await zapi.replyText(phone, text, replyTo);
  } else {
    await zapi.sendText(phone, text);
  }

  // Regras para não poluir com áudios inúteis
  const isSystem = /^[⚠️✅❌🔍📸🗑️🛒📦]/.test(text.trim());
  const isShort = text.trim().length < 5; // Evita "Ok", "Sim", "Não" etc.

  if (useTTS && !isSystem && !isShort) {
    // Processa o áudio em background para não travar a resposta do texto
    logger.info({ phone, textLength: text.length }, '[TTS] Iniciando síntese de voz');
    tts.textToSpeech(text)
      .then(({ buffer, mimeType }) => {
        logger.info({ phone, bufferLength: buffer.length, mimeType }, '[TTS] Áudio recebido, enviando');
        return zapi.sendAudio(phone, buffer, mimeType);
      })
      .then(() => logger.info({ phone }, '[TTS] Áudio enviado com sucesso'))
      .catch(err => logger.error({ phone, err: err.message, stack: err.stack }, '[TTS] Erro ao enviar áudio'));
  }
}

/**
 * Envia um card visual (foto + botão) para cada categoria, seguido de uma
 * lista com ações extras. Usado quando o cliente pede para trocar de linha.
 *
 * Imagens: dinâmicas — primeiro produto de cada categoria via WooCommerce.
 * Se a busca falhar para uma categoria, o card é pulado silenciosamente.
 * IDs dos botões mapeados em CAT_SENTINELS — clicks já funcionam sem alteração.
 */
const SHOWCASE_CATEGORIES = [
  { slug: 'lancamento-da-semana', id: 'CAT_LANCAMENTOS',       label: '🆕 Lançamentos da Semana', desc: 'As novidades mais recentes' },
  { slug: 'feminino',             id: 'CAT_FEMININO',          label: 'Feminino',                 desc: 'Moda íntima feminina adulta' },
  { slug: 'femininoinfantil',     id: 'CAT_FEMININOINFANTIL',  label: 'Feminino Infantil',        desc: 'Conforto para as meninas' },
  { slug: 'masculino',            id: 'CAT_MASCULINO',         label: 'Masculino',                desc: 'Moda íntima masculina adulta' },
  { slug: 'masculinoinfantil',    id: 'CAT_MASCULINOINFANTIL', label: 'Masculino Infantil',       desc: 'Conforto para os meninos' },
  { slug: 'promocao',             id: 'CAT_PROMOCAO',          label: '🏷️ Promoção',              desc: 'Peças com preços especiais' },
];

/**
 * Envia UM único card de categoria (imagem + botão "Ver [categoria]").
 * Reutiliza o visual do showcase, mas para uma categoria específica.
 * Usado no upsell pós-checkout — melhor CTR que mandar várias fotos de produtos.
 */
async function sendCategoryCard(phone, slug) {
  const cat = SHOWCASE_CATEGORIES.find(c => c.slug === slug);
  if (!cat) {
    logger.warn({ slug }, '[CategoryCard] slug não mapeado em SHOWCASE_CATEGORIES');
    return;
  }
  try {
    const result = await woocommerce.getProductsByCategory(cat.slug, 1, 1);
    const imageUrl = result.products?.[0]?.imageUrl || null;
    const buttonList = { buttons: [{ id: cat.id, label: `Ver ${cat.label}` }] };
    if (imageUrl) buttonList.image = imageUrl;
    await zapi.sendButtonList(phone, `*${cat.label}*\n_${cat.desc}_`, cat.label, '', buttonList);
  } catch (err) {
    logger.warn(
      { slug: cat.slug, errMsg: err.message, status: err.response?.status },
      '[CategoryCard] Falha ao enviar card de categoria',
    );
  }
}

async function sendCategoryShowcase(phone, session, opts = {}) {
  const { includeImages = true } = opts;
  for (const cat of SHOWCASE_CATEGORIES) {
    try {
      let imageUrl = null;
      if (includeImages) {
        const result = await woocommerce.getProductsByCategory(cat.slug, 1, 1);
        imageUrl = result.products?.[0]?.imageUrl || null;
      }
      // Não incluir o campo image se for null — Z-API rejeita payloads com null
      const buttonList = { buttons: [{ id: cat.id, label: `Ver ${cat.label}` }] };
      if (imageUrl) buttonList.image = imageUrl;
      await zapi.sendButtonList(
        phone,
        `*${cat.label}*\n_${cat.desc}_`,
        cat.label,
        '',
        buttonList,
      );
      await zapi.delay(500); // 500ms entre cards — sem imagem o flood é menor
    } catch (err) {
      logger.warn(
        { slug: cat.slug, errMsg: err.message, status: err.response?.status, data: err.response?.data },
        '[CategoryShowcase] Falha ao enviar card de categoria',
      );
    }
  }

  // Lista final com ações extras
  const cartCount = session.items?.length || 0;
  const cartDesc = cartCount > 0 ? `${cartCount} item(s) separado(s)` : 'Seu carrinho atual';
  const extraOptions = [
    { id: 'buscar_produto',  title: '🔍 Buscar produto',        description: 'Buscar por referência ou nome' },
    { id: 'cart_view',       title: '🛒 Ver carrinho',          description: cartDesc },
    { id: 'falar_atendente', title: '👩‍💼 Falar com consultora', description: 'Atendimento humano agora' },
  ];
  if (cartCount > 0) {
    // Com carrinho: opção de finalizar
    extraOptions.push({ id: 'cart_finalize', title: '✅ Finalizar Pedido', description: 'Encaminhar para a consultora' });
  } else {
    // Sem carrinho: opção de ver categorias
    extraOptions.push({ id: 'cart_other_category', title: '🗂️ Ver Categorias', description: 'Escolher outra linha' });
  }
  await zapi.sendOptionList(phone, 'Ou escolha uma opção abaixo 👇', 'Mais opções', 'Ver', extraOptions);
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
    // Segundo eixo de variação (ex: Mãe/Filha): preenchido quando produto tem secondaryAttributes
    selectedVariant: null,
    variantAttributeName: null,
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

  if (pf.state === 'awaiting_variant') {
    const variantOptions = product?.secondaryAttributes?.find(a => a.name === pf.variantAttributeName)?.options || [];
    lines.push(`Aguardando escolha de ${pf.variantAttributeName || 'variante'}: ${variantOptions.join(', ')}`);
    lines.push(`→ O cliente precisa escolher a versão antes do tamanho. Quando escolher (ex: "Mãe", "Filha"), emita [VARIANTE:Mãe] ou [VARIANTE:Filha].`);
    lines.push(`→ Se o cliente pediu AS DUAS variantes na mesma mensagem (ex: "M mãe e M filha", "G nas duas"), comprometa-se com a PRIMEIRA ([VARIANTE:Mãe]) — o sistema abre a próxima no turno seguinte. NÃO tente "anotar ambas" sem token, é o bug #Cíntia-2026-04-23.`);
    lines.push(`→ REGRA CRÍTICA: Nunca confirme verbalmente sem emitir token [VARIANTE:X]. Resposta sem token em awaiting_variant é um bug.`);
  }

  if (pf.state === 'awaiting_size' && product?.sizes?.length) {
    const availableSizes = getAvailableSizesForSession(session, product);
    if (pf.selectedVariant) {
      lines.push(`Variante escolhida: ${pf.selectedVariant}`);
    }
    lines.push(`Tamanhos disponíveis: ${availableSizes.map((s, i) => `${i + 1}=${s}`).join(', ')}`);
    lines.push(`→ Se o cliente disser um tamanho ("G", "M", "P" etc.), use [TAMANHO:G]. Se disser o número, use [TAMANHO:2].`);
    lines.push(`→ Se o cliente confirmar tamanho + quantidade juntos pelo contexto (ex: "coloca os 2", "blz 2 do M", "pode colocar 2"), use [COMPRAR_DIRETO size=M qty=2] — productIdx é OPCIONAL quando há produto em foco na FSM.`);
    lines.push(`→ REGRA CRÍTICA: Nunca confirme verbalmente sem emitir token. Se você entendeu o tamanho (mesmo que inferido do histórico), DEVE emitir [TAMANHO:X] ou [COMPRAR_DIRETO size=X qty=N]. Resposta sem token em awaiting_size é um bug.`);
    if (pf.buyQueue?.length > 0) {
      lines.push(`→ Se o cliente quiser ir ao próximo produto / fila (ex: "as outras", "próximo", "outros produtos"), emita [SKIP_MORE].`);
    }
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
    if (pf.buyQueue?.length > 0) {
      lines.push(`→ Se o cliente confirmar (ex: "top", "beleza", "pode", "sim", "tio", "segue", "próximo"), emita [SKIP_MORE] para ir ao próximo produto da fila.`);
    } else {
      lines.push(`→ Se o cliente confirmar que não quer mais tamanhos, emita [HANDOFF] para fechar o pedido.`);
    }
    lines.push(`→ Se quiser outro tamanho, use [TAMANHO:X].`);
  }

  if (pf.buyQueue?.length > 0) {
    const nomes = pf.buyQueue.map(q => q.productName).join(', ');
    lines.push(`Fila de compras pendente (${pf.buyQueue.length}): ${nomes}`);
  }

  if (session.items?.length > 0) {
    // item.price já é unitPrice * quantity (setado em pushCartItem) — não multiplicar novamente
    const cartTotal = session.items.reduce((acc, it) => acc + parseFloat(it.price || 0), 0);
    const cartList = session.items.map((it, i) => {
      const sizeLabel = it.variant ? `${it.variant} - ${it.size}` : it.size;
      return `${i + 1}. ${it.productName} (${sizeLabel}) x${it.quantity}`;
    }).join('; ');
    lines.push(`Carrinho atual (${session.items.length} itens, total ${woocommerce.formatPrice(cartTotal)}): ${cartList}`);
    lines.push(`→ Se o cliente mencionar um número referindo-se a item do carrinho (ex: "dessa 5", "o item 3"), use cartItemIdx nesse número no token COMPRAR_DIRETO.`);
  }

  return lines.join('\n');
}

/**
 * Gera o prompt da "reflection call" — segunda chamada à IA quando ela responde
 * sem emitir o token necessário em estados FSM críticos (awaiting_size / awaiting_quantity).
 *
 * A reflection call é menor e mais focada: não recebe histórico completo,
 * apenas o contexto mínimo para resolver a ambiguidade. Custo baixo, latência baixa.
 *
 * Condição de disparo (no webhook handler):
 *   - FSM em awaiting_size OU awaiting_quantity
 *   - Primeira chamada não produziu token
 *   - Mensagem do usuário tem mais de 2 palavras (evita reflexão desnecessária para "sim", "ok", "2")
 */
function buildReflectionPrompt(userMessage, firstAiResponse, pf) {
  const isVariant = pf.state === 'awaiting_variant';
  const isSize = pf.state === 'awaiting_size';
  const stateLabel = isVariant
    ? `a variante (${pf.variantAttributeName || 'versão'}) de *${pf.productName}*`
    : isSize
      ? `o tamanho de *${pf.productName}*`
      : `a quantidade do tamanho *${pf.selectedSize}* de *${pf.productName}*`;
  const tokenHint = isVariant
    ? 'emita [VARIANTE:X] (ex: [VARIANTE:Mãe] ou [VARIANTE:Filha])'
    : isSize
      ? 'emita [TAMANHO:X] ou [COMPRAR_DIRETO size=X qty=N]'
      : 'emita [QUANTIDADE:N]';

  return `REFLEXÃO NECESSÁRIA — resposta incompleta detectada.

O sistema aguardava: ${stateLabel}.
O cliente disse: "${userMessage}"
Sua resposta anterior: "${firstAiResponse}"

Reinterprete agora:
- Se entendeu o que o cliente quer, ${tokenHint}.
- Se a mensagem é sobre outra coisa (quer trocar de produto, pular, finalizar), use o token adequado (SKIP_MORE, HANDOFF, etc.).
- Se genuinamente ambíguo, faça UMA pergunta curta e direta de esclarecimento.
NÃO repita a resposta anterior. Seja conciso.`;
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

async function handleBelaPauseAdminCommand(adminPhone, text) {
  const command = parseBelaPauseCommand(text);
  if (!command) return false;

  if (!isAdminPhone(adminPhone)) {
    logger.warn({ adminPhone }, '[ManualPause] Comando PAUSAR/ATIVAR BELA ignorado: remetente nao autorizado');
    return false;
  }

  const session = await getSession(command.targetPhone);

  if (command.action === 'pause') {
    if (session.purchaseFlow) {
      session.purchaseFlow.buyQueue = [];
    }
    resetPurchaseFlow(session);
    session.supportMode = 'manual_human_pause';
    session.greetingNotified = true;
    await zapi.sendText(adminPhone, `Bela pausada para wa.me/${command.targetPhone}.`);
    logger.info({ adminPhone, targetPhone: command.targetPhone }, '[ManualPause] Bela pausada por comando da atendente');
  } else {
    clearSupportMode(session, 'manual_bela_resume');
    session.greetingNotified = false;
    await zapi.sendText(adminPhone, `Bela reativada para wa.me/${command.targetPhone}.`);
    logger.info({ adminPhone, targetPhone: command.targetPhone }, '[ManualPause] Bela reativada por comando da atendente');
  }

  persistSession(command.targetPhone);
  return true;
}

async function handleTrackingAdminCommand(adminPhone, text) {
  const command = parseTrackingCommand(text);
  if (!command) return false;

  if (!isAdminPhone(adminPhone)) {
    logger.warn({ adminPhone }, '[TrackingAdmin] Comando ignorado: remetente nao autorizado');
    return false;
  }

  if (command.error === 'invalid_phone') {
    await zapi.sendText(adminPhone, 'Não consegui identificar o telefone do cliente. Use: /rastreio <telefone> <codigo>');
    return true;
  }
  if (command.error === 'invalid_code') {
    await zapi.sendText(adminPhone, 'Código de rastreio parece inválido. Use: /rastreio <telefone> <codigo>');
    return true;
  }

  const message =
    `Olá!\n` +
    `Seu pedido *BELUX MODA INTIMA* acabou de ser enviado! 📦✨\n\n` +
    `Agora é só aguardar que ele está a caminho:\n\n` +
    `🔎 *Código de rastreio:* ${command.trackingCode}\n\n` +
    `Qualquer dúvida, é só chamar.\n` +
    `Até mais!`;

  try {
    await zapi.sendText(command.targetPhone, message);
    await zapi.sendText(
      adminPhone,
      `Rastreio enviado para wa.me/${command.targetPhone} ✅\nCódigo: ${command.trackingCode}`,
    );
    logger.info(
      { adminPhone, targetPhone: command.targetPhone, trackingCode: command.trackingCode },
      '[TrackingAdmin] Rastreio enviado para cliente',
    );
  } catch (err) {
    logger.error(
      { err, adminPhone, targetPhone: command.targetPhone },
      '[TrackingAdmin] Falha ao enviar rastreio',
    );
    await zapi.sendText(
      adminPhone,
      `Não consegui enviar o rastreio para wa.me/${command.targetPhone}. Tente novamente.`,
    );
  }

  return true;
}

async function getSession(phone) {
  if (sessions[phone]) {
    sessions[phone].previousLastActivity = sessions[phone].lastActivity || null;
    sessions[phone].lastActivity = Date.now();
    sessions[phone].greetingNotified = false;
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

    // Verifica se a sessão ficou inativa durante o reinício do servidor.
    // Se sim, zera histórico e memória de conversa — o lojista começa "do zero".
    // Carrinho e produtos navegados são preservados.
    const storedLastActivity = stored?.last_activity ? new Date(stored.last_activity).getTime() : 0;
    const sessionPreDatesRestart = storedLastActivity < SERVER_START_TIME;

    sessions[phone] = stored
      ? {
          history:         sessionPreDatesRestart ? [] : (stored.history || []),
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
          conversationMemory: sessionPreDatesRestart
            ? conversationMemory.createDefaultConversationMemory()
            : (storedConversationMemory || conversationMemory.createDefaultConversationMemory()),
          messageProductMap: stored.message_product_map || {},
          supportMode:     stored.support_mode || null,
          cartNotified:    stored.cart_notified || false,
          greetingNotified: false,
          previousLastActivity: stored.last_activity || null,
          lastActivity:    Date.now(),
          viewedCategories: stored.viewed_categories || [],
          upsellPending:   false,
          upsellSnapshot:  null,
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
          greetingNotified: false,
          previousLastActivity: null,
          lastActivity: Date.now(),
          viewedCategories: [],
          upsellPending:   false,
          upsellSnapshot:  null,
        };
  })();

  sessionLoadLocks.set(phone, loadPromise);
  try {
    await loadPromise;
  } finally {
    sessionLoadLocks.delete(phone);
  }
  // [STUDY] Sessão carregada — contexto de entrada do cliente
  const _s = sessions[phone];
  if (_s) {
    logger.info({
      phone,
      isNew:        !_s.previousLastActivity,
      cartItems:    _s.items?.length        || 0,
      historyLen:   _s.history?.length      || 0,
      customerName: _s.customerName         || null,
      supportMode:  _s.supportMode          || null,
      fsmState:     _s.purchaseFlow?.state  || 'idle',
      sessionAgeMs: _s.previousLastActivity ? Date.now() - _s.previousLastActivity : 0,
    }, '[Session/Load] Sessão carregada');
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
    .catch(err => logger.error({
      err: err.message,
      cause: err.cause?.message,
      code: err.cause?.code,
      details: err.cause?.details,
      hint: err.cause?.hint,
    }, '[Supabase] upsertSession'));

  persistQueues.set(phone, next);
  next.finally(() => {
    if (persistQueues.get(phone) === next) persistQueues.delete(phone);
  });
  return next;
}

// Clean up sessions — arquiva antes de deletar (session_archives + JSONL)
setInterval(async () => {
  const now = Date.now();

  // 1) Memória: arquiva cada sessão expirada antes de apagar
  for (const phone of Object.keys(sessions)) {
    if (now - sessions[phone].lastActivity > SESSION_TIMEOUT_MS) {
      try {
        const result = await archiver.archiveSession(phone, sessions[phone]);
        if (result?.archived) {
          logger.info({ phone, outcome: result.outcome }, '[Archiver] In-memory session archived');
        }
      } catch (err) {
        logger.error({ phone, err: err.message }, '[Archiver] Falha ao arquivar da memória');
      }
      delete sessions[phone];
      logger.info({ phone }, '[Session] Expired');
    }
  }

  // 2) Supabase: lê expiradas, arquiva, depois apaga
  try {
    const expired = await db.getExpiredSessions(SESSION_TIMEOUT_MS);
    for (const row of expired) {
      try {
        await archiver.archiveSupabaseRow(row);
      } catch (err) {
        logger.error({ phone: row.phone, err: err.message }, '[Archiver] Falha ao arquivar do Supabase');
      }
    }
    await db.deleteExpiredSessions(SESSION_TIMEOUT_MS);
  } catch (err) {
    logger.error({ err: err.message }, '[Supabase] archive+delete pipeline');
  }
}, 10 * 60 * 1000);

// ── Cart Recovery (Abandono de Carrinho) ─────────────────────────────────
const CART_ABANDON_MS = 2 * 60 * 60 * 1000; // 2 horas sem interação

setInterval(async () => {
  const now = Date.now();
  for (const [phone, session] of Object.entries(sessions)) {
    if (shouldSkipBotAutomation(session)) continue;
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

// ── Inactivity Greeting (20 minutos sem interação) ────────────────────────
setInterval(async () => {
  const now = Date.now();
  for (const [phone, session] of Object.entries(sessions)) {
    if (shouldSkipBotAutomation(session)) continue;
    if (session.greetingNotified) continue;
    if (now - session.lastActivity < INACTIVITY_GREETING_MS) continue;
    // Não duplicar com cart recovery (tem mensagem própria)
    if (session.cartNotified) continue;

    session.greetingNotified = true;
    try {
      await zapi.sendText(phone,
        'Oi! 😊 Ainda por aqui? Me chama se precisar de ajuda ou quiser continuar vendo os produtos!'
      );
      logger.info({ phone }, '[Inactivity] Saudação enviada após 20min inativo');
    } catch (err) {
      logger.error({ phone, err: err.message }, '[Inactivity] Erro ao enviar saudação');
    }
  }
}, 5 * 60 * 1000); // Verifica a cada 5 minutos

// ── Text Extraction ──────────────────────────────────────────────────────


// ── WooCommerce Webhook (sync em tempo real do catálogo) ─────────────────
// Configurar no WooCommerce: Settings → Advanced → Webhooks →
//   Topic: Product created / updated / deleted
//   Delivery URL: https://<ngrok>/wc-webhook/product
//   Secret: defina WC_WEBHOOK_SECRET no .env
// Opcional — o cron de 1h já captura tudo sem webhook.
let orderGuideImageDataUri = null;

function getOrderGuideImageDataUri() {
  if (!orderGuideImageDataUri) {
    const imageBase64 = fs.readFileSync(ORDER_GUIDE_IMAGE_FILE).toString('base64');
    orderGuideImageDataUri = `data:image/png;base64,${imageBase64}`;
  }
  return orderGuideImageDataUri;
}

app.post('/wc-webhook/product', async (req, res) => {
  res.sendStatus(200); // responde imediatamente (Woo tem timeout baixo)

  try {
    const event = req.headers['x-wc-webhook-event'] || 'updated';
    const result = await catalogSync.handleWebhook({ event, product: req.body });
    logger.info({ event, result }, '[WC Webhook] Processado');
  } catch (err) {
    logger.error({ err: err.message }, '[WC Webhook] Falha ao processar');
  }
});

// ── Webhook ───────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  let from = '';
  try {
    let body = req.body;
    logger.info({ body }, '[Webhook] Evento recebido');
    from = body?.phone || '';
    if (!from) return;
    if (body?.fromMe || body?.isGroup || body?.isStatusReply || body?.broadcast) return;
    if (body?.type === 'DeliveryCallback' || body?.type === 'ReadCallback') return;

    // ── Cancela resumo silencioso agendado (ADR-035) ──────────────────────
    // Cancela o timer SE a nova mensagem é conteúdo não-relacionado a grade.
    // Para mensagens com padrão grade (ex: "3M 2G", "2P", "mãe filha"), o timer
    // é preservado — o interceptor de grade vai chamar scheduleCartSummary e
    // reiniciá-lo, acumulando tudo no mesmo lote silencioso.
    if (from && silentAddDebounce.has(from)) {
      const rawIncoming = body?.image?.caption || body?.text?.message || '';
      const isGradeLike = /\b\d{1,3}\s*(?:[a-zA-ZÀ-ÿ]{0,6}\s*)?(?:mãe|mae|filha|pp|p\b|m\b|g\b|gg\b|xg\b|eg\b|exgg\b)/i.test(rawIncoming);
      if (!isGradeLike) {
        clearTimeout(silentAddDebounce.get(from).timer);
        silentAddDebounce.delete(from);
        logger.debug({ from }, '[SilentAdd] Timer de resumo cancelado — nova interação recebida');
      } else {
        logger.debug({ from, rawIncoming: rawIncoming.slice(0, 60) }, '[SilentAdd] Timer preservado — grade detectada na mensagem entrante (ADR-035)');
      }
    }
    // ────────────────────────────────────────────────────────────────────

    let messageId = body?.messageId;

    // ── Deduplicação de eventos duplicados (ADR-034) ──────────────────────
    // Z-API reenvia webhooks em caso de timeout. Sem isso, a mesma mensagem
    // pode iniciar a sessão duas vezes (race condition com sessionLoadLocks).
    if (messageId) {
      const dedupKey = `${from}:${messageId}`;
      if (SEEN_MESSAGE_IDS.has(dedupKey)) {
        logger.info({ from, messageId }, '[Dedup] Webhook duplicado ignorado');
        return;
      }
      SEEN_MESSAGE_IDS.set(dedupKey, Date.now());
      setTimeout(() => SEEN_MESSAGE_IDS.delete(dedupKey), SEEN_MSG_TTL_MS);
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── FSM Interceptor ───────────────────────────────────────────────────
    const fsmButtonId = body?.buttonsResponseMessage?.buttonId;
    const fsmListId   = body?.listResponseMessage?.selectedRowId;
    const fsmEventId  = fsmButtonId || fsmListId;

    if (fsmEventId && /^(buy_|sizeqty_|size_|qty_|add_size_|skip_more_|skip_product_|confirm_add_|show_qty_|variant_v|queue_continue|queue_finalize_anyway)/.test(fsmEventId)) {
      if (messageId) zapi.readMessage(from, messageId);

      // buy_ events são debounced: acumula cliques por 15s antes de processar.
      // Inclui buy_variant_ (ex: "Mãe"), que também não deve abrir tamanho na hora.
      if (fsmEventId.startsWith('buy_')) {
        logger.info({ from, fsmEventId }, '[BuyDebounce] buy_ interceptado para debounce');
        const session = await getSession(from);
        await addToBuyDebounce(from, fsmEventId, session);
        persistSession(from);
        return;
      }

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
    if (!text) {
      // Foto sem legenda: deixa fluir para o ImageMatch popular session.matchedProducts
      // e/ou setar inlineProduct, para que a próxima mensagem (grade textual) caia no
      // produto certo. Sem isso, "2m" enviado depois cairia no focusedProduct antigo.
      const hasImage = Boolean(body.image?.imageUrl);
      if (!hasImage) {
        logger.warn({ from, bodyKeys: Object.keys(body), hasList: Boolean(body.listResponseMessage), hasBtn: Boolean(body.buttonsResponseMessage) }, '[Webhook] extractTextFromEvent retornou vazio — evento descartado');
        return;
      }
      text = ''; // foto sem caption: segue o fluxo com texto vazio
    }

    if (text === '[Áudio]' || text === '[Sticker]') {
      const mediaSession = await getSession(from);
      if (shouldSkipBotAutomation(mediaSession)) {
        logger.info({ from, supportMode: mediaSession.supportMode }, '[ManualPause] Bot suspenso - midia ignorada');
        persistSession(from);
        return;
      }
    }

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

    if (await handleBelaPauseAdminCommand(from, text)) return;
    if (await handleTrackingAdminCommand(from, text)) return;

    let bufferedMessageIds = null;
    if (shouldDebounceInboundText(body, text)) {
      const buffered = await enqueueInboundTextDebounce(from, body, text);
      if (!buffered) {
        logger.info({ phone: from, text }, '[MSG] Aguardando possivel complemento do cliente');
        if (messageId) zapi.readMessage(from, messageId);
        return;
      }

      body = buffered.body;
      text = buffered.text;
      messageId = buffered.messageId;
      bufferedMessageIds = buffered.messageIds;
      logger.info(
        { phone: from, count: buffered.messages.length, messageIds: buffered.messageIds },
        '[MSG] Rajada de texto agrupada antes da IA'
      );
    }

    logger.info({ phone: from, text }, '[MSG] Received');
    const readMessageIds = bufferedMessageIds || (messageId ? [messageId] : []);
    for (const id of readMessageIds) zapi.readMessage(from, id);

    // ── Per-phone serialization ────────────────────────────────────────────────
    // Serializa processamento por telefone: aguarda qualquer mensagem anterior do
    // mesmo número terminar antes de começar. Previne race conditions quando múltiplas
    // mensagens chegam em <1ms (ex: foto + grade + quote-reply simultâneos).
    {
      const _prev = phoneProcessingQueue.get(from);
      if (_prev) await _prev;
    }
    let _releasePhone;
    const _phoneTask = new Promise(r => (_releasePhone = r));
    phoneProcessingQueue.set(from, _phoneTask);
    try {
    // ──────────────────────────────────────────────────────────────────────────

    // Carrega sessão ANTES do bloco de STT — o log de FSM ativa durante
    // transcrição precisa acessar session.purchaseFlow (ADR-026).
    const session = await getSession(from);

    // ── Image-to-Product (fluxo normal) ───────────────────────────────────────
    // Quando o cliente manda foto + caption (ex: screenshot de um card + grade textual),
    // extractTextFromEvent descarta a imageUrl e retorna só a caption.
    // Sem produto em foco, a IA não sabe o que foi fotografado e pede confirmação.
    // Fix: antes de passar o texto para a IA, tenta identificar o produto pela foto.
    //
    // IMPORTANTE — inlineProduct é variável LOCAL, não escrita em session.currentProduct
    // durante o await de 8s do ImageMatch. Isso previne race condition: outra mensagem
    // simultânea pode escrever session.currentProduct enquanto esta aguarda, e a escrita
    // prematura sobrescreveria o produto correto. O commit para session só ocorre depois
    // que o interceptor de grade ou a IA já processou, confirmando o produto.
    const inlineImageUrl = session.supportMode !== 'fechar_pedido_pending' && !shouldSkipBotAutomation(session)
      ? (body.image?.imageUrl || null)
      : null;
    let inlineProduct = null;
    if (inlineImageUrl) {
      markImageMatchStarted(session);
      const applyNormalImageMatch = async (matchResult) => {
        if (matchResult && !matchResult.uncertain) {
          const loadedProduct = getLoadedProductById(session, matchResult.productId)
            || (await resolveProductById(session, matchResult.productId).catch(() => null));
          if (!loadedProduct) return null;

          logger.info({
            from,
            productId:    loadedProduct.id,
            productName:  loadedProduct.name,
            confidence:   matchResult.confidence,
          }, '[ImageMatch] Produto identificado pela foto — inlineProduct setado localmente');

          // Acumula em session.matchedProducts para suporte a compound em modo
          // normal. Dedup por productId — duas fotos da mesma estampa não viram
          // 2 entradas. Marcamos compoundOrigin='normal' para distinguir do
          // fluxo fechar_pedido_pending (que também usa matchedProducts).
          if (session.supportMode !== 'fechar_pedido_pending') {
            if (!Array.isArray(session.matchedProducts)) session.matchedProducts = [];
            const dup = session.matchedProducts.find((m) => m.productId === loadedProduct.id);
            if (!dup) {
              session.matchedProducts.push({
                productId:      loadedProduct.id,
                name:           loadedProduct.name,
                price:          loadedProduct.salePrice || loadedProduct.price,
                imageUrl:       loadedProduct.imageUrl || null,
                clientImageUrl: inlineImageUrl,
                sizes:          Array.isArray(loadedProduct.sizes) ? loadedProduct.sizes : null,
                attrOptions:    loadedProduct.secondaryAttributes?.[0]?.options || null,
                confidence:     matchResult.confidence,
                caption:        text || null,
                _captionTs:     text ? Date.now() : null,
                compoundOrigin: 'normal',
                firstSeenAt:    Date.now(),
              });
              persistSession(from);
              const detectedAfterMatch = detectCompoundCase(session);
              if (detectedAfterMatch) {
                logger.info(
                  { from, spec: detectedAfterMatch.spec, matchedCount: session.matchedProducts.length },
                  '[Compound] Caso composto detectado após ImageMatch — agendando confirmação'
                );
                scheduleNormalCompoundCheck(from, session);
              }
            }
          }

          return loadedProduct;
        }

        if (matchResult) {
          logger.info({
            from,
            productId:  matchResult.productId,
            confidence: matchResult.confidence,
          }, '[ImageMatch] Foto identificada com incerteza — não setando inlineProduct');
        } else {
          logger.info({ from }, '[ImageMatch] Foto não reconhecida — seguindo sem produto em foco');
        }
        return null;
      };

      const matchPromise = imageMatcher
        .matchProductFromImage(inlineImageUrl, { minConfidence: 0.65, topK: 5 })
        .then(applyNormalImageMatch)
        .catch((err) => {
          logger.warn({ from, err: err?.message }, '[ImageMatch] Falha no matching — continuando sem produto');
          return null;
        })
        .finally(() => markImageMatchFinished(session));
      inlineProduct = await Promise.race([
        matchPromise,
        new Promise(resolve => setTimeout(() => resolve(null), 8000)),
      ]);
    }
    // ── fim Image-to-Product ──────────────────────────────────────────────────

    // ── Compound em modo normal (ver lançamento, catálogo) ───────────────────
    // Se há 2+ produtos identificados via foto recentemente (dentro de 8s) e
    // o texto atual carrega "N de cada estampa / M de cada tamanho", desvia
    // para o fluxo composto da Bela. Caso contrário, segue o fluxo legacy
    // inlineProduct (parseGradeText simples).
    if (session.supportMode !== 'fechar_pedido_pending') {
      const matchedAll = Array.isArray(session.matchedProducts) ? session.matchedProducts : [];
      const now = Date.now();
      // Limpa entradas antigas (fora da janela)
      const fresh = matchedAll.filter(
        (m) => m.compoundOrigin === 'normal' &&
               m.firstSeenAt && (now - m.firstSeenAt) <= NORMAL_COMPOUND_WINDOW_MS
      );
      // Se há entradas antigas sobrando, descarta-as do buffer (preserva freshs)
      if (fresh.length !== matchedAll.length) {
        const others = matchedAll.filter((m) => m.compoundOrigin !== 'normal' || fresh.includes(m));
        session.matchedProducts = others;
      }

      if (fresh.length >= 2) {
        const currentSpec = text ? parseCompoundSpec(text) : null;
        const detected = currentSpec ? { spec: currentSpec, sourceText: text } : detectCompoundCase(session);
        if (detected) {
          // Garante que o text atual entra no pool pra detectCompoundCase
          if (currentSpec && text) {
            if (!Array.isArray(session.pendingSizeTexts)) session.pendingSizeTexts = [];
            const already = session.pendingSizeTexts.some((t) => t.text === text);
            if (!already) session.pendingSizeTexts.push({ text, ts: now });
          }
          logger.info(
            { from, freshCount: fresh.length, spec: detected.spec },
            '[Compound] Caso composto detectado em modo normal — agendando confirmação'
          );
          scheduleNormalCompoundCheck(from, session);
          persistSession(from);
          return;
        }
      }
    }
    // ── fim Compound modo normal ──────────────────────────────────────────────

    // ── Grade via foto (inlineProduct) ────────────────────────────────────────
    // Quando o ImageMatch identificou o produto da foto E o caption é uma grade,
    // processa deterministicamente sem depender do estado FSM (que pode estar sujo
    // por race condition quando múltiplas mensagens chegam simultaneamente).
    // Suporta produtos com variante (mãe+filha) via parseMultiVariantGrade.
    if (inlineProduct && text) {
      const pfInline = session.purchaseFlow;
      const isFsmOnDifferentProduct = pfInline?.state !== 'idle' && String(pfInline?.productId) !== String(inlineProduct.id);

      // Enriquece produto com dados de estoque antes de parsear a grade
      const enrichedInline = await ensureProductStockData(inlineProduct);
      const secAttrInline   = enrichedInline?.secondaryAttributes?.[0];
      const rawSizesInline  = (enrichedInline?.sizes || []).filter(Boolean);
      const sizesForGrade   = rawSizesInline.length > 0
        ? buildSessionSizeDetails(session, enrichedInline).map(d => d.size)
        : ['ÚNICO'];

      let gradeInterceptedByPhoto = false;

      // ── Multi-variante (ex: "3M mãe 2G filha") ──────────────────────────
      if (secAttrInline?.options?.length > 1) {
        const multiPairsInline = parseMultiVariantGrade(text, secAttrInline.options, sizesForGrade);
        if (multiPairsInline?.length > 0) {
          // Se FSM está em outro produto, enfileira o atual antes de trocar foco
          if (isFsmOnDifferentProduct) {
            const { contextMessage: switchMsg } = switchFsmFocus(session, enrichedInline);
            if (switchMsg) {
              appendHistory(session, 'assistant', switchMsg);
              conversationMemory.refreshConversationMemory(session, { assistantText: switchMsg });
            }
          }

          appendHistory(session, 'user', text);
          conversationMemory.refreshConversationMemory(session, { userText: text });
          const pf2 = session.purchaseFlow;
          const unitPrice2 = parseFloat(enrichedInline.salePrice || enrichedInline.price) || 0;
          pf2.productId   = enrichedInline.id;
          pf2.productName = enrichedInline.name;
          pf2.unitPrice   = unitPrice2;

          const addedMV = [], outOfStockMV = [], outOfStockCtx = [];
          for (const { variant, grade: varGrade } of multiPairsInline) {
            pf2.selectedVariant = variant;
            const enrichedV = await ensureProductStockData(enrichedInline, getVariantFilter(session));
            const availSizesV = getAvailableSizesForSession(session, enrichedV || enrichedInline);
            for (const { size, qty } of varGrade) {
              const matched = availSizesV.find(s => normalizeSizeValue(s) === normalizeSizeValue(size));
              if (matched) {
                pushCartItem(session, pf2.productId, pf2.productName, matched, qty, unitPrice2, enrichedInline.imageUrl || null, variant);
                addedMV.push(`${variant} ${matched} x${qty}`);
              } else {
                outOfStockMV.push(`${variant} ${size}`);
                outOfStockCtx.push({ variant, size, qty });
              }
            }
          }
          logger.info({ from, product: enrichedInline.name, added: addedMV, outOfStock: outOfStockMV }, '[Grade] Multi-variante via foto (inlineProduct)');
          if (messageId && addedMV.length > 0) zapi.sendReaction(from, messageId, '✅').catch(() => {});
          pf2.state = 'awaiting_more_sizes';
          pf2.lastCommitSource = 'text';
          session.currentProduct = enrichedInline;
          if (outOfStockMV.length > 0) {
            pf2._pendingOosFallback = { outOfStock: outOfStockCtx, productId: enrichedInline.id };
            const oosReply = await zapi.replyText(from, `⚠️ Sem estoque: ${outOfStockMV.join(', ')}`, messageId);
            const oosZaapId = oosReply?.data?.zaapId;
            if (oosZaapId) registerMessageProduct(session, oosZaapId, null, enrichedInline);
          }
          session.consecutiveFailures = 0; // sucesso determinístico via foto+grade
          scheduleCartSummary(from);
          persistSession(from);
          return;
        }
      }

      // ── Grade simples (ex: "2P", "3M 1G") ───────────────────────────────
      if (!gradeInterceptedByPhoto) {
        const gradeInline = parseGradeText(text, sizesForGrade);
        if (gradeInline?.length > 0) {
          // Se FSM está em outro produto, enfileira o atual antes de trocar foco
          if (isFsmOnDifferentProduct) {
            const { contextMessage: switchMsg } = switchFsmFocus(session, enrichedInline);
            if (switchMsg) {
              appendHistory(session, 'assistant', switchMsg);
              conversationMemory.refreshConversationMemory(session, { assistantText: switchMsg });
            }
          }

          appendHistory(session, 'user', text);
          conversationMemory.refreshConversationMemory(session, { userText: text });
          const pf3 = session.purchaseFlow;
          const unitPrice3 = parseFloat(enrichedInline.salePrice || enrichedInline.price) || 0;
          pf3.productId   = enrichedInline.id;
          pf3.productName = enrichedInline.name;
          pf3.unitPrice   = unitPrice3;

          const addable3 = [], unavailable3 = [];
          for (const { size, qty } of gradeInline) {
            const matched = sizesForGrade.find(s => normalizeSizeValue(s) === normalizeSizeValue(size));
            if (!matched) continue;
            const avail = getSizeAvailability(session, enrichedInline, matched);
            if (avail?.isAvailable === false) {
              unavailable3.push({ size: matched, qty, available: avail.availableQuantity || 0 });
            } else {
              addable3.push({ size: matched, qty });
            }
          }

          if (addable3.length > 0 || unavailable3.length > 0) {
            const added3 = [];
            for (const { size, qty } of addable3) {
              pushCartItem(session, enrichedInline.id, enrichedInline.name, size, qty, unitPrice3, enrichedInline.imageUrl || null, null);
              added3.push({ size, qty });
            }
            logger.info({ from, product: enrichedInline.name, added: added3, unavailable: unavailable3 }, '[Grade] Grade simples via foto (inlineProduct)');
            if (messageId && added3.length > 0) zapi.sendReaction(from, messageId, '✅').catch(() => {});
            pf3.state = added3.length > 0 ? 'awaiting_more_sizes' : 'awaiting_size';
            pf3.lastCommitSource = 'text';
            session.currentProduct = enrichedInline;
            if (unavailable3.length > 0) {
              const lines = unavailable3.map(({ size, available }) =>
                available > 0 ? `• ${size}: só tem ${available} disponível` : `• ${size}: indisponível no momento`
              ).join('\n');
              await zapi.replyText(from, `⚠️ Não consegui incluir:\n${lines}`, messageId);
            }
            session.consecutiveFailures = 0; // sucesso determinístico via foto+grade
            scheduleCartSummary(from);
            persistSession(from);
            return;
          }
        }
      }

      // Foto identificada mas caption NÃO é grade → commit inlineProduct para que
      // a IA tenha o produto correto no contexto (ex: "qual o preço desse?")
      session.currentProduct = enrichedInline;
      logger.info({ from, productId: enrichedInline.id }, '[ImageMatch] Commit de inlineProduct para session (caption não é grade)');
    }
    // ── fim Grade via foto ────────────────────────────────────────────────────

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

    if (shouldSkipBotAutomation(session)) {
      const pausedAnalysis = semantic.analyzeUserMessage(text);
      if (isHumanPauseResumeIntent(pausedAnalysis, text)) {
        logger.info({ from, supportMode: session.supportMode }, '[ManualPause] Cliente demonstrou interesse comercial - reativando bot');
        clearSupportMode(session, 'customer_resume_intent');
      } else {
        logger.info({ from, supportMode: session.supportMode }, '[ManualPause] Bot suspenso - webhook ignorado');
        persistSession(from);
        return;
      }
    }

    const inactivityMs = session.previousLastActivity
      ? Date.now() - session.previousLastActivity
      : 0;

    // ── Gate de Entrada — exibido antes de qualquer interação para clientes novos ──
    // Clientes com histórico vazio e carrinho vazio devem escolher entre catálogo e vendedora.
    // Retorna ao fluxo normal apenas quando selecionam o catálogo (gate_catalog / "1").
    {
      const isNewClient = session.history.length === 0 && !(session.items?.length > 0) && (session.purchaseFlow?.state === 'idle' || !session.purchaseFlow?.state);
      if (isNewClient) {
        const isGateCatalog    = text === 'gate_catalog' || text.trim() === '1';
        const isGateSeller     = text === 'gate_seller'  || text.trim() === '2';
        const isGateFecharPed  = text === 'BTN_FECHAR_PEDIDO';

        if (isGateSeller) {
          logger.info({ from }, '[Gate] Cliente escolheu resolver problema — handoff humano');
          await handoffToHuman(from, session);
          persistSession(from);
          return;
        }

        if (isGateFecharPed) {
          // Cai fora do gate diretamente no interceptor BTN_FECHAR_PEDIDO abaixo
          logger.info({ from }, '[Gate] Cliente escolheu fechar pedido — passando para interceptor');
          // Não retorna — deixa cair no interceptor BTN_FECHAR_PEDIDO mais abaixo
        } else if (!isGateCatalog) {
          logger.info({ from, text: text.slice(0, 50) }, '[Gate] Enviando menu inicial de escolha');
          try {
            await zapi.sendInitialGate(from);
          } catch (err) {
            logger.error({ from, err: err.message }, '[Gate] sendInitialGate falhou — enviando texto simples');
            await zapi.sendText(from, 'Olá! Sou a *Bela*, consultora da *Belux Moda Íntima* 👋\n\nO que você prefere?\n\n📦 *Fechar meu pedido*\n🆕 *Ver lançamentos*\n❓ *Dúvidas*');
          }
          persistSession(from);
          return;
        } else {
          // isGateCatalog = true → continua fluxo normal (isFirstContact → boas-vindas + catálogo)
          logger.info({ from }, '[Gate] Cliente escolheu lançamentos — prosseguindo com boas-vindas');
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Rotas determinísticas de carrinho
    if (text === 'CART_VIEW') {
      logger.info({ from }, '[Intercept] Visualização de carrinho');
      await showCart(from, session);
      persistSession(from);
      return;
    }

    // Botão "Buscar produto" do sendCategoryShowcase — orienta o cliente a digitar
    if (text === 'BUSCAR_PRODUTO_MENU') {
      logger.info({ from }, '[Intercept] Buscar produto via showcase de categorias');
      await zapi.sendText(from, '🔍 Me diz a referência ou o nome do produto que você quer! (Ex: "615S", "pijama infantil")');
      persistSession(from);
      return;
    }

    if (text === 'CART_REMOVE_ITEM') {
      logger.info({ from }, '[Intercept] Remoção de item solicitada');
      if (!session.items || session.items.length === 0) {
        await zapi.sendText(from, '🛒 Seu carrinho está vazio, não há nada para remover 😊');
      } else {
        const { summary } = buildCartSummary(session, '🗑️ *REMOVER ITEM*');
        await zapi.sendText(from, `${summary}\n\nQual item quer remover? *Digite o número* (ex: "remover 1")`);
      }
      persistSession(from);
      return;
    }

    if (text === 'CART_FINALIZE') {
      logger.info({ from }, '[Intercept] Finalização de carrinho determinística');
      // Se upsell está pendente: cliente quer fechar agora → cancela timer e executa imediato
      if (session.upsellPending) {
        logger.info({ from }, '[UpsellHandoff] Cliente confirmou durante upsell — handoff imediato');
        const existing = upsellHandoffTimers.get(from);
        if (existing?.timer) clearTimeout(existing.timer);
        upsellHandoffTimers.delete(from);
        await executeHandoff(from, session);
        persistSession(from);
        return;
      }
      const intercepted = await handleQueueGuard(from, 'cart_finalize', session);
      if (!intercepted) {
        await handoffToConsultant(from, session);
      }
      persistSession(from);
      return;
    }

    if (text === 'FALAR_ATENDENTE') {
      logger.info({ from, trigger: 'BOTAO_FALAR_ATENDENTE', fsmState: session.purchaseFlow?.state || 'idle', cartItems: session.items?.length || 0 }, '[Intercept] Encaminhamento humano determinístico');
      await handoffToHuman(from, session);
      persistSession(from);
      return;
    }

    if (text === 'BTN_FECHAR_PEDIDO') {
      logger.info({ from }, '[Intercept] Botão "Fechar Pedido" — modo fotos/tamanho');
      session.supportMode = 'fechar_pedido_pending';
      session.fecharPedidoRelayBuffer = [];
      session.fecharPedidoEmptyPromptSentAt = null;
      // Captura nome do contato do próprio webhook
      const waName = body.senderName || body.chatName || null;
      if (waName && !session.customerName) session.customerName = waName;
      const pedidoMsg = 'Ótimo! 📦 Me envie as *fotos* dos produtos que deseja, e para cada uma me diga o *tamanho* e a *quantidade*. Pode mandar tudo em sequência! 😊\n\n_Quando terminar de enviar, é só parar de digitar — vou chamar a consultora automaticamente._';
      const orderGuideCaption = 'Guia rapidinho: peça assim — produto + tamanho + quantidade 💕';
      try {
        const orderGuideImage = getOrderGuideImageDataUri();
        await zapi.sendImage(from, orderGuideImage, orderGuideCaption);
        await zapi.delay(300);
      } catch (err) {
        logger.warn({ from, err: err?.message }, '[FecharPedido] Falha ao enviar guia educativo');
      }

      const assistantGuideText = `${orderGuideCaption}\n${pedidoMsg}`;
      appendHistory(session, 'assistant', assistantGuideText);
      conversationMemory.refreshConversationMemory(session, { assistantText: assistantGuideText });
      await zapi.sendText(from, pedidoMsg);
      scheduleFecharPedidoHandoff(from, session);
      persistSession(from);
      return;
    }

    // Sprint 1 — Interceptor global: limpeza de carrinho com linguagem natural
    const semanticQuick = semantic.analyzeUserMessage(text);
    // [STUDY] Intenções detectadas pelo analisador semântico
    logger.info({
      from,
      text: text.slice(0, 100),
      intent: {
        wantsHuman:    semanticQuick.wantsHuman    || false,
        wantsCheckout: semanticQuick.wantsCheckout || false,
        wantsClearCart:semanticQuick.wantsClearCart|| false,
        wantsCart:     semanticQuick.wantsCart     || false,
        slangOrNoisy:  semanticQuick.slangOrNoisy  || false,
        categories:    semanticQuick.categories    || [],
      },
    }, '[Semantic] Intenção detectada');
    if (semanticQuick.wantsClearCart) {
      logger.info({ from, text: text.slice(0, 80) }, '[Intercept] Limpeza de carrinho via semântica');
      await clearCart(from, session);
      persistSession(from);
      return;
    }

    // Sprint 1 — Interceptor global: handoff humano com linguagem natural
    if (semanticQuick.wantsHuman) {
      logger.info({ from, text: text.slice(0, 80), trigger: 'SEMANTICA_WANTS_HUMAN', fsmState: session.purchaseFlow?.state || 'idle', cartItems: session.items?.length || 0 }, '[Intercept] Handoff humano via semântica');
      await handoffToHuman(from, session);
      persistSession(from);
      return;
    }

    // [ADR-035] Interceptor: "próximo"/"avança" digitado durante fila ativa → avança sem IA.
    // O skip_more_v... só captura cliques em option list; texto digitado cai na IA que
    // confunde "Próximo" com PROXIMOS (navegação de catálogo) e devolve "Todos os produtos...".
    {
      const pfNext = session.purchaseFlow;
      const hasQueueNext = (pfNext?.buyQueue?.length || 0) > 0;
      const isInBuyingModeNext = pfNext?.state === 'awaiting_more_sizes' || pfNext?.state === 'awaiting_size' || pfNext?.state === 'awaiting_variant';
      const isNextCmd = /^(pr[oó]ximo|pr[oó]xima|avan[cç]a|avan[cç]ar|seguir|next|pula|pular|pr[oó]ximo produto|pr[oó]x)\.?$/i.test(text.trim());
      if (isNextCmd && hasQueueNext && isInBuyingModeNext) {
        logger.info({ from, text: text.slice(0, 40) }, '[Intercept] "Próximo" digitado durante fila → processNextInQueue (ADR-035)');
        await processNextInQueue(from, session, messageId);
        persistSession(from);
        return;
      }
    }

    // Interceptor global: pedido de ajuda / confusão — FSM deve estar idle
    // Garante que lojistas sem experiência com bots recebam orientação clara
    // e sempre tenham a opção de falar com consultora humana.
    const WANTS_HELP = /\b(ajuda|help|como funciona|como compro|n[aã]o entend|o que (eu )?fa[cç]o|como (eu )?fa[cç]o|por onde come[cç]|n[aã]o sei (o que|como)|me explica)\b/i.test(text);
    if (WANTS_HELP && (session.purchaseFlow?.state || 'idle') === 'idle') {
      logger.info({ from, text: text.slice(0, 80) }, '[Intercept] Pedido de ajuda — enviando mini-guia');
      const helpMsg = `Claro! 😊 É bem simples — e você pode fazer tudo por texto ou áudio, sem precisar de botão:

*1.* Veja os produtos com foto e preço
*2.* Quando gostar de algum, *deslize a foto e me envie* o tamanho e a quantidade — ou clique em *Separar Tamanho* embaixo, ou mande um *áudio* 🎙️
*3.* Tamanho: ex: _"M"_, _"G"_ ou vários: _"2P 1M"_
*4.* Quantidade: ex: _"3 peças"_
*5.* Nossa *consultora humana* confirma pagamento e entrega 👩‍💼

_Prefere falar com a consultora agora? É só me dizer "falar com consultora"_ 😊`;
      appendHistory(session, 'user', text);
      appendHistory(session, 'assistant', helpMsg);
      conversationMemory.refreshConversationMemory(session, { userText: text, assistantText: helpMsg });
      await zapi.sendText(from, helpMsg);
      await sendCategoryMenu(from, 'Por qual linha você quer começar?');
      persistSession(from);
      return;
    }

    // Interceptor global: "deu quanto?" / "qual o total?" / "ver carrinho" — determinístico.
    // Sem isso, perguntas simples sobre total caem na IA, que pode falhar e
    // disparar auto-escalação (consecutiveFailures >= 2 → handoffToHuman).
    // wantsCart já tem regex pra "deu quanto", "quanto ficou/tá/é/foi", etc.
    if (semanticQuick.wantsCart && !semanticQuick.wantsCheckout && session.items?.length > 0) {
      logger.info({ from, text: text.slice(0, 80), cartItems: session.items.length }, '[Intercept] Pergunta sobre carrinho/total via semântica');
      appendHistory(session, 'user', text);
      conversationMemory.refreshConversationMemory(session, { userText: text });
      session.consecutiveFailures = 0; // sucesso determinístico — reseta ruído
      await showCart(from, session);
      persistSession(from);
      return;
    }

    // Interceptor global: "Finalizar pedido" por TEXTO — não depende da IA.
    // Sem isso, se Gemini crashar durante checkout o cliente fica preso no loop
    // "Poxa, tive um pequeno problema aqui" sem nunca disparar o handoff.
    if (semanticQuick.wantsCheckout && session.items?.length > 0) {
      logger.info({ from, text: text.slice(0, 80), cartItems: session.items.length }, '[Intercept] Finalização de pedido via semântica');
      appendHistory(session, 'user', text);
      conversationMemory.refreshConversationMemory(session, { userText: text });
      // Se upsell está pendente: cliente insiste em fechar → cancela timer e executa imediato
      if (session.upsellPending) {
        logger.info({ from }, '[UpsellHandoff] Cliente insistiu em fechar durante upsell — handoff imediato');
        const existing = upsellHandoffTimers.get(from);
        if (existing?.timer) clearTimeout(existing.timer);
        upsellHandoffTimers.delete(from);
        await executeHandoff(from, session);
        persistSession(from);
        return;
      }
      const intercepted = await handleQueueGuard(from, 'cart_finalize', session);
      if (!intercepted) {
        await handoffToConsultant(from, session);
      }
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

    // ── Interceptor: confirmação de grade composta ─────────────────────────
    // Quando a Bela mandou "Fechou? Só falar sim" com [awaitingCompoundConfirmation],
    // a resposta textual do cliente é processada DETERMINISTICAMENTE — sem IA —
    // para executar o pushCartItem em lote. Evita a IA reinterpretar "sim" como
    // algo diferente e perder o plano que já foi mostrado ao cliente.
    if (session.awaitingCompoundConfirmation) {
      const ttlExpired = !session.compoundConfirmationExpiresAt ||
                         Date.now() > session.compoundConfirmationExpiresAt;
      if (ttlExpired) {
        logger.info({ from }, '[Compound] TTL de confirmação expirado — limpando estado');
        clearCompoundState(session);
      } else {
        const reply = classifyCompoundReply(text);
        logger.info({ from, reply, text: text.slice(0, 60) }, '[Compound] Classificando resposta do cliente');

        if (reply === 'accept') {
          const plan = session.pendingCompoundGrade;
          const matched = session.matchedProducts || [];

          if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) {
            logger.warn({ from }, '[Compound] accept sem plano salvo — fallback handoff');
            clearCompoundState(session);
            await handoffToConsultant(from, session).catch(() => {});
            persistSession(from);
            return;
          }

          // Garante que purchaseFlow existe — pushCartItem depende de addedSizes
          if (!session.purchaseFlow) {
            session.purchaseFlow = { state: 'idle', addedSizes: [], buyQueue: [] };
          } else if (!Array.isArray(session.purchaseFlow.addedSizes)) {
            session.purchaseFlow.addedSizes = [];
          }
          if (!Array.isArray(session.items)) session.items = [];

          let pushedItems = 0;
          let pushedPieces = 0;
          for (const item of plan.items) {
            const matchMeta = matched.find(m => m.productId === item.productId);
            const unitPrice = parseFloat(matchMeta?.price) || 0;
            const imageUrl = matchMeta?.imageUrl || null;
            for (const { size, qty, variant } of item.grade) {
              if (!size || !qty || qty < 1) continue;
              pushCartItem(session, item.productId, item.name, size, qty, unitPrice, imageUrl, variant || null);
              pushedItems += 1;
              pushedPieces += qty;
            }
          }

          // Limpa buffers do modo fechar_pedido (ADR-044) e estado composto
          session.matchedProducts = [];
          session.pendingSizeTexts = [];
          session.fecharPedidoRelayBuffer = [];
          if (session.supportMode === 'fechar_pedido_pending') {
            const existingHandoff = fecharPedidoInactivityTimers.get(from);
            if (existingHandoff) {
              clearTimeout(existingHandoff);
              fecharPedidoInactivityTimers.delete(from);
            }
            session.supportMode = null;
          }
          clearCompoundState(session);

          // Em modo normal, garante que FSM está em awaiting_more_sizes para
          // scheduleCartSummary disparar corretamente. switchFsmFocus pode ter
          // deixado a FSM em awaiting_variant (mãe e filha) que é ignorado pelo timer.
          if (session.supportMode !== 'fechar_pedido_pending' && session.purchaseFlow) {
            const pfC = session.purchaseFlow;
            if (pfC.state !== 'awaiting_size' && pfC.state !== 'awaiting_more_sizes') {
              pfC.state = 'awaiting_more_sizes';
            }
            pfC.selectedVariant = null;
            pfC.selectedSize = null;
          }

          logger.info(
            { from, pushedItems, pushedPieces, cartLineItems: session.items.length },
            '[Compound] Grade confirmada — itens adicionados ao carrinho'
          );

          appendHistory(session, 'user', text);
          const ack = `Fechou ✅ Adicionei ${pushedPieces} peças no carrinho (${pushedItems} linhas).\n\nJá mando o resumo em instantes pra você conferir 😊`;
          appendHistory(session, 'assistant', ack);
          await zapi.sendText(from, ack);
          session.consecutiveFailures = 0; // sucesso determinístico via compound
          scheduleCartSummary(from);
          persistSession(from);
          return;
        }

        if (reply === 'reject' || reply === 'correct') {
          logger.info({ from, reply }, '[Compound] Cliente rejeitou ou corrigiu — limpando estado composto');
          clearCompoundState(session);
          // Limpa buffer compound do modo normal pra não re-disparar na próxima
          // mensagem. Em fechar_pedido_pending, matchedProducts é input pra
          // vendedora, então preserva.
          if (Array.isArray(session.matchedProducts) && session.supportMode !== 'fechar_pedido_pending') {
            session.matchedProducts = session.matchedProducts.filter((m) => m.compoundOrigin !== 'normal');
          }
          // Não faz return — deixa o fluxo normal (IA ou fechar_pedido) re-parsear a mensagem
        }
        // Se 'unclear': também deixa cair no fluxo normal para IA responder naturalmente
      }
    }

    // Relay mode: encaminha cada mensagem IMEDIATAMENTE para a vendedora (URLs frescas)
    if (session.supportMode === 'fechar_pedido_pending') {
      if (!session.fecharPedidoPhotoMap) session.fecharPedidoPhotoMap = {};

      const waName = body.senderName || body.chatName || null;
      if (waName && !session.customerName) session.customerName = waName;

      const imageUrl = body.image?.imageUrl || null;
      const caption  = body.image?.caption  || null;
      const audioUrl = body.audio?.audioUrl || null;
      const msgId    = body.messageId;
      const refMsgId = body.referenceMessageId || body?.quotedMessage?.messageId || null;

      // Guarda foto recebida para resolver replies futuros
      if (imageUrl && msgId) session.fecharPedidoPhotoMap[msgId] = imageUrl;

      // Se é reply a uma foto anterior, tenta resolver a URL da foto citada
      let quotedImageUrl = null;
      if (refMsgId && !imageUrl) {
        quotedImageUrl = session.fecharPedidoPhotoMap[refMsgId] || null;
        if (!quotedImageUrl && session.messageProductMap?.[refMsgId]?.imageUrl) {
          quotedImageUrl = session.messageProductMap[refMsgId].imageUrl;
        }
        if (!quotedImageUrl) {
          try {
            const fetched = await zapi.getMessageById(refMsgId);
            quotedImageUrl = fetched?.image?.imageUrl
              || fetched?.imageMessage?.url
              || fetched?.message?.imageMessage?.url
              || null;
          } catch (err) {
            logger.warn({ refMsgId, err: err.message }, '[FecharPedido] getMessageById falhou');
          }
        }
      }

      // === Image matching: tenta identificar o produto da foto no catálogo ===
      // Roda em paralelo ao relay para não atrasar o encaminhamento à vendedora.
      // Resultado acumulado em session.matchedProducts; mostrado no FIM DO ENVIO.
      //
      // Padrão da cliente: foto → texto separado (tamanho/qtd) OU foto → reply
      // na mesma foto com texto (tamanho/qtd). Ambos devem virar caption do
      // match correspondente. Usamos uma fila FIFO (pendingSizeTexts) para o
      // caso 1; para o caso 2, resolvemos pelo refMsgId → matched direto.
      if (!session.matchedProducts)    session.matchedProducts    = [];
      if (!session.pendingSizeTexts)   session.pendingSizeTexts   = [];

      const now = Date.now();
      const SPLIT_GRADE_WINDOW_MS = 8000;
      const isReplyWithText = !imageUrl && !!quotedImageUrl && !!text &&
        text !== '[Sticker]' && text !== '[Áudio_STT]' && text !== '[Áudio]';

      if (imageUrl) {
        // Foto nova recebida: dispara match async. Caption inline tem prioridade;
        // senão consome topo da fila FIFO de textos puros pendentes.
        const inlineCaption = caption || null;
        const sourceMessageId = msgId;
        markImageMatchStarted(session);
        imageMatcher.matchProductFromImage(imageUrl, { minConfidence: 0.65, topK: 10 })
          .then((match) => {
            if (!match) {
              logger.info({ from }, '[FecharPedido] Nenhum match retornado (catálogo vazio?)');
              return;
            }
            // Caption: prioridade → inline > reply pendente > fila FIFO
            const pendingReply = session.pendingSizeTexts.findIndex(
              (t) => t.refMsgId === sourceMessageId,
            );
            let sizeCaption = inlineCaption;
            if (!sizeCaption && pendingReply !== -1) {
              sizeCaption = session.pendingSizeTexts.splice(pendingReply, 1)[0].text;
            }
            if (!sizeCaption) {
              // Fila FIFO tradicional: só itens sem refMsgId
              const idx = session.pendingSizeTexts.findIndex((t) => !t.refMsgId);
              if (idx !== -1) sizeCaption = session.pendingSizeTexts.splice(idx, 1)[0].text;
            }
            const isDuplicate = session.matchedProducts.find(
              (m) => m.productId === match.productId && m.caption === sizeCaption,
            );
            if (!isDuplicate) {
              session.matchedProducts.push({
                productId:       match.productId,
                name:             match.name,
                price:            match.price,
                imageUrl:         match.imageUrl || null,
                clientImageUrl:   imageUrl, // foto original enviada pelo cliente (para replay multimodal na Bela)
                sizes:            Array.isArray(match.sizes) ? match.sizes : null,
                confidence:       match.confidence,
                uncertain:        !!match.uncertain,
                caption:          sizeCaption || null,
                _captionTs:       sizeCaption ? Date.now() : null,
                sourceMessageId,
              });
              logger.info(
                { from, productId: match.productId, caption: sizeCaption, uncertain: !!match.uncertain, confidence: match.confidence },
                match.uncertain ? '[FecharPedido] Produto identificado como INCERTO (revisar)' : '[FecharPedido] Produto identificado',
              );
              persistSession(from);
              const detectedAfterMatch = detectCompoundCase(session);
              if (detectedAfterMatch) {
                const existingHandoff = fecharPedidoInactivityTimers.get(from);
                if (existingHandoff) {
                  clearTimeout(existingHandoff);
                  fecharPedidoInactivityTimers.delete(from);
                }
                logger.info(
                  { from, spec: detectedAfterMatch.spec, matchedCount: session.matchedProducts.length },
                  '[Compound] Caso composto detectado após ImageMatch — desviando para Bela'
                );
                schedulePendingCompoundConfirmation(from, session);
              }
            }
          })
          .catch((err) => {
            logger.warn({ from, err: err.message }, '[FecharPedido] Falha no image matching');
          })
          .finally(() => {
            markImageMatchFinished(session);
            persistSession(from);
          });
      } else if (isReplyWithText) {
        // Reply numa foto anterior com texto de grade → NÃO redispara match da
        // foto antiga. Tenta casar com um matched já resolvido (por sourceMessageId);
        // se o match ainda estiver pendente, enfileira com refMsgId para o .then()
        // do match consumir quando resolver.
        const target = session.matchedProducts.find(
          (m) => m.sourceMessageId === refMsgId,
        );
        if (target) {
          if (target.caption && target._captionTs &&
              (now - target._captionTs) <= SPLIT_GRADE_WINDOW_MS) {
            target.caption = `${target.caption} ${text}`;
          } else {
            target.caption = target.caption ? `${target.caption} ${text}` : text;
          }
          target._captionTs = now;
          persistSession(from);
        } else {
          session.pendingSizeTexts.push({ text, ts: now, refMsgId });
        }
      } else if (text && text !== '[Sticker]' && text !== '[Áudio_STT]' && text !== '[Áudio]' && !audioUrl) {
        // Texto puro (tamanho/qtd). Três destinos possíveis, na ordem:
        //   1. Último matched já tem caption setada há ≤ 8s → CONCATENA (cliente
        //      mandou "Mãe 1m 3g" e logo em seguida "Filha 3m 2g" — grade única).
        //   2. Último matched sem caption → setar caption (fluxo clássico).
        //   3. Fila FIFO com timestamp → se último item da fila foi há ≤ 8s e
        //      nenhuma foto chegou no meio, CONCATENA no item anterior.
        //      Senão, empilha novo com { text, ts }.
        const lastMatched = session.matchedProducts[session.matchedProducts.length - 1];

        if (lastMatched && lastMatched.caption && lastMatched._captionTs &&
            (now - lastMatched._captionTs) <= SPLIT_GRADE_WINDOW_MS) {
          lastMatched.caption = `${lastMatched.caption} ${text}`;
          lastMatched._captionTs = now;
          persistSession(from);
        } else if (lastMatched && !lastMatched.caption) {
          lastMatched.caption = text;
          lastMatched._captionTs = now;
          persistSession(from);
        } else {
          const lastPending = session.pendingSizeTexts[session.pendingSizeTexts.length - 1];
          if (lastPending && !lastPending.refMsgId && lastPending.ts &&
              (now - lastPending.ts) <= SPLIT_GRADE_WINDOW_MS) {
            lastPending.text = `${lastPending.text} ${text}`;
            lastPending.ts = now;
          } else {
            session.pendingSizeTexts.push({ text, ts: now });
          }
        }
      }

      // ADR-044: vendedora NÃO recebe nada em tempo real. Bufferiza cada evento
      // (foto/texto/áudio) em ordem; replay consolidado acontece 30s após o
      // upsell dentro de scheduleFecharPedidoHandoff.
      //
      // Reply com texto NUNCA duplica a foto no buffer — vira evento de texto
      // com quote=true para a vendedora ver "↩️ <texto>" no replay, mantendo
      // contexto visual sem repetir a imagem.
      if (!session.fecharPedidoRelayBuffer) session.fecharPedidoRelayBuffer = [];
      const nowTs = Date.now();
      if (imageUrl) {
        session.fecharPedidoRelayBuffer.push({
          type: 'image', imageUrl, caption: caption || null, messageId, ts: nowTs,
        });
      } else if (isReplyWithText) {
        session.fecharPedidoRelayBuffer.push({
          type: 'text', text, quote: true, ts: nowTs,
        });
      } else if (audioUrl) {
        session.fecharPedidoRelayBuffer.push({ type: 'audio', ts: nowTs });
      } else if (text && text !== '[Sticker]' && text !== '[Áudio_STT]' && text !== '[Áudio]') {
        session.fecharPedidoRelayBuffer.push({ type: 'text', text, ts: nowTs });
      }

      // ── Compound detection ───────────────────────────────────────────────
      // Antes de agendar handoff humano, verifica se o caso é composto:
      // 2+ fotos + texto "N de cada estampa / M de cada tamanho". Se for,
      // desvia para confirmação da Bela (schedulePendingCompoundConfirmation)
      // em vez do replay consolidado à vendedora.
      const compoundDetected = detectCompoundCase(session);
      if (compoundDetected) {
        // Cancela handoff de 90s — será retomado via fallback se a Bela falhar
        const existingHandoff = fecharPedidoInactivityTimers.get(from);
        if (existingHandoff) {
          clearTimeout(existingHandoff);
          fecharPedidoInactivityTimers.delete(from);
        }
        logger.info(
          { from, spec: compoundDetected.spec, matchedCount: session.matchedProducts.length },
          '[Compound] Caso composto detectado no fluxo fechar_pedido — desviando para Bela'
        );
        schedulePendingCompoundConfirmation(from, session);
        persistSession(from);
        return;
      }

      scheduleFecharPedidoHandoff(from, session);
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

    if (text === 'VER_OUTRA_CATEGORIA' || text === 'OUTRA CATEGORIA') {
      logger.info({ phone: from, currentCategory: session.activeCategory, cartItems: session.items?.length || 0 }, '[Intercept] VER_OUTRA_CATEGORIA — showcase visual de coleções');
      const introMsg = session.items?.length > 0
        ? 'Claro 😊 Seu carrinho continua salvo. Qual linha você quer ver agora?'
        : 'Claro 😊 Qual linha você quer ver agora?';
      await zapi.sendText(from, introMsg);
      await sendCategoryShowcase(from, session);
      persistSession(from);
      return;
    }

    // ── Fallback do Guard de Fila (resposta por texto/áudio) ──────────────────
    // Quando o guard mostrou o aviso "você ainda tem X produtos na fila, quer
    // separar antes?", o lojista pode responder clicando no botão OU por texto
    // ("fecha com esses mesmo", "não, pode finalizar"). Aqui interceptamos a
    // resposta textual ANTES de ir para a IA — evita o bug onde a IA emitia
    // [VER_TODOS:lancamento-da-semana] no lugar de [HANDOFF] e reabria o
    // catálogo no meio do fechamento.
    if (session.purchaseFlow?.queueGuardPending) {
      const decision = interpretQueueGuardAnswer(text);
      if (decision === 'finalize') {
        logger.info({ phone: from, text: text.slice(0, 60) }, '[QueueGuard] Resposta textual → finalize_anyway');
        appendHistory(session, 'user', text);
        conversationMemory.refreshConversationMemory(session, { userText: text });
        await handleQueueGuard(from, 'queue_finalize_anyway', session);
        persistSession(from);
        return;
      }
      if (decision === 'continue') {
        logger.info({ phone: from, text: text.slice(0, 60) }, '[QueueGuard] Resposta textual → continue');
        appendHistory(session, 'user', text);
        conversationMemory.refreshConversationMemory(session, { userText: text });
        await handleQueueGuard(from, 'queue_continue', session);
        persistSession(from);
        return;
      }
      // Texto ambíguo: limpa o flag pra não travar a sessão e deixa a IA seguir
      logger.info({ phone: from, text: text.slice(0, 60) }, '[QueueGuard] Resposta ambígua — liberando para IA');
      session.purchaseFlow.queueGuardPending = false;
    }

    // ── Seleção determinística de categoria (menu de listas) ──────────────────
    // Seleções de menu NÃO passam pela IA — roteamento direto por sentinela.
    // Evita que a IA re-interprete a categoria e gere o slug errado.
    if (CAT_SENTINELS[text]) {
      const slug = CAT_SENTINELS[text];
      logger.info({ phone: from, sentinel: text, slug }, '[Intercept] Seleção de categoria determinística');
      appendHistory(session, 'user', `quero ver a linha ${getCategoryDisplayName(slug)}`);
      conversationMemory.refreshConversationMemory(session, { userText: text });
      try {
        await showCategory(from, slug, session);
      } catch (catErr) {
        logger.error({ phone: from, slug, err: catErr?.message, stack: catErr?.stack?.slice(0, 300) }, '[Intercept] showCategory lançou exceção');
        await zapi.sendText(from, '⚠️ Erro ao carregar a categoria. Tenta de novo, amor!').catch(() => {});
      }
      persistSession(from);
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Interceptor: awaiting_variant — escolha do segundo eixo (ex: Mãe/Filha) ──────────────
    // Suporta três formatos:
    //   1. Variante simples:          "mae" / "filha" / "1" / "2"
    //   2. Variante + grade inline:   "mae 2g" / "filha 3P 2M"
    //   3. Multi-variante numa msg:   "mae 2g filha 1p"
    if (session.purchaseFlow?.state === 'awaiting_variant') {
      const pfV = session.purchaseFlow;
      const productForVariant = getLoadedProductById(session, pfV.productId) || session.currentProduct;
      const attrOptions = productForVariant?.secondaryAttributes?.find(
        (a) => a.name === pfV.variantAttributeName
      )?.options || [];
      const productSizes = (productForVariant?.sizes || []).filter(Boolean);
      const unitPrice = pfV.price || parseFloat(productForVariant?.salePrice || productForVariant?.price) || 0;

      // ── Caso 3 / Caso 2: mensagem com variante + grade (ex: "mae 2g filha 1p") ──
      const multiPairs = parseMultiVariantGrade(text, attrOptions, productSizes);
      if (multiPairs) {
        const addedSummary = [];
        const outOfStockSummary = [];
        const unknownSummary = [];

        for (const { variant, grade } of multiPairs) {
          // Temporariamente seta a variante para que o estoque filtre corretamente
          pfV.selectedVariant = variant;
          const enriched = await ensureProductStockData(productForVariant, getVariantFilter(session));
          const availableSizes = getAvailableSizesForSession(session, enriched || productForVariant);

          for (const { size, qty } of grade) {
            const matchedSize = availableSizes.find(
              (s) => normalizeSizeValue(s) === normalizeSizeValue(size)
            );
            if (matchedSize) {
              pushCartItem(session, pfV.productId, pfV.productName, matchedSize, qty, unitPrice, productForVariant?.imageUrl || null, variant);
              addedSummary.push(`${variant} ${matchedSize} x${qty}`);
            } else {
              // Distingue "tamanho que existe mas está sem estoque" de "tamanho inexistente"
              const sizeExistsInProduct = productSizes.some((s) => normalizeSizeValue(s) === normalizeSizeValue(size));
              if (sizeExistsInProduct) {
                outOfStockSummary.push(`${variant} ${size}`);
              } else {
                unknownSummary.push(`${variant} ${size}`);
              }
            }
          }
        }

        logger.info({ from, addedSummary, outOfStockSummary, unknownSummary, product: pfV.productName }, '[FSM/Variant] Grade multi-variante processada');

        // Reação de confirmação
        if (messageId) zapi.sendReaction(from, messageId, '✅').catch(() => {});

        pfV.state = 'awaiting_more_sizes';
        pfV.addedSizes = session.items
          .filter((it) => String(it.productId) === String(pfV.productId))
          .map((it) => it.size);

        // [ADR-035 / UX-SILENT-ADD] ✅ só via reação emoji (já enviada acima).
        // Texto apenas para ⚠️/❌ — cliente precisa saber de problemas de estoque.
        let replyMsg = '';
        if (outOfStockSummary.length > 0) {
          replyMsg += `⚠️ Sem estoque: ${outOfStockSummary.join(', ')}`;
        }
        if (unknownSummary.length > 0) {
          if (replyMsg) replyMsg += '\n';
          replyMsg += `❌ Tamanho não encontrado: ${unknownSummary.join(', ')}`;
        }
        if (replyMsg) await zapi.replyText(from, replyMsg.trim(), messageId);
        scheduleCartSummary(from);
        persistSession(from);
        return;
      }

      // ── Caso 1: variante simples ("mae" / "filha" / "1" / "2") ──
      const chosen = matchVariant(text, attrOptions);
      if (chosen) {
        logger.info({ from, chosen, product: pfV.productName }, '[FSM] Variante escolhida — verificando estoque');
        await tryAdvanceToSize(from, session, chosen);
      } else {
        // Nenhum parser entendeu — tenta IA antes de desistir
        logger.info({ from, text: text.slice(0, 60) }, '[FSM/Variant] Parser falhou — tentando IA');
        const variantHint =
          `[SISTEMA: O lojista está escolhendo a versão do produto "${pfV.productName}". ` +
          `As opções são: ${attrOptions.join(' ou ')}. ` +
          `Tamanhos disponíveis: ${productSizes.join(', ')}. ` +
          `Ele enviou: "${text}". ` +
          `Se conseguir interpretar, responda APENAS com o token [VARIANTE:X] (ex: [VARIANTE:Mãe]) ` +
          `e a grade se houver (ex: [VARIANTE:Mãe] 2G). ` +
          `Se não conseguir, responda apenas com a letra ?]`;
        let aiHandled = false;
        try {
          const aiRaw = await ai.chat([{ role: 'user', content: variantHint }], '');
          const parsed = ai.parseAction(aiRaw);
          if (parsed.type === 'VARIANTE' && parsed.payload) {
            const aiVariant = matchVariant(parsed.payload, attrOptions);
            if (aiVariant) {
              logger.info({ from, aiVariant, aiRaw: aiRaw?.slice(0, 80) }, '[FSM/Variant] IA interpretou variante');
              const advanced = await tryAdvanceToSize(from, session, aiVariant);
              aiHandled = advanced;
            }
          }
        } catch (aiErr) {
          logger.warn({ from, err: aiErr?.message }, '[FSM/Variant] IA falhou no fallback');
        }
        if (!aiHandled) {
          // IA também não entendeu — re-enviar lista
          logger.info({ from, text: text.slice(0, 40) }, '[FSM] Resposta inválida em awaiting_variant — reenviando lista');
          await zapi.sendText(from, `Hmm, não entendi 😅 Escolha pela lista ou responda com o nome:`);
          await sendVariantList(from, { name: pfV.variantAttributeName, options: attrOptions }, session);
        }
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

        // ── Tamanho único ignorado: substitui insistência por confirmação com foto ──
        // Se selectedSize === 'ÚNICO', o produto não tem variação de tamanho.
        // Quando o cliente envia algo que não é quantidade, em vez de passar para
        // a IA (que repetiria "quantas peças?"), envia foto + 3 botões diretos.
        // Isso evita o loop de insistência reportado no ADR-033.
        const pfUniq = session.purchaseFlow;
        if (pfUniq.selectedSize === 'ÚNICO' && !semanticQuick.wantsCheckout && !semanticQuick.wantsCart) {
          const prodUniq = getLoadedProductById(session, pfUniq.productId) || session.currentProduct;
          if (prodUniq) {
            logger.info({ from, text: trimmed.slice(0, 40) }, '[FSM] awaiting_quantity ÚNICO ignorado → sendSingleSizeConfirm');
            appendHistory(session, 'user', text);
            conversationMemory.refreshConversationMemory(session, { userText: text });
            await zapi.sendSingleSizeConfirm(from, prodUniq, pfUniq.interactiveVersion);
            persistSession(from);
            return;
          }
        }
      }
    }

    // ── Escape hatch: intenção de navegação durante FSM ativa ────────────────
    // Se o cliente claramente quer navegar para outros produtos/categorias
    // durante awaiting_size ou awaiting_quantity, reseta o estado para idle
    // para que buildFsmContext retorne null e a IA possa responder livremente.
    {
      const NAV_ESCAPE = /\b(outras?\s+op[çc][õo]es?|outras?\s+categor|ver\s+outra[s]?\s+|n[aã]o\s+quero\s+mais|desistir|cancelar|voltar)\b/i;
      // Padrão separado para pular APENAS o produto atual (preserva buyQueue)
      const SKIP_PRODUCT = /\b(n[aã]o\s+quero\s+ess[ea]|pode\s+tirar\s+ess[ea]|tira\s+ess[ea]|pula\s+ess[ea]|n[aã]o\s+quero\s+mais\s+ess[ea]|n[aã]o\s+quero\s+esse\s+n[aã]o)\b/i;
      const pf = session.purchaseFlow;
      if (pf?.state !== 'idle' && SKIP_PRODUCT.test(text)) {
        logger.info({ from, state: pf.state, text: text.slice(0, 60) }, '[FSM] Skip produto atual via texto');
        await skipCurrentProduct(from, session);
        persistSession(from);
        return;
      }
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
      // ID do card do produto citado — usado para citar de volta nas respostas de grade.
      const productCardMsgId =
        body?.referenceMessageId
        || body?.quotedMessage?.messageId
        || body?.quotedMessage?.stanzaId
        || body?.quotedMessage?.id
        || null;
      const hasQuote = Boolean(productCardMsgId);

      // [CartEdit] Quote reply no resumo do carrinho → roteamento especial ANTES de
      // tentar resolveQuotedProduct (que falharia pois o carrinho não é um produto).
      // Detecta comandos como "Tira 1M dessa primeira" / "Coloca mais 1M dessa segunda".
      if (hasQuote && session.lastCartSummaryMessageId) {
        const cartQuotedIds = [
          body?.referenceMessageId,
          body?.quotedMessage?.messageId,
          body?.quotedMessage?.stanzaId,
          body?.quotedMessage?.id,
        ].filter(Boolean);
        if (cartQuotedIds.includes(session.lastCartSummaryMessageId)) {
          logger.info({ from, text: text.slice(0, 80) }, '[CartEdit] Quote reply no carrinho — roteando para handleCartEditFromQuote');
          appendHistory(session, 'user', text);
          conversationMemory.refreshConversationMemory(session, { userText: text });
          await handleCartEditFromQuote(from, session, text);
          persistSession(from);
          return;
        }
      }

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
          // [Fix Bug 3 / revisado] Marca o produto atual como "grade textual fechada" APENAS
          // se já havia tamanhos adicionados. Se addedSizes=[], o produto foi abandonado sem
          // nenhum pedido — deve ser enfileirado pelo switchFsmFocus (ADR-022).
          // A versão anterior marcava incondicionalmente, causando perda silenciosa do produto
          // anterior quando o lojista trocava de foco sem ter comprado nada.
          if ((pfGrade.addedSizes?.length || 0) > 0) {
            pfGrade.lastCommitSource = 'text';
          }
          const { contextMessage: gradeCtxMsg, needsVariant: gradeNeedsVariant, secondaryAttr: gradeSecondaryAttr } = switchFsmFocus(session, resolved.product);
          // [ADR-035] Silêncio durante compra ativa: contextMessage é ruído quando o
          // cliente já tem itens no carrinho. O resumo de 30s cobre o estado completo.
          if (gradeCtxMsg && !session.items?.length) await zapi.replyText(from, gradeCtxMsg, messageId);
          // Se o novo produto requer escolha de variante, tenta parsear variante+grade
          // do próprio texto antes de pedir ao cliente (ex: quote + "mae 2M filha 1G").
          // Isso evita o round-trip desnecessário de "escolha a variante" quando o lojista
          // já informou tudo na mesma mensagem.
          if (gradeNeedsVariant && gradeSecondaryAttr) {
            const pfV = session.purchaseFlow;
            const productForVariant = getLoadedProductById(session, pfV.productId) || resolved.product;
            const attrOptions = gradeSecondaryAttr.options || [];
            const productSizes = (productForVariant?.sizes || []).filter(Boolean);
            const multiPairsQuote = attrOptions.length > 0 && productSizes.length > 0
              ? parseMultiVariantGrade(text, attrOptions, productSizes)
              : null;
            if (multiPairsQuote) {
              logger.info({ from, product: pfV.productName, text: text.slice(0, 80) }, '[Grade/QuoteVariant] Multi-variante parseada no quote-reply — processando direto');
              appendHistory(session, 'user', text);
              conversationMemory.refreshConversationMemory(session, { userText: text });
              const addedSummaryQV = [];
              const outOfStockSummaryQV = [];
              const unknownSummaryQV = [];
              const unitPriceQV = pfV.price || parseFloat(productForVariant?.salePrice || productForVariant?.price) || 0;
              const allProductSizesQV = (productForVariant?.sizes || []).filter(Boolean);
              for (const { variant, grade } of multiPairsQuote) {
                pfV.selectedVariant = variant;
                const enrichedQV = await ensureProductStockData(productForVariant, getVariantFilter(session));
                const availSizesQV = getAvailableSizesForSession(session, enrichedQV || productForVariant);
                for (const { size, qty } of grade) {
                  const matchedSizeQV = availSizesQV.find(s => normalizeSizeValue(s) === normalizeSizeValue(size));
                  if (matchedSizeQV) {
                    pushCartItem(session, pfV.productId, pfV.productName, matchedSizeQV, qty, unitPriceQV, productForVariant?.imageUrl || null, variant);
                    addedSummaryQV.push(`${variant} ${matchedSizeQV} x${qty}`);
                  } else {
                    // Distingue "tamanho que existe mas está sem estoque" de "tamanho inexistente"
                    const sizeExistsQV = allProductSizesQV.some((s) => normalizeSizeValue(s) === normalizeSizeValue(size));
                    if (sizeExistsQV) {
                      outOfStockSummaryQV.push(`${variant} ${size}`);
                    } else {
                      unknownSummaryQV.push(`${variant} ${size}`);
                    }
                  }
                }
              }
              if (messageId) zapi.sendReaction(from, messageId, '✅').catch(() => {});
              pfV.state = 'awaiting_more_sizes';
              pfV.lastCommitSource = 'text';
              pfV.addedSizes = session.items
                .filter(it => String(it.productId) === String(pfV.productId))
                .map(it => it.size);
              // [ADR-035 / UX-SILENT-ADD] ✅ só via reação emoji (já enviada acima).
              let replyMsgQV = '';
              if (outOfStockSummaryQV.length > 0) replyMsgQV += `⚠️ Sem estoque: ${outOfStockSummaryQV.join(', ')}`;
              if (unknownSummaryQV.length > 0) {
                if (replyMsgQV) replyMsgQV += '\n';
                replyMsgQV += `❌ Tamanho não encontrado: ${unknownSummaryQV.join(', ')}`;
              }
              if (replyMsgQV) await zapi.replyText(from, replyMsgQV.trim(), messageId);
              scheduleCartSummary(from);
              persistSession(from);
              return;
            }
            // Nenhum par variante+grade no texto.
            // Se só 1 variante tem estoque, auto-seleciona e deixa cair no grade parser
            // normal abaixo — a grade digitada pelo cliente (ex: "1gg") não é perdida.
            const productForAutoV = getLoadedProductById(session, session.purchaseFlow.productId) || resolved.product;
            if (productForAutoV?.variantSizes) {
              const availVars = gradeSecondaryAttr.options.filter(opt =>
                (productForAutoV.variantSizes[opt]?.length ?? 0) > 0
              );
              if (availVars.length === 1) {
                session.purchaseFlow.selectedVariant = availVars[0];
                logger.info({ from, autoVariant: availVars[0] }, '[Grade/QuoteVariant] Única variante com estoque — auto-selecionando e processando grade');
                await ensureProductStockData(productForAutoV, getVariantFilter(session));
                // NÃO retorna — cai no parser de grade abaixo
              } else {
                await sendVariantList(from, gradeSecondaryAttr, session);
                persistSession(from);
                return;
              }
            } else {
              await sendVariantList(from, gradeSecondaryAttr, session);
              persistSession(from);
              return;
            }
          }
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

        // BUG-2 FIX: Para produtos multi-variante (Mãe/Filha), tenta parseMultiVariantGrade
        // ANTES do parseGradeText simples. Isso permite que "1M mãe filha 1G" em awaiting_more_sizes
        // seja atribuído corretamente por variante em vez de usar cegamente o selectedVariant.
        const secAttrForMulti = focusedProduct?.secondaryAttributes?.[0];
        if (secAttrForMulti?.options?.length > 1) {
          const multiPairsMs = parseMultiVariantGrade(text, secAttrForMulti.options, allSizes);
          if (multiPairsMs) {
            logger.info({ from, product: pfGrade.productName, text: text.slice(0, 80) }, '[Grade] Multi-variante detectada em awaiting_more_sizes — processando por variante');
            appendHistory(session, 'user', text);
            conversationMemory.refreshConversationMemory(session, { userText: text });
            const addedSummaryMs = [];
            const outOfStockSummaryMs = [];
            const unknownSummaryMs = [];
            const unitPriceMs = pfGrade.price || parseFloat(focusedProduct.salePrice || focusedProduct.price) || 0;
            const allProductSizesMs = (focusedProduct.sizes || []).filter(Boolean);
            for (const { variant, grade: varGrade } of multiPairsMs) {
              pfGrade.selectedVariant = variant;
              const enrichedMs = await ensureProductStockData(focusedProduct, getVariantFilter(session));
              const availSizesMs = getAvailableSizesForSession(session, enrichedMs || focusedProduct);
              for (const { size, qty } of varGrade) {
                const matchedSizeMs = availSizesMs.find((s) => normalizeSizeValue(s) === normalizeSizeValue(size));
                if (matchedSizeMs) {
                  pushCartItem(session, pfGrade.productId, pfGrade.productName, matchedSizeMs, qty, unitPriceMs, focusedProduct.imageUrl || null, variant);
                  addedSummaryMs.push(`${variant} ${matchedSizeMs} x${qty}`);
                } else {
                  const sizeExistsMs = allProductSizesMs.some((s) => normalizeSizeValue(s) === normalizeSizeValue(size));
                  if (sizeExistsMs) {
                    outOfStockSummaryMs.push(`${variant} ${size}`);
                  } else {
                    unknownSummaryMs.push(`${variant} ${size}`);
                  }
                }
              }
            }
            if (addedSummaryMs.length > 0 && messageId) zapi.sendReaction(from, messageId, '✅').catch(() => {});
            pfGrade.state = 'awaiting_more_sizes';
            pfGrade.lastCommitSource = 'text';
            pfGrade.addedSizes = session.items
              .filter((it) => String(it.productId) === String(pfGrade.productId))
              .map((it) => it.size);
            // [ADR-035 / UX-SILENT-ADD] ✅ só via reação emoji (já enviada acima).
            let replyMsgMs = '';
            if (outOfStockSummaryMs.length > 0) replyMsgMs += `⚠️ Sem estoque: ${outOfStockSummaryMs.join(', ')}`;
            if (unknownSummaryMs.length > 0) {
              if (replyMsgMs) replyMsgMs += '\n';
              replyMsgMs += `❌ Tamanho não encontrado: ${unknownSummaryMs.join(', ')}`;
            }
            if (replyMsgMs) await zapi.replyText(from, replyMsgMs.trim(), messageId);
            scheduleCartSummary(from);
            persistSession(from);
            return;
          }
        }

        const grade = parseGradeText(text, allSizes);
        // Extrai tamanhos órfãos (digitados pelo cliente mas não reconhecidos)
        const orphanSizes = grade?._orphanSizes || [];

        if (grade && (grade.length > 0 || orphanSizes.length > 0)) {
          logger.info({ from, grade, orphanSizes, product: pfGrade.productName }, '[Grade] Grade semântica detectada');

          // Intercepta fallback de OOS multi-variante: "pode ser gg entao" após "Sem estoque: Filha G"
          // Usa o contexto armazenado (_pendingOosFallback) para restaurar variante + quantidade originais.
          const fallback = pfGrade._pendingOosFallback;
          if (fallback && String(fallback.productId) === String(focusedProduct.id) && grade.length > 0 && orphanSizes.length === 0) {
            delete pfGrade._pendingOosFallback;
            const unitPriceFb = parseFloat(focusedProduct.salePrice || focusedProduct.price);
            const addedFb = [];
            for (const oosEntry of fallback.outOfStock) {
              for (const { size } of grade) {
                const matchedSize = allSizes.find(s => s.toUpperCase() === size.toUpperCase());
                if (!matchedSize) continue;
                const avail = getSizeAvailability(session, focusedProduct, matchedSize);
                if (avail?.isAvailable === false) continue;
                pushCartItem(session, focusedProduct.id, focusedProduct.name, matchedSize, oosEntry.qty, unitPriceFb, focusedProduct.imageUrl || null, oosEntry.variant);
                addedFb.push(`${oosEntry.variant} ${matchedSize} x${oosEntry.qty}`);
              }
            }
            logger.info({ from, product: pfGrade.productName, addedFb }, '[Grade] OOS fallback multi-variante aplicado');
            appendHistory(session, 'user', text);
            conversationMemory.refreshConversationMemory(session, { userText: text });
            if (messageId) zapi.sendReaction(from, messageId, '✅').catch(() => {});
            pfGrade.state = 'awaiting_more_sizes';
            pfGrade.lastCommitSource = 'text';
            pfGrade.selectedVariant = null;
            session.currentProduct = focusedProduct;
            scheduleCartSummary(from);
            persistSession(from);
            return;
          }

          appendHistory(session, 'user', text);
          conversationMemory.refreshConversationMemory(session, { userText: text });

          const unitPrice = parseFloat(focusedProduct.salePrice || focusedProduct.price);
          const addable = [];
          const unavailable = [];
          const unknown = [];

          // Adiciona tamanhos órfãos à lista de desconhecidos
          for (const os of orphanSizes) {
            unknown.push({ size: os, qty: 0 });
          }

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
            pushCartItem(session, focusedProduct.id, focusedProduct.name, size, qty, unitPrice, focusedProduct.imageUrl || null, pfGrade.selectedVariant || null);
            addedItems.push({ size, qty });
          }

          // Monta partes de erro (⚠️/❓) e de sucesso separadamente.
          // [ADR-035 / UX-SILENT-ADD]: ✅ não é enviado como texto — apenas reação emoji.
          // Erros de estoque/tamanho SEMPRE disparam imediatamente.
          let unavailMsg = '';
          if (unavailable.length > 0) {
            const unavailLines = unavailable.map(({ size, qty, available }) =>
              available > 0
                ? `• ${size}: pediu ${qty}, só tem ${available} disponível`
                : `• ${size}: indisponível no momento`
            ).join('\n');
            unavailMsg += `⚠️ Não consegui incluir:\n${unavailLines}`;
          }
          if (unknown.length > 0) {
            const unknownList = unknown.map(u => u.size).join(', ');
            const validList = allSizes.join(', ');
            if (unavailMsg) unavailMsg += '\n\n';
            unavailMsg += `❓ Tamanho(s) *${unknownList}* não existe(m) neste produto. Disponíveis: *${validList}*`;
          }

          // Monta confirmMsg para histórico/memória da IA (não enviado ao cliente quando addedItems > 0)
          const parts = [];
          if (addedItems.length > 0) {
            const gradeLines = addedItems.map(({ size, qty }) =>
              `• ${focusedProduct.name} (${size}) x${qty}`
            ).join('\n');
            parts.push(`✅ Grade separada!\n${gradeLines}`);
          }
          if (unavailMsg) parts.push(unavailMsg);
          // [ADR-035] Removido "Me manda as quantidades..." — o ⚠️/❓ já contém a info.

          const confirmMsg = parts.join('\n\n');

          appendHistory(session, 'assistant', confirmMsg);
          conversationMemory.refreshConversationMemory(session, { assistantText: confirmMsg, action: { type: 'CARRINHO' } });

          if (addedItems.length > 0) {
            // ✅ Reação imediata na mensagem do cliente — confirma recebimento da grade
            // Fire-and-forget: não bloqueia a resposta principal, falha silenciosa.
            if (messageId) zapi.sendReaction(from, messageId, '✅').catch(() => {});

            pfGrade.state = 'awaiting_more_sizes';
            pfGrade.selectedSize = null;
            if (!Array.isArray(pfGrade.addedSizes)) pfGrade.addedSizes = [];
            // Marca grade como "commit explícito via texto" — se cliente citar
            // outro produto depois, switchFsmFocus NÃO enfileira este.
            pfGrade.lastCommitSource = 'text';
            session.currentProduct = focusedProduct;

            // Envia ⚠️ de estoque/tamanho imediatamente se houver (cliente precisa saber).
            // Cita o card do produto para deixar claro a qual produto o erro se refere.
            if (unavailMsg) await zapi.replyText(from, unavailMsg, productCardMsgId);

            // Salva contexto da falha parcial para interceptar resposta do cliente
            // (ex: "Pode ser 1" → adiciona 1x GG automaticamente)
            if (unavailable.length > 0) {
              pfGrade._lastPartialFailure = {
                items: unavailable.filter(u => u.available > 0).map(u => ({ size: u.size, available: u.available })),
                productId: focusedProduct.id,
                productName: focusedProduct.name,
                unitPrice,
                variant: pfGrade.selectedVariant || null,
                imageUrl: focusedProduct.imageUrl || null,
              };
            }

            // [ADR-024 + ADR-035] Grade por TEXTO = commit explícito.
            // Sempre aguarda 60s de silêncio antes de avançar — mesmo com fila.
            // scheduleCartSummary checa buyQueue ao disparar e chama processNextInQueue se necessário.
            scheduleCartSummary(from);
          } else {
            pfGrade.state = 'awaiting_size';
            pfGrade.interactiveVersion = Date.now();
            session.currentProduct = focusedProduct;
            // [ADR-035] Envia apenas o ⚠️/❓ — sem menu de tamanhos redundante.
            // O cliente sabe qual produto é e pode ajustar a quantidade.
            if (unavailMsg) await zapi.replyText(from, unavailMsg, productCardMsgId);
            // Salva contexto de falha total para interceptar resposta do cliente
            if (unavailable.length > 0) {
              pfGrade._lastPartialFailure = {
                items: unavailable.filter(u => u.available > 0).map(u => ({ size: u.size, available: u.available })),
                productId: focusedProduct.id,
                productName: focusedProduct.name,
                unitPrice,
                variant: pfGrade.selectedVariant || null,
                imageUrl: focusedProduct.imageUrl || null,
              };
            }
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
    if (await tryHandleCommercialCatalogQuery(from, text, session, semanticQuick)) {
      persistSession(from);
      return;
    }

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
          // Intenção de navegação: "as outras", "próximo", "fila" etc. → deixa IA processar com SKIP_MORE
          const QUEUE_NAV_INTENT = /\b(as\s+outras?|pr[oó]xim[ao][s]?(\s+produto[s]?)?|outr[ao][s]?(\s+produto[s]?)?|fila|seguinte|pular|avan[cç]ar|segue[i]?|continua)\b/i;
          const isNavIntent = pfCheck.buyQueue?.length > 0 && QUEUE_NAV_INTENT.test(text);

          if (isNavIntent) {
            logger.info({ from, text }, '[FSM] Intenção de navegação em awaiting_size → passando para IA (SKIP_MORE)');
            // Falls through to AI processing below
          } else {
            const wordCount = text.trim().split(/\s+/).length;
            // Guard: não bloquear inputs que parecem grade (ex: "2m", "1p", "2m 1p").
            // Se o grade parser principal (antes do FSM interceptor) falhou por produto
            // não encontrado em session.products, ainda assim não devemos mostrar o fallback
            // — o texto vai para a IA que sabe interpretar tamanho+quantidade.
            const looksLikeGrade = /\d+\s*[a-zA-Z]{1,2}\b/.test(text.trim());
            if (wordCount <= 2 && !looksLikeGrade) {
              logger.info({ from, text, state: pfCheck.state }, '[FSM] Texto curto ambíguo em awaiting_size — re-enviando menu combinado');
              const sizeLabels = availableSizes.map(s => `_${s}_`).join(', ');
              const gradeExample = availableSizes.length >= 2
                ? `_2${availableSizes[0]} 1${availableSizes[1]}_`
                : `_2${availableSizes[0]}_`;
              await zapi.sendText(from, `Opa, pra separar essa peça preciso só do tamanho 😊 Pode digitar: ${sizeLabels} — ou vários de uma vez: ${gradeExample}. Se preferir falar com a consultora, é só me dizer!`);
              await sendStockAwareSizeQtyList(from, session, product, pfCheck.interactiveVersion);
              persistSession(from);
              return;
            }
            // Mensagem com 3+ palavras, ou com padrão dígito+letra → passa para IA
            logger.info({ from, text, wordCount, looksLikeGrade, state: pfCheck.state }, '[FSM] Texto em awaiting_size — passando para IA');
          }
          // Falls through to AI processing below
        }
      }
    }

    // ── Interceptor de resposta a falha parcial de grade ────────────────────────
    // "Pode ser 1", "Coloca 1 então", "Ok" etc. após ⚠️ de quantidade insuficiente.
    if (!fsmEscaping && pfCheck?._lastPartialFailure) {
      const handled = await handlePartialFailureResponse(from, session, text, messageId);
      if (handled) return;
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
        // Mesmo guard do awaiting_size: não bloquear "2m", "1p", "1gg" etc.
        const looksLikeGradeMore = /\d+\s*[a-zA-Z]{1,2}\b/.test(text.trim());
        if (wordCount <= 2 && !looksLikeGradeMore) {
          logger.info({ from, text, state: pfCheck.state }, '[FSM] Texto curto ambíguo em awaiting_more_sizes — re-enviando menu');
          await sendPostAddMenu(from, session, remainingSizes);
          persistSession(from);
          return;
        }
        // Mensagem com 3+ palavras, ou padrão dígito+letra → passa para IA
        logger.info({ from, text, wordCount, looksLikeGrade: looksLikeGradeMore, state: pfCheck.state }, '[FSM] Texto em awaiting_more_sizes — passando para IA');
        // Falls through to AI processing below
      }
    }

    // ── Interceptor de navegação durante FSM ativa ───────────────────────────
    // Quando fsmEscaping=TRUE e a FSM ainda está ativa (awaiting_size/qty/more),
    // intents de navegação devem ser tratados deterministicamente — sem passar
    // pela IA. Isso evita o crash "Poxa, tive um pequeno problema" quando o
    // Gemini falha. O estado da FSM é resetado para idle; o carrinho fica intacto.
    if (fsmEscaping && pfCheck.state !== 'idle') {
      const navAction = semantic.inferActionFromSemantics(text, session);
      const isNavIntent = navAction && ['VER', 'VER_TODOS', 'BUSCAR', 'PROXIMOS'].includes(navAction.type);
      if (isNavIntent) {
        logger.info(
          { from, action: navAction.type, payload: navAction.payload, fsmState: pfCheck.state },
          '[FSM] Navegação durante FSM ativa → reset idle + execute determinístico'
        );
        // Reseta FSM para idle — o lojista conscientemente saiu do fluxo de tamanho.
        // O produto anterior e o carrinho já adicionado ficam intactos.
        pfCheck.state = 'idle';
        const cartNote = (session.items?.length || 0) > 0 ? ' Seu carrinho continua salvo 😊' : '';
        const navMsg = `Claro!${cartNote} Deixa eu te mostrar:`;
        appendHistory(session, 'user', text);
        conversationMemory.refreshConversationMemory(session, { userText: text, action: navAction });
        appendHistory(session, 'assistant', navMsg);
        conversationMemory.refreshConversationMemory(session, { assistantText: navMsg });
        await zapi.sendText(from, navMsg);
        await executeAction(from, navAction, session, { isFirstContact: false });
        persistSession(from);
        return;
      }
      logger.info({ from, text, state: pfCheck.state }, '[FSM] Escape sem intent de navegação — passando para IA');
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
        const orphanSizesQuote = gradeFromQuote?._orphanSizes || [];
        if (gradeFromQuote && (gradeFromQuote.length > 0 || orphanSizesQuote.length > 0)) {
          logger.info({ from, grade: gradeFromQuote, orphanSizes: orphanSizesQuote, product: quotedProductRef.name }, '[Grade] Grade via produto citado (FSM idle)');
          const pf = session.purchaseFlow;
          const unitPrice = parseFloat(quotedProductRef.salePrice || quotedProductRef.price);
          pf.productId = quotedProductRef.id;
          pf.productName = quotedProductRef.name;
          pf.unitPrice = unitPrice;

          const addableQuote = [];
          const unavailableQuote = [];
          const unknownQuote = [];

          // Adiciona tamanhos órfãos à lista de desconhecidos
          for (const os of orphanSizesQuote) {
            unknownQuote.push({ size: os, qty: 0 });
          }

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
            pushCartItem(session, quotedProductRef.id, quotedProductRef.name, size, qty, unitPrice, quotedProductRef.imageUrl || null, session.purchaseFlow?.selectedVariant || null);
            addedItems.push({ size, qty });
          }

          // Monta partes de erro (⚠️/❓) separadamente do ✅.
          // [ADR-035 / UX-SILENT-ADD]: ✅ não é enviado como texto — apenas reação emoji.
          let unavailMsgQ = '';
          if (unavailableQuote.length > 0) {
            const unavailLines = unavailableQuote.map(({ size, qty, available }) =>
              available > 0
                ? `• ${size}: pediu ${qty}, só tem ${available} disponível`
                : `• ${size}: indisponível no momento`
            ).join('\n');
            unavailMsgQ += `⚠️ Não consegui incluir:\n${unavailLines}`;
          }
          if (unknownQuote.length > 0) {
            const unknownList = unknownQuote.map(u => u.size).join(', ');
            const validList = allSizesQuote.join(', ');
            if (unavailMsgQ) unavailMsgQ += '\n\n';
            unavailMsgQ += `❓ Tamanho(s) *${unknownList}* não existe(m) neste produto. Disponíveis: *${validList}*`;
          }

          // confirmMsg para histórico/memória da IA
          const parts = [];
          if (addedItems.length > 0) {
            const gradeLines = addedItems.map(({ size, qty }) => `• ${quotedProductRef.name} (${size}) x${qty}`).join('\n');
            parts.push(`✅ Grade separada!\n${gradeLines}`);
          }
          if (unavailMsgQ) parts.push(unavailMsgQ);
          // [ADR-035] Removido "Me manda as quantidades..." — o ⚠️/❓ já contém a info.

          const confirmMsg = parts.join('\n\n');

          appendHistory(session, 'assistant', confirmMsg);
          conversationMemory.refreshConversationMemory(session, { assistantText: confirmMsg, action: { type: 'CARRINHO' } });

          const quoteIdQ =
            body?.referenceMessageId
            || body?.quotedMessage?.messageId
            || body?.quotedMessage?.stanzaId
            || body?.quotedMessage?.id
            || null;

          if (addedItems.length > 0) {
            pf.state = 'awaiting_more_sizes';
            pf.selectedSize = null;
            if (!Array.isArray(pf.addedSizes)) pf.addedSizes = [];
            pf.lastCommitSource = 'text';
            session.currentProduct = quotedProductRef;

            // Envia ⚠️ de estoque/tamanho imediatamente se houver.
            if (unavailMsgQ) await zapi.replyText(from, unavailMsgQ, quoteIdQ);

            // [ADR-024 + ADR-035] Grade via quote-reply = texto = commit explícito.
            // Sempre aguarda 60s de silêncio antes de avançar — mesmo com fila.
            scheduleCartSummary(from);
          } else {
            pf.state = 'awaiting_size';
            pf.interactiveVersion = Date.now();
            session.currentProduct = quotedProductRef;
            // [ADR-035] Envia apenas o ⚠️/❓ — sem menu de tamanhos redundante.
            if (unavailMsgQ) await zapi.replyText(from, unavailMsgQ, quoteIdQ);
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
    // GUARD: não intercepta como "pedido de fotos" se o texto parece uma GRADE
    // (ex: "2p 1g", "1m", "3 do P"). Caso contrário o bot responde com fotos
    // quando o lojista só queria adicionar ao carrinho via quote-reply.
    const GRADE_LIKE = /\b\d{1,3}\s*(?:do|da|de|dos|das|x|:|tamanho)?\s*(?:pp|p|m|g|gg|xg|eg|exgg|[ún]ico|único|unico)\b/i.test(text)
      || /\b(?:pp|p|m|g|gg|xg|eg|exgg)\s*[=:\-]\s*\d{1,3}\b/i.test(text);
    const photoProductRef = quotedProduct || (quotedProductIdx ? session.products?.[quotedProductIdx - 1] : null);
    if (photoProductRef && !GRADE_LIKE && (EFFECTIVE_PHOTO_REQUEST || isShortMessage)) {
      logger.info({ productId: photoProductRef.id, productIdx: quotedProductIdx }, '[Intercept] Pedido de fotos — resolvido em código');
      await showProductPhotos(from, quotedProductIdx || photoProductRef.id, session);
      persistSession(from);
      return;
    }
    if (photoProductRef && GRADE_LIKE) {
      logger.info({ productId: photoProductRef.id, text: text.slice(0, 40) }, '[Intercept] Texto parece GRADE — não intercepta como fotos');
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
    if (!CATEGORY_INTENT && !GRADE_LIKE && (EFFECTIVE_PHOTO_REQUEST || (quotedHasImage && isShortMessage)) && !quotedProductIdx && canUseLastViewedFallback && session.lastViewedProduct) {
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

    // ── Primeiro Contato — saudação fixa instruticional ───────────────────────
    // NÃO passa pela IA: o texto é controlado para ser claro e idiota-proof.
    // Explica o fluxo de compra antes de mostrar os produtos.
    if (isFirstContact) {
      const hour = new Date().getHours();
      const turno = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';

      // Texto visual WhatsApp — formatação markdown para negrito/itálico
      const welcomeMsg = `${turno}! 👋 Sou a *Bela*, consultora da *Belux Moda Íntima*!

Aqui atendemos no *atacado* — você compra direto para revender ou montar seu estoque 🏪
_Pedido mínimo: *R$ 150,00*_ 🛒 — pagamento via *PIX tem desconto especial* 💸

*Como funciona:*
*1.* Vou te mostrar nossos produtos com foto e preço 📸
*2.* Quando gostar de algum, *deslize a foto* e me envie o *tamanho* e a *quantidade* — pode digitar ou mandar um *áudio* 🎙️
*3.* Pode pedir várias peças à vontade — vou somando no seu carrinho 🛍️
*4.* Quando terminar, me avisa que envio o *resumo completo* com total do pedido

_Qualquer dúvida sobre tamanho, disponibilidade ou preço — pode perguntar a qualquer momento 😊_
_Quer falar com a consultora humana? É só dizer "falar com consultora"_

O que você prefere agora? 👇`;

      // Texto TTS — sem markdown, escrito para ser falado
      const welcomeTTS = `${turno}! Que bom ter você aqui! Sou a Bela, consultora da Belux Moda Íntima, e vou te acompanhar em cada passo dessa compra!

Antes de começar, deixa eu te contar uma coisa importante: aqui na Belux trabalhamos no atacado. Isso significa que você compra direto da fábrica, para revender ou montar o seu estoque. O pedido mínimo é de cento e cinquenta reais. E se quiser pagar via PIX, você ainda tem desconto especial!

Agora deixa eu te mostrar como é simples comprar aqui.

Primeiro: vou te mostrar os produtos um por um, com foto, preço e tamanhos disponíveis. É só olhar com calma!

Segundo, e esse é o pulo do gato: quando você ver um modelo que gostar, desliza a foto para o lado esquerdo. Só isso. Vai aparecer um espaço para você escrever o tamanho e a quantidade que você quer. Por exemplo: se você quer duas peças de tamanho grande, escreve assim — dois G. Se quer uma grande e uma média, escreve — um G e um M. É bem isso mesmo, simples assim! E se preferir, também tem botões bem visíveis embaixo de cada foto para você clicar. Ou então manda um áudio falando o que quer — eu entendo tudo!

Terceiro: pode pedir quantas peças quiser! Vou somando tudo no seu carrinho sem pressa.

Quarto: quando terminar de escolher, é só me avisar que terminou. Eu te mando um resumo completo do pedido, com tudo certinho.

Qualquer dúvida que aparecer no caminho — sobre tamanho, disponibilidade, preço ou o que for — pode me perguntar à vontade e na hora que quiser.

Então me diz: o que você prefere agora? Fechar um pedido que já sabe o que quer? Ver os lançamentos da semana? Ou precisa resolver algum problema? É só escolher uma das opções e a gente começa!`;

      appendHistory(session, 'assistant', welcomeMsg);
      conversationMemory.refreshConversationMemory(session, { assistantText: welcomeMsg });
      await zapi.sendText(from, welcomeMsg);
      if (TTS_ENABLED) {
        try {
          const { buffer, mimeType } = await tts.textToSpeech(welcomeTTS);
          await zapi.sendAudio(from, buffer, mimeType);
        } catch (err) {
          logger.error({ from, err: err.message }, '[TTS] Erro na saudação');
        }
      }
      try {
        await showAllCategory(from, 'lancamento-da-semana', session);
      } catch (err) {
        logger.warn({ from, err: err.message }, '[FirstContact] Falha ao listar lançamentos pós-welcome');
      }
      persistSession(from);
      return;
    }

    let systemNudge = null;

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
        const fallbackGreeting = 'Oi! 👋 Sou a *Bela* da Belux. Olha só o que chegou de novo pra você:';
        appendHistory(session, 'assistant', fallbackGreeting);
        conversationMemory.refreshConversationMemory(session, { assistantText: fallbackGreeting });
        await zapi.sendText(from, fallbackGreeting);
        await showAllCategory(from, 'lancamento-da-semana', session);
        persistSession(from);
        return;
      }

      // ── Auto-escalação: 2 falhas consecutivas → atendente humano ──
      session.consecutiveFailures = (session.consecutiveFailures || 0) + 1;
      if (session.consecutiveFailures >= 2) {
        logger.info({ phone: from, failures: session.consecutiveFailures }, '[AutoEscalation] 2 falhas consecutivas — encaminhando para atendente');
        session.consecutiveFailures = 0;
        await handoffToHuman(from, session);
        persistSession(from);
        return;
      }

      await zapi.sendText(from, 'Poxa, tive um pequeno problema aqui, mas já tô voltando! Pode repetir sua última mensagem? 😊');
      persistSession(from);
      return;
    }
    logger.info({ phone: from, response: aiRaw }, '[AI] Response');

    let { cleanText, action } = ai.parseAction(aiRaw);
    // [STUDY] Decisão da IA após parse
    logger.info({
      from,
      actionType:       action?.type        || null,
      hasText:          !!cleanText,
      textPreview:      cleanText?.slice(0, 100) || null,
      fsmState:         session.purchaseFlow?.state || 'idle',
      currentProduct:   session.currentProduct    || null,
    }, '[AI] Decisão parseada');

    // ── Auto-escalação: reset do contador quando IA processa com sucesso ──
    if (cleanText || action) {
      session.consecutiveFailures = 0;
    }

    // ── V2 SHADOW MODE ─────────────────────────────────────────────────────
    // Roda a Bela V2 (Function Calling) em paralelo, fire-and-forget.
    // Apenas LOGA a decisão V2 vs V1 — nunca envia mensagem ao cliente.
    // Qualquer erro é silenciado dentro do shadow-router. NUNCA pode afetar V1.
    // Ativar via .env: AGENT_SHADOW_MODE=true
    if (shadowV2.isShadowEnabled()) {
      setImmediate(() => {
        shadowV2.runShadow({
          phone: from,
          history: activeHistory,
          catalogContext: promptContext,
          v1Result: { cleanText, action },
        }).catch(() => { /* já tratado internamente */ });
      });
    }

    const semanticFallbackAction = semantic.inferActionFromSemantics(text, session);
    if (!action && semanticFallbackAction) {
      action = semanticFallbackAction;
      logger.info({ actionType: action.type, payload: action.payload || null }, '[SemanticFallback] Acao inferida por sentido');
    }

    // ── Reflection Call — segunda chamada à IA em contextos confusos ──────────
    // Dispara quando a FSM exige um token (awaiting_size / awaiting_quantity)
    // mas a IA e o fallback semântico não produziram nenhum. A segunda chamada
    // recebe um prompt focado para resolver a ambiguidade sem custo extra alto.
    // Proteção de custo: só dispara se o texto tem >2 palavras (mensagens curtas
    // como "ok", "sim", "2" já são tratadas pelo fallback semântico).
    if (!action) {
      const pfNow = session.purchaseFlow;
      const needsToken = pfNow?.state === 'awaiting_variant' || pfNow?.state === 'awaiting_size' || pfNow?.state === 'awaiting_quantity';
      const isAmbiguous = text.trim().split(/\s+/).length > 2;
      if (needsToken && isAmbiguous) {
        try {
          logger.info({ from, state: pfNow.state, text }, '[ReflectionCall] Disparando segunda chamada à IA');
          const reflectionPrompt = buildReflectionPrompt(text, cleanText || aiRaw, pfNow);
          const reflectionRaw = await ai.chat(activeHistory, reflectionPrompt);
          const { cleanText: rt, action: ra } = ai.parseAction(reflectionRaw);
          if (ra) {
            action = ra;
            cleanText = rt || cleanText;
            logger.info({ from, action: ra.type, payload: ra.payload }, '[ReflectionCall] Token recuperado na 2ª chamada');
          } else {
            // Segunda chamada também não produziu token — usa o texto dela (mais contextual)
            if (rt) cleanText = rt;
            logger.info({ from }, '[ReflectionCall] 2ª chamada sem token — usando texto da reflexão');
          }
        } catch (reflErr) {
          logger.warn({ err: reflErr?.message }, '[ReflectionCall] Falha na 2ª chamada — continuando com resposta original');
        }
      }
    }
    // ── fim Reflection Call ───────────────────────────────────────────────────

    // ── GUARD ANTI-ALUCINAÇÃO DE COMMIT (Bug #Cíntia-2026-04-23) ──────────────
    // Sintoma: IA responde "Já anotei no carrinho: 1 Mãe M, 1 Filha M" em texto,
    // sem emitir [TAMANHO]/[QUANTIDADE]/[COMPRAR_DIRETO]. Nada entra em session.items.
    // Cliente tenta fechar pedido e recebe "Seu carrinho está vazio".
    //
    // Detector: action === null (nem parseAction nem reflection extraíram token)
    // + texto com vocabulário de commit. Substitui por pergunta de re-ask e loga.
    if (!action && cleanText) {
      const commitPhraseRegex = /\b(anotei|anotado|anotada|deixei\s+anotad[oa]|adicionei|adicionado|adicionada|coloquei\s+no\s+(?:seu\s+)?carrinho|separei|j[áa]\s+separei|j[áa]\s+t[áa]\s+no\s+(?:seu\s+)?carrinho|t[áa]\s+anotado\s+(?:aqui|no)|ajustei\s+aqui|alterei\s+aqui|alterado\s+aqui|prontinho,?\s*ajustad[oa])\b/i;
      if (commitPhraseRegex.test(cleanText)) {
        session.hallucinatedCommits = (session.hallucinatedCommits || 0) + 1;
        logger.warn({
          from,
          textPreview:          cleanText.slice(0, 160),
          fsmState:             session.purchaseFlow?.state || 'idle',
          currentProductId:     session.currentProduct?.id || null,
          pfProductId:          session.purchaseFlow?.productId || null,
          hallucinatedCommits:  session.hallucinatedCommits,
        }, '[AI] Alucinação de commit detectada — resposta confirmou sem emitir token');

        const hasProductFocus = session.purchaseFlow?.productId || session.currentProduct;
        cleanText = hasProductFocus
          ? 'Opa, me confirma rapidinho 😊 qual tamanho e quantidade você quer dessa peça? (ex: _M 1_, _2P 1G_)'
          : 'Opa, só pra separar certinho 😊 me diz o produto (ou número dele), tamanho e quantidade que você quer.';
      }
    }
    // ── fim guard anti-alucinação ─────────────────────────────────────────────

    // Mão de Ferro v3 — Se é primeiro contato ou o usuário pediu lançamentos/novidades,
    // nós FORÇAMOS o catálogo e limpamos qualquer outra ação conflitante.
    const semanticAnalysis = semantic.analyzeUserMessage(text);
    if (action?.type === 'HANDOFF' && semanticAnalysis.wantsHuman) {
      action = { type: 'FALAR_ATENDENTE', payload: null };
      logger.info('[SemanticGuard] HANDOFF convertido para FALAR_ATENDENTE');
    }
    // GUARD: HANDOFF é terminal — se a IA já decidiu finalizar, nenhum HardForce
    // pode sobrescrever isso (nem lançamentos nem primeiro contato).
    const handoffLocked = action?.type === 'HANDOFF';
    // GUARD: com carrinho ativo ou fila pendente, NUNCA forçar VER_TODOS — o
    // cliente está no meio de uma compra e pode estar só mencionando "novidades"
    // por outros motivos. Reabrir o catálogo de lançamentos é um bug grave que
    // faz a Bela pular o handoff durante o fechamento do pedido.
    const cartHasItems = Array.isArray(session.items) && session.items.length > 0;
    const queueHasItems = (session.purchaseFlow?.buyQueue?.length || 0) > 0;
    const purchaseInProgress = cartHasItems || queueHasItems || session.purchaseFlow?.state !== 'idle';
    const requestedLancamentos = semanticAnalysis.wantsLaunches;
    if (!handoffLocked && !purchaseInProgress && (isFirstContact || requestedLancamentos)) {
      logger.info({ isFirstContact, requestedLancamentos }, '[HardForce] Forçando catálogo de lançamentos');
      action = { type: 'VER_TODOS', payload: 'lancamento-da-semana' };

      // Limpa qualquer pergunta sobre categorias — o sistema vai mostrar os produtos direto
      if (cleanText.includes('?')) {
        cleanText = cleanText.split('?')[0].trim() + ' 😊';
      }
    } else if ((isFirstContact || requestedLancamentos) && purchaseInProgress) {
      logger.info(
        { cartHasItems, queueHasItems, fsmState: session.purchaseFlow?.state },
        '[HardForce] Bloqueado — compra em andamento, não reabrir lançamentos'
      );
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

    // [ADR-035] Guard: silencia resposta da IA durante compra ativa.
    // Quando há compra em andamento (carrinho ou fila), ações de compra não precisam
    // de texto da IA — o FSM executa silenciosamente e scheduleCartSummary cuida do resumo.
    // Sem este guard, a IA envia textos verbosos e incorretos (ex: "(M)" quando a grade
    // usou "(G)") que corrompem o contexto de IA e causam misinterpretações subsequentes.
    const isSilentBuyingAction = action && ['QUANTIDADE', 'TAMANHO', 'COMPRAR_DIRETO'].includes(action.type);
    if (purchaseInProgress && isSilentBuyingAction && cleanText) {
      logger.info({ from, actionType: action.type }, '[SilentBuying] Texto da IA suprimido — compra em andamento (ADR-035)');
      cleanText = '';
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
      const isIntroOnly = isFirstContact && TTS_ENABLED;
      await sendTextWithTTS(from, cleanText, { 
        tts: isIntroOnly ? true : null, // Se for intro, força TTS mesmo que global esteja OFF (opcional)
        replyTo: isIntroOnly ? null : messageId 
      });
    }

    if (action) {
      // Guard: VER/VER_TODOS não devem interromper uma compra em andamento.
      // Se a FSM está ocupada (awaiting_variant/size/quantity/more_sizes), ignora ações de navegação
      // que a IA possa ter inferido erroneamente (comum em quote-replies com citação de produto).
      const NAV_ACTIONS = ['VER', 'VER_TODOS'];
      const FSM_BUSY_STATES = ['awaiting_variant', 'awaiting_size', 'awaiting_quantity', 'awaiting_more_sizes'];
      const fsmBusy = FSM_BUSY_STATES.includes(session.purchaseFlow?.state);
      if (NAV_ACTIONS.includes(action.type) && fsmBusy) {
        logger.info({ from, actionType: action.type, fsmState: session.purchaseFlow?.state }, '[Action] VER/VER_TODOS ignorado — FSM ocupada durante compra');
      } else {
        await executeAction(from, action, session, { isFirstContact });
      }
    }

    if (!cleanText && !action) {
      logger.warn({ from, originalText: text.slice(0, 120) }, '[Fallback] IA sem texto e sem ação — enviando recuperação contextual');

      // ── Auto-escalação: 2 falhas consecutivas → atendente humano ──
      session.consecutiveFailures = (session.consecutiveFailures || 0) + 1;
      if (session.consecutiveFailures >= 2) {
        logger.info({ phone: from, failures: session.consecutiveFailures, trigger: 'AUTO_ESCALATION_AI_EMPTY', fsmState: session.purchaseFlow?.state || 'idle', cartItems: session.items?.length || 0 }, '[AutoEscalation] 2 falhas consecutivas — encaminhando para atendente');
        session.consecutiveFailures = 0;
        await handoffToHuman(from, session);
        persistSession(from);
        return;
      }

      await sendContextualFallback(from, session);
    }

    persistSession(from);

    } finally {
      // Libera o slot da fila — próxima mensagem pendente para este número pode iniciar
      _releasePhone?.();
      if (phoneProcessingQueue.get(from) === _phoneTask) phoneProcessingQueue.delete(from);
    }

  } catch (error) {
    logger.error({ err: error }, '[Webhook] Error');
    const isRateLimit = error.status === 429 || error.message?.includes('429');
    if (isRateLimit && from) {
      // ── Auto-escalação: 2 falhas consecutivas → atendente humano ──
      const sess = sessions.get(from);
      if (sess) {
        sess.consecutiveFailures = (sess.consecutiveFailures || 0) + 1;
        if (sess.consecutiveFailures >= 2) {
          logger.info({ phone: from, failures: sess.consecutiveFailures }, '[AutoEscalation] 2 falhas consecutivas — encaminhando para atendente');
          sess.consecutiveFailures = 0;
          await handoffToHuman(from, sess);
          persistSession(from);
          return;
        }
        persistSession(from);
      }
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

    case 'VARIANTE': {
      const pfVar = session.purchaseFlow;
      const productForVar = getLoadedProductById(session, pfVar.productId) || session.currentProduct;
      const varAttrOptions = productForVar?.secondaryAttributes?.find(
        (a) => a.name === pfVar.variantAttributeName
      )?.options || [];
      const chosenVar = matchVariant(String(action.payload || ''), varAttrOptions);
      if (!chosenVar) {
        await zapi.sendText(phone, `❌ Variante "${action.payload}" não reconhecida.`);
        if (varAttrOptions.length > 0) await sendVariantList(phone, { name: pfVar.variantAttributeName, options: varAttrOptions }, session);
        return;
      }
      pfVar.selectedVariant = chosenVar;
      pfVar.state = 'awaiting_size';
      await sendStockAwareSizeList(phone, session, productForVar, pfVar.interactiveVersion);
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
      const { productIdx, cartItemIdx, size, qty } = action.payload || {};
      let product;
      let resolvedSize = size ? String(size).toUpperCase().trim() : null;

      if (cartItemIdx) {
        // Referência ao carrinho: resolve pelo índice do item (1-indexed)
        const cartItem = session.items?.[cartItemIdx - 1];
        if (!cartItem) {
          await zapi.sendText(phone, `❌ Item #${cartItemIdx} não encontrado no carrinho.`);
          return;
        }
        product = await ensureProductStockData(await resolveProductById(session, cartItem.productId));
        if (!resolvedSize) resolvedSize = cartItem.size; // usa o tamanho existente se não especificado
      } else {
        // Referência ao catálogo: resolve pelo índice de produto (1-indexed)
        // Fallback: produto em foco na FSM (quando IA omite productIdx em awaiting_size)
        const pf = session.purchaseFlow;
        product = await ensureProductStockData(
          (productIdx ? session.products?.[productIdx - 1] : null) ||
          getLoadedProductById(session, pf?.productId) ||
          session.currentProduct
        );
      }

      if (!product) {
        await zapi.sendText(phone, `❌ Produto não encontrado na lista atual.`);
        return;
      }

      const availableSizes = getAvailableSizesForSession(session, product);
      const matchedSize = availableSizes.find(s => s.toUpperCase().trim() === resolvedSize);
      if (!matchedSize) {
        let msg = `⚠️ Tamanho "${resolvedSize}" não disponível para *${product.name}*.`;
        if (availableSizes.length > 0) msg += `\nTamanhos disponíveis: ${availableSizes.join(' | ')}`;
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

      // Envia foto do produto para confirmação visual
      if (product.imageUrl) {
        await zapi.sendProductShowcase(phone, product, pf.interactiveVersion);
      }
      break;
    }

    case 'HANDOFF': {
      const intercepted = await handleQueueGuard(phone, 'cart_finalize', session);
      if (!intercepted) {
        await handoffToConsultant(phone, session);
      }
      break;
    }

    case 'SKIP_MORE': {
      const hadNext = await processNextInQueue(phone, session);
      if (!hadNext) {
        await sendCartOptions(phone, session, '😊 Fila vazia! Quer revisar o carrinho ou finalizar?');
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
      logger.info({ phone }, '[Loading TTS] Iniciando síntese');
      const { buffer, mimeType } = await tts.textToSpeech(ttsPhrase);
      logger.info({ phone, bufferLength: buffer.length }, '[Loading TTS] Áudio recebido, enviando');
      await zapi.sendAudio(phone, buffer, mimeType);
      logger.info({ phone }, '[Loading TTS] Áudio enviado com sucesso');
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
  if (loaded) {
    logger.debug({ productId }, '[ProductResolve] Produto encontrado em session');
    return await ensureProductStockData(loaded);
  }

  logger.debug({ productId, sessionProductCount: session.products?.length || 0 }, '[ProductResolve] Produto não está em session, buscando na API WooCommerce');

  try {
    const fetched = await woocommerce.getProductById(productId);
    if (fetched) {
      logger.info({ productId: fetched.id, productName: fetched.name }, '[ProductResolve] Produto resolvido via API WooCommerce');
    } else {
      logger.warn({ productId }, '[ProductResolve] API WooCommerce retornou null para este ID');
    }
    return fetched ? await ensureProductStockData(fetched) : null;
  } catch (err) {
    logger.error({ productId, err: err?.message || String(err), stack: err?.stack }, '[ProductResolve] Falha ao buscar produto por ID na API');
    return null;
  }
}

function getReservedCartQuantity(session, productId, size) {
  if (!Array.isArray(session?.items) || !productId || !size) return 0;

  return session.items.reduce((acc, item) => {
    const sameProduct = String(item.productId) === String(productId);
    const sameSize = normalizeSizeValue(item.size) === normalizeSizeValue(size);
    return sameProduct && sameSize ? acc + (parseInt(item.quantity, 10) || 0) : acc;
  }, 0);
}

async function ensureProductStockData(product, variantFilter = null) {
  if (!product) return null;
  await woocommerce.enrichProductWithStock(product, variantFilter);
  return product;
}

/**
 * Returns the variantFilter object from purchaseFlow, or null if no variant is selected.
 */
function getVariantFilter(session) {
  const pf = session?.purchaseFlow;
  if (!pf?.selectedVariant || !pf?.variantAttributeName) return null;
  return { name: pf.variantAttributeName, value: pf.selectedVariant };
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

function getProductShowcaseMessageId(session, product) {
  if (!session || !product?.id) return null;
  const map = session.productShowcaseMessageId || {};
  return map[product.id] || map[String(product.id)] || null;
}

async function sendStockAwareSizeList(phone, session, product, version, excludeSizes = []) {
  const stockProduct = await ensureProductStockData(product, getVariantFilter(session));
  if (!stockProduct) return false;

  const sizeDetails = buildSessionSizeDetails(session, stockProduct);
  const availableSizes = sizeDetails.filter((detail) => detail.isAvailable !== false);

  if (availableSizes.length === 0) {
    logger.warn({ phone, product: product?.name }, '[FSM] sendStockAwareSizeList chamada sem tamanhos disponíveis');
  }

  const variantFilter = getVariantFilter(session);
  const productForList = {
    ...stockProduct,
    sizeDetails,
    sizes: availableSizes.map((detail) => detail.size),
    variantLabel: variantFilter?.value || null,
  };

  await zapi.sendSizeList(
    phone,
    productForList,
    version,
    excludeSizes,
    true,
    getProductShowcaseMessageId(session, productForList)
  );
  return availableSizes.length > 0;
}

async function sendStockAwareQuantityList(phone, session, size, version, product = null) {
  const stockProduct = await ensureProductStockData(
    product || getLoadedProductById(session, session.purchaseFlow?.productId) || session.currentProduct,
    getVariantFilter(session)  // garante que "Disponível: N" reflita apenas a variante selecionada
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

  await zapi.sendQuantityList(phone, size, version, availableQty, true);
}

async function sendStockAwareSizeQtyList(phone, session, product, version) {
  const stockProduct = await ensureProductStockData(product, getVariantFilter(session));
  if (!stockProduct) return;
  const sizeDetails = buildSessionSizeDetails(session, stockProduct);
  await zapi.sendSizeQuantityList(
    phone,
    stockProduct,
    version,
    sizeDetails,
    getProductShowcaseMessageId(session, stockProduct)
  );
}

/**
 * Envia lista interativa para escolha de variante (ex: Mãe/Filha).
 * Usa botão Z-API (send-option-list) — fallback para texto se falhar.
 * @param {string} phone
 * @param {{ name: string, options: string[] }} attr
 * @param {object} session - sessão da FSM (para interactiveVersion e productName)
 */
async function sendVariantList(phone, attr, session = null) {
  const version = session?.purchaseFlow?.interactiveVersion || Date.now();
  const productForCard = session
    ? (getLoadedProductById(session, session.purchaseFlow?.productId) || session.currentProduct)
    : null;

  // ── Filtrar opções por estoque (variantSizes) ────────────────────────────
  let availableOptions = attr.options;
  if (productForCard && session) {
    if (!productForCard.variantSizes) {
      await ensureProductStockData(productForCard); // sem filtro → popula variantSizes
    }
    if (productForCard.variantSizes) {
      const blacklist = session.purchaseFlow?._variantBlacklist || [];
      availableOptions = attr.options.filter(
        opt => !blacklist.includes(opt) && (productForCard.variantSizes[opt]?.length ?? 0) > 0
      );
      logger.info({ phone, all: attr.options, available: availableOptions, blacklist }, '[FSM/Variant] Opções filtradas por estoque + blacklist');
    }

    if (availableOptions.length === 0) {
      await zapi.sendText(phone, `No momento *${productForCard.name}* está sem tamanhos disponíveis em nenhuma versão. 😔`);
      return;
    }

    if (availableOptions.length === 1) {
      const autoVariant = availableOptions[0];
      logger.info({ phone, autoVariant }, '[FSM/Variant] Auto-selecionando única variante com estoque');
      // Só avisa "Só temos X" se o produto tinha múltiplas variantes originais
      // (ex: Mãe + Filha mas só Filha tem estoque). Se o produto já tem uma única
      // variante, a mensagem é redundante e confunde o cliente.
      if (attr.options.length > 1) {
        await zapi.sendText(phone, `Só temos *${autoVariant}* disponível no momento 😊 Veja os tamanhos:`);
      }
      await tryAdvanceToSize(phone, session, autoVariant);
      return;
    }
  }

  const filteredAttr = { ...attr, options: availableOptions };
  try {
    if (productForCard?.imageUrl) {
      await zapi.sendVariantButtonCard(phone, productForCard, filteredAttr, version);
    } else {
      const productName = session?.purchaseFlow?.productName || 'este produto';
      await zapi.sendVariantOptionList(
        phone,
        filteredAttr,
        version,
        productName,
        getProductShowcaseMessageId(session, productForCard)
      );
    }
  } catch {
    const opts = availableOptions.map((o, i) => `${i + 1}. *${o}*`).join('\n');
    await zapi.sendText(phone, `Qual versão você quer comprar?\n\n${opts}\n\n_Responda com o nome ou o número 😊_`);
  }
}

/**
 * Tenta avançar a FSM de awaiting_variant → awaiting_size para a variante escolhida.
 * Verifica estoque antes de transicionar. Se a variante não tem tamanhos,
 * mantém o estado em awaiting_variant e re-envia o card de seleção.
 *
 * @returns {boolean} true se avançou para awaiting_size, false se ficou em awaiting_variant
 */
async function tryAdvanceToSize(phone, session, chosenVariant) {
  const pf = session.purchaseFlow;
  pf.selectedVariant = chosenVariant; // temporário — getVariantFilter precisa disso

  const product = getLoadedProductById(session, pf.productId) || session.currentProduct;
  const enriched = await ensureProductStockData(product, getVariantFilter(session));
  const availableSizes = getAvailableSizesForSession(session, enriched || product);

  if (availableSizes.length === 0) {
    // Sem estoque → reverter selectedVariant
    pf.selectedVariant = null;

    // [Fix loop infinito] Blacklist persistente no purchaseFlow: ensureProductStockData
    // re-popula variantSizes a cada chamada (dados do WooCommerce), desfazendo o zeroing.
    // A blacklist sobrevive entre chamadas e impede re-tentativa da mesma variante.
    if (!Array.isArray(pf._variantBlacklist)) pf._variantBlacklist = [];
    if (!pf._variantBlacklist.includes(chosenVariant)) {
      pf._variantBlacklist.push(chosenVariant);
    }
    logger.info({ phone, chosenVariant, blacklist: pf._variantBlacklist }, '[FSM/Variant] Variante sem estoque real — adicionada à blacklist');

    const productRef = enriched || product;
    const variantAttr = productRef?.secondaryAttributes?.find(a => a.name === pf.variantAttributeName);

    // Filtra variantes já testadas (blacklist) + sem estoque em variantSizes
    const otherOptions = variantAttr
      ? variantAttr.options.filter((opt) => {
          if (pf._variantBlacklist.includes(opt)) return false;
          return (productRef?.variantSizes?.[opt]?.length ?? 0) > 0;
        })
      : [];

    if (otherOptions.length === 0) {
      // Nenhuma outra variante com estoque — produto esgotado completamente
      pf.state = 'idle';
      pf._variantBlacklist = []; // limpa para próxima interação
      logger.info({ phone, chosenVariant, product: pf.productName }, '[FSM/Variant] Todas as variantes sem estoque → idle');
      await zapi.sendText(phone, `Infelizmente *${pf.productName}* está sem estoque em todos os tamanhos no momento. 😔`);
    } else {
      pf.state = 'awaiting_variant';
      logger.info({ phone, chosenVariant, otherOptions, product: pf.productName }, '[FSM/Variant] Sem estoque — mantendo awaiting_variant');
      await zapi.sendText(phone, `⚠️ *${chosenVariant}* está sem tamanhos disponíveis no momento. Escolha outra versão:`);
      if (variantAttr) await sendVariantList(phone, { ...variantAttr, options: otherOptions }, session);
    }
    persistSession(phone);
    return false;
  }

  // Tem estoque → se único tamanho disponível, pular lista e ir direto para quantidade
  if (availableSizes.length === 1) {
    pf.state = 'awaiting_quantity';
    pf.selectedSize = availableSizes[0];
    pf.interactiveVersion = Date.now();
    logger.info({ phone, chosenVariant, size: pf.selectedSize, product: pf.productName }, '[FSM/Variant] Único tamanho disponível → skip para quantidade');
    await sendStockAwareQuantityList(phone, session, pf.selectedSize, pf.interactiveVersion, enriched || product);
  } else {
    pf.state = 'awaiting_size';
    await sendStockAwareSizeList(phone, session, enriched || product, pf.interactiveVersion);
  }
  persistSession(phone);
  return true;
}

/**
 * Adiciona um item ao carrinho silenciosamente (sem mensagem, sem menu).
 * Usado pelo grade parser para batch insert antes de enviar uma confirmação consolidada.
 */
function pushCartItem(session, productId, productName, size, qty, unitPrice, imageUrl = null, variant = null) {
  if (!productId || !size || !qty || qty < 1) return;

  const existingIdx = session.items.findIndex(
    it => it.productId === productId && it.size === size && (it.variant || null) === (variant || null)
  );
  if (existingIdx >= 0) {
    const existing = session.items[existingIdx];
    existing.quantity += qty;
    const resolvedUnitPrice = existing.unitPrice || unitPrice || 0;
    existing.unitPrice = resolvedUnitPrice;
    existing.price = resolvedUnitPrice * existing.quantity;
    if (imageUrl && !existing.imageUrl) existing.imageUrl = imageUrl;
  } else {
    session.items.push({ productId, productName, size, variant: variant || null, quantity: qty, unitPrice, price: unitPrice * qty, imageUrl });
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

  // Guard: cliente está em meio à confirmação de uma grade composta. Adicionar
  // itens novos pode confundir o plano em curso. Pede pra resolver compound antes.
  if (session.awaitingCompoundConfirmation &&
      session.compoundConfirmationExpiresAt &&
      Date.now() < session.compoundConfirmationExpiresAt) {
    await zapi.sendText(phone, '⏸️ Tô esperando você confirmar aquela grade que mandei (responde "sim" ou "não" amor 😊).');
    return false;
  }

  if (!pf.productId || !pf.selectedSize) {
    await zapi.sendText(phone, '❌ Nenhum produto/tamanho em foco. Escolha um produto primeiro.');
    return false;
  }

  const selectedSize = pf.selectedSize;
  const productRef = await ensureProductStockData(
    getLoadedProductById(session, pf.productId) || session.currentProduct || await resolveProductById(session, pf.productId),
    getVariantFilter(session)  // valida estoque da variante correta — impede sobrevenda (ex: Mãe-M vs total-M)
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
  const selectedVariant = pf.selectedVariant || null;

  const existingIdx = session.items.findIndex(
    it => it.productId === pf.productId && it.size === selectedSize && (it.variant || null) === selectedVariant
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
      variant: selectedVariant,
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

  const confirmMsg = `✅ *${pf.productName}* (${selectedSize}) x${qty} adicionado!`;

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

  // [UX-SILENT-ADD / ADR-035] Bot silencioso após adição bem-sucedida.
  // Nenhuma confirmação textual nem menu são enviados agora.
  // O resumo do carrinho é disparado automaticamente após 30s de inatividade.
  // ⚠️ Não restaurar sendPostAddMenu ou processNextInQueue aqui — ver ADR-035.
  scheduleCartSummary(phone);

  return true;
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
    pf.queueGuardPending = false;
    const hadNext = await processNextInQueue(phone, session);
    if (!hadNext) {
      await sendCartOptions(phone, session, '😊 Fila vazia! Quer revisar o carrinho ou finalizar?');
    }
    return true;
  }

  // Usuário escolheu finalizar mesmo assim → limpa fila e encaminha handoff
  if (eventId === 'queue_finalize_anyway') {
    logger.info({ phone, discarded: queueLength }, '[QueueGuard] Cliente optou finalizar ignorando fila');
    pf.queueGuardPending = false;
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

    // Marca que estamos aguardando resposta do guard — usado pelo fallback
    // de TEXTO/áudio: se o lojista responde "fecha com esses mesmo" por texto
    // em vez de clicar no botão, o webhook intercepta antes de cair na IA.
    pf.queueGuardPending = true;
    logger.info({ phone, queueLength }, '[QueueGuard] Avisando sobre fila pendente');
    await zapi.sendOptionList(phone, warningMsg, 'Fila Pendente', 'Escolher', options);
    return true;
  }

  return false;
}

/**
 * Interpretação por texto da resposta ao guard de fila.
 * Retorna:
 *   'finalize' — cliente quer finalizar ignorando a fila
 *   'continue' — cliente quer continuar separando a fila
 *   null — texto ambíguo, deixa a IA resolver
 */
function interpretQueueGuardAnswer(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return null;

  // "finalizar mesmo", "fecha com esses", "pode fechar", "só isso", "ignora a fila",
  // "manda pra atendente", "encerra", "chega", "tá bom assim", "é só isso mesmo"
  const finalizeRe = /\b(fecha(r)?|finaliza(r|ndo)?|encerra(r)?|só isso|so isso|chega|tá bom assim|ta bom assim|é isso|e isso|pode fechar|manda|encaminha|passa pra|passa para|atendente|vendedora|consultor|ignora|deixa (a )?fila|sem (a )?fila|com esses? mesm[oa]|com o que (tenho|tem))\b/;
  if (finalizeRe.test(t)) return 'finalize';

  // "sim separar", "vou ver a fila", "separa sim", "processa a fila"
  const continueRe = /\b(separa(r)?|continua(r)?|processa(r)?|ve(r|ja)? a fila|vou ver|vamos (ver|separar)|fila sim|sim (a )?fila|pega (os|o) (produto|restante))\b/;
  if (continueRe.test(t)) return 'continue';

  // Respostas puras sim/não: na dúvida, "sim" = separar a fila (é o que ela perguntou);
  // "não" = finalizar mesmo. É assim que a pergunta foi feita: "Quer separar esses antes de fechar o pedido?"
  if (/^(sim|s|yes|quero|isso|aham|uhum)\b/.test(t)) return 'continue';
  if (/^(n[aã]o|nao|n|nah|nope|nops)\b/.test(t)) return 'finalize';

  return null;
}

/**
 * Intercepta eventos buy_ e os bufferiza por 15s (debounce).
 * Enquanto o cliente continua clicando em "Separar", o timer é resetado.
 * Ao expirar 15s sem novos cliques, dispara flushBuyDebounce.
 */
async function addToBuyDebounce(phone, eventId, session) {
  // buy_{id}  ou  buy_variant_{id}_{opt}
  let productId;
  let showcaseVariantOpt = null;
  if (eventId.startsWith('buy_variant_')) {
    const withoutPrefix = eventId.slice('buy_variant_'.length); // "{id}_{opt}"
    const firstUnderscore = withoutPrefix.indexOf('_');
    productId = parseInt(firstUnderscore >= 0 ? withoutPrefix.slice(0, firstUnderscore) : withoutPrefix, 10);
    showcaseVariantOpt = firstUnderscore >= 0 ? withoutPrefix.slice(firstUnderscore + 1) : null;
  } else {
    productId = parseInt(eventId.split('_')[1], 10);
  }
  const product = await resolveProductById(session, productId);

  if (!product) {
    await zapi.sendText(phone, '❌ Não consegui localizar esse produto. Me chama no catálogo que te mostro de novo 😊');
    return;
  }

  let entry = buyDebounceBuffer.get(phone);
  if (!entry) {
    entry = { products: [], timer: null };
    buyDebounceBuffer.set(phone, entry);
  }

  // Deduplica por productId + variante escolhida
  if (!entry.products.some(p => p.id === product.id && (p._showcaseVariantOpt || null) === (showcaseVariantOpt || null))) {
    entry.products.push(showcaseVariantOpt ? { ...product, _showcaseVariantOpt: showcaseVariantOpt } : product);
  }

  // Reseta o timer a cada novo clique
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    flushBuyDebounce(phone).catch(err =>
      logger.error({ phone, err: err?.message }, '[BuyDebounce] flushBuyDebounce rejeitou fora do try-catch')
    );
  }, 15_000);

  logger.info({ phone, productId: product.id, buffered: entry.products.length }, '[BuyDebounce] Produto bufferizado, timer resetado');
}

/**
 * Executa quando o timer de 15s expira sem novos buy_ events.
 * Processa todos os produtos bufferizados de uma vez.
 */
async function flushBuyDebounce(phone) {
  const entry = buyDebounceBuffer.get(phone);
  buyDebounceBuffer.delete(phone);
  if (!entry || entry.products.length === 0) return;

  logger.info({ phone, buffered: entry.products.length }, '[BuyDebounce] flushBuyDebounce iniciado');

  try {
    const session = await getSession(phone);
    const pf = session.purchaseFlow;
    const [first, ...rest] = entry.products;

    logger.info({ phone, state: pf.state, itemsLen: session.items?.length }, '[BuyDebounce] processando flush');

    if (pf.state === 'idle' || !pf.productId) {
      // FSM livre: inicia com o primeiro, enfileira o resto silenciosamente
      if (!Array.isArray(pf.buyQueue)) pf.buyQueue = [];
      for (const p of rest) {
        const selectedVariant = p._showcaseVariantOpt || null;
        const alreadyQueued = pf.buyQueue.some(q =>
          q.productId === p.id && (q.selectedVariant || null) === selectedVariant
        );
        if (!alreadyQueued) {
          const queueEntry = { productId: p.id, productName: p.name, productSnapshot: p };
          if (selectedVariant) queueEntry.selectedVariant = selectedVariant;
          pf.buyQueue.push(queueEntry);
        }
      }
      if (first._showcaseVariantOpt) {
        await startInteractivePurchase(phone, first, session, null, true);
        await tryAdvanceToSize(phone, session, first._showcaseVariantOpt);
      } else {
        await startInteractivePurchase(phone, first, session);
      }
    } else {
      // FSM ocupada: produtos diferentes vão para a fila em silêncio.
      // Variante (cor/opção) DO PRODUTO ATUAL → roteia para handlePurchaseFlowEvent,
      // caso contrário a seleção da cliente seria descartada silenciosamente
      // (ex.: clicar em "ROSE" no card do produto que a FSM já está processando).
      if (!Array.isArray(pf.buyQueue)) pf.buyQueue = [];
      for (const p of entry.products) {
        const selectedVariant = p._showcaseVariantOpt || null;

        // Variante do produto que a FSM já está processando → handler de eventos
        if (String(p.id) === String(pf.productId) && selectedVariant) {
          logger.info(
            { phone, productId: p.id, variant: selectedVariant },
            '[BuyDebounce] variante do produto atual — roteando para handlePurchaseFlowEvent'
          );
          await handlePurchaseFlowEvent(
            phone,
            `buy_variant_${p.id}_${selectedVariant}`,
            session
          );
          continue;
        }

        const alreadyQueued = pf.buyQueue.some(q =>
          q.productId === p.id && (q.selectedVariant || null) === selectedVariant
        );
        if (String(p.id) !== String(pf.productId) && !alreadyQueued) {
          const queueEntry = { productId: p.id, productName: p.name, productSnapshot: p };
          if (selectedVariant) queueEntry.selectedVariant = selectedVariant;
          pf.buyQueue.push(queueEntry);
        }
      }
    }

    persistSession(phone);
  } catch (err) {
    logger.error({ phone, err }, '[BuyDebounce] Erro ao processar flush');
  }
}

/**
 * Gerencia eventos interativos (botões e listas) da FSM de compra.
 * Prefixos tratados: buy_ | size_ | qty_ | add_size_ | skip_more_ |
 *                   confirm_add_ | show_qty_ | skip_product_
 */
async function handlePurchaseFlowEvent(phone, eventId, session) {
  const pf = session.purchaseFlow;

  // Opções do guard de fila chegam como cliques interativos e precisam ser
  // tratadas antes da FSM principal.
  if (eventId === 'queue_continue' || eventId === 'queue_finalize_anyway') {
    await handleQueueGuard(phone, eventId, session);
    return;
  }

  // ── skip_product_v{version} ────────────────────────────────────────────
  if (eventId.startsWith('skip_product_')) {
    await skipCurrentProduct(phone, session);
    return;
  }

  // ── confirm_add_v{version} — tamanho único: adicionar 1 unidade ──────────
  // Disparado pelo botão "✅ Sim, adicionar" de sendSingleSizeConfirm.
  // selectedSize já está definido como 'ÚNICO' na sessão — addToCart usa direto.
  if (eventId.startsWith('confirm_add_')) {
    if (isStaleEvent(eventId, session)) {
      logger.info({ phone, eventId }, '[FSM] confirm_add_ expirado → ignorando');
      await zapi.sendText(phone, '⏱️ Esse menu expirou. Clique em *Separar Tamanho* no produto para recomeçar.');
      return;
    }
    logger.info({ phone }, '[FSM] confirm_add_ → addToCart(qty=1)');
    appendHistory(session, 'user', '[Confirmou adição de 1 unidade]');
    conversationMemory.refreshConversationMemory(session, { userText: '[Confirmou adição]' });
    await addToCart(phone, 1, session);
    persistSession(phone);
    return;
  }

  // ── show_qty_v{version} — tamanho único: reexibir lista de quantidade ────
  // Disparado pelo botão "🔢 Escolher quantidade" de sendSingleSizeConfirm.
  if (eventId.startsWith('show_qty_')) {
    if (isStaleEvent(eventId, session)) {
      logger.info({ phone, eventId }, '[FSM] show_qty_ expirado → ignorando');
      await zapi.sendText(phone, '⏱️ Esse menu expirou. Clique em *Separar Tamanho* no produto para recomeçar.');
      return;
    }
    const prodQty = await ensureProductStockData(getLoadedProductById(session, pf.productId) || session.currentProduct);
    if (!prodQty) {
      await zapi.sendText(phone, '❌ Produto não encontrado. Clique em *Separar Tamanho* para recomeçar.');
      return;
    }
    logger.info({ phone }, '[FSM] show_qty_ → sendStockAwareQuantityList');
    await sendStockAwareQuantityList(phone, session, pf.selectedSize, pf.interactiveVersion, prodQty);
    persistSession(phone);
    return;
  }

  // ── buy_variant_{productId}_{opt} ────────────────────────────────────────
  // Clique em botão de variante diretamente do showcase (ex: "Mãe" / "Filha").
  // DEVE vir antes do handler buy_ para evitar captura pelo startsWith('buy_').
  if (eventId.startsWith('buy_variant_')) {
    const withoutPrefix = eventId.slice('buy_variant_'.length); // "{productId}_{opt}"
    const firstUnderscore = withoutPrefix.indexOf('_');
    if (firstUnderscore < 0) {
      logger.warn({ phone, eventId }, '[FSM] buy_variant_ — formato inválido');
      return;
    }
    const showcaseProductId = withoutPrefix.slice(0, firstUnderscore);
    const showcaseVariantOpt = withoutPrefix.slice(firstUnderscore + 1);

    const showcaseProduct = await resolveProductById(session, showcaseProductId);
    if (!showcaseProduct) {
      await zapi.sendText(phone, '❌ Não consegui localizar esse produto. Me chama no catálogo que te mostro de novo 😊');
      return;
    }

    // Lógica de fila: mesma do buy_
    if (pf.state !== 'idle' && pf.productId && String(pf.productId) !== String(showcaseProductId)) {
      if (!Array.isArray(pf.buyQueue)) pf.buyQueue = [];
      const alreadyQueued = pf.buyQueue.some(q => String(q.productId) === String(showcaseProduct.id));
      if (!alreadyQueued) {
        pf.buyQueue.push({ productId: showcaseProduct.id, productName: showcaseProduct.name, productSnapshot: showcaseProduct });
        // [ADR-035 / UX-SILENT-ADD] Silêncio ao enfileirar — não interrompe o fluxo atual.
        // O produto será apresentado quando o timer de 60s disparar.
        logger.info({ phone, productId: showcaseProduct.id, queueLength: pf.buyQueue.length }, '[FSM] buy_variant_ — produto enfileirado silenciosamente');
      } else {
        // Silêncio: clique duplicado no mesmo produto (ex: Mãe e Filha são o mesmo productId).
        logger.debug({ phone, productId: showcaseProduct.id }, '[FSM] buy_variant_ — produto já enfileirado, ignorando silenciosamente');
      }
      return;
    }

    logger.info({ phone, productId: showcaseProduct.id, showcaseVariantOpt }, '[FSM] buy_variant_ → startInteractivePurchase + tryAdvanceToSize');
    pf.lastClickedProductId = showcaseProduct.id;
    pf.lastClickedProductName = showcaseProduct.name;
    pf.lastClickedProductTimestamp = Date.now();
    await startInteractivePurchase(phone, showcaseProduct, session, null, true); // skipVariantSend=true
    await tryAdvanceToSize(phone, session, showcaseVariantOpt);
    persistSession(phone);
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
        // [ADR-035 / UX-SILENT-ADD] Silêncio ao enfileirar — não interrompe o fluxo atual.
        logger.info({ phone, productId: product.id, queueLength: pf.buyQueue.length }, '[FSM] Produto enfileirado silenciosamente');
      } else {
        // Silêncio: clique duplicado no mesmo produto — sem mensagem para o cliente.
        logger.debug({ phone, productId: product.id }, '[FSM] buy_ — produto já enfileirado, ignorando silenciosamente');
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

  // ── sizeqty_{productId}_{size}_{qty}_v{version} ──────────────────────
  // Lista combinada tamanho+quantidade: uma interação fecha compra direto.
  if (eventId.startsWith('sizeqty_')) {
    const parsed = parseSizeQtyEvent(eventId);
    const isStaleSizeQty = isStaleEvent(eventId, session);
    const isSameFocusedProduct = parsed?.productIdStr && String(parsed.productIdStr) === String(pf.productId);
    const reusableSizeQtyStates = new Set(['awaiting_size', 'awaiting_more_sizes']);
    const canReuseFocusedProductList = isSameFocusedProduct && reusableSizeQtyStates.has(pf.state);

    if (isStaleSizeQty && !canReuseFocusedProductList) {
      logger.info({ phone, eventId }, '[FSM] sizeqty_ expirado → reenviando lista combinada');
      await zapi.sendText(phone, '⏱️ Esse menu expirou! Enviando a lista atualizada...');
      const staleProd = await ensureProductStockData(
        getLoadedProductById(session, pf.productId) || session.currentProduct
      );
      if (staleProd) await sendStockAwareSizeQtyList(phone, session, staleProd, Date.now());
      return;
    }

    if (isStaleSizeQty) {
      logger.info({ phone, eventId, productId: parsed.productIdStr }, '[FSM] sizeqty_ antigo do mesmo produto aceito');
    }

    const productIdStr = parsed?.productIdStr;
    const qty = parsed?.qty;
    const size = parsed?.size;

    const product = await ensureProductStockData(await resolveProductById(session, productIdStr));

    if (!product || !size || isNaN(qty) || qty < 1) {
      await zapi.sendText(phone, '❌ Não consegui identificar a seleção. Tenta de novo? 😊');
      return;
    }

    const clickedDifferentProduct = String(product.id) !== String(pf.productId);
    if (clickedDifferentProduct) {
      const { contextMessage: sizeqtyCtxMsg } = switchFsmFocus(session, product);
      // [ADR-035] Mesma regra: silêncio durante compra ativa
      if (sizeqtyCtxMsg && !session.items?.length) await zapi.replyText(phone, sizeqtyCtxMsg, messageId);
    }

    pf.productId = product.id;
    pf.productName = product.name;
    pf.price = parseFloat(product.salePrice || product.price);
    pf.selectedSize = size;

    logger.info({ phone, productId: product.id, size, qty }, '[FSM] sizeqty_ → addToCart direto');
    await addToCart(phone, qty, session);
    return;
  }

  // ── variant_v{version}_{valor} ───────────────────────────────────────
  // Clique no botão de variante (ex: Mãe / Filha) gerado por sendVariantOptionList.
  if (eventId.startsWith('variant_v')) {
    if (pf.state !== 'awaiting_variant') {
      // Recuperação: se o produto tem variantes e estamos em awaiting_size
      // (ex: variante anterior sem estoque), permitir re-seleção
      const recoveryProduct = getLoadedProductById(session, pf.productId) || session.currentProduct;
      const hasVariants = recoveryProduct?.secondaryAttributes?.length > 0;
      if (pf.state === 'awaiting_size' && hasVariants) {
        pf.state = 'awaiting_variant';
        logger.info({ phone, eventId }, '[FSM/Variant] Recuperando awaiting_size → awaiting_variant');
      } else {
        logger.warn({ phone, eventId, state: pf.state }, '[FSM] variant_ recebido fora de awaiting_variant — ignorando');
        return;
      }
    }

    if (isStaleEvent(eventId, session)) {
      logger.info({ phone, eventId }, '[FSM] variant_ expirado → reenviando lista de variantes');
      await zapi.sendText(phone, '⏱️ Esse menu expirou! Enviando as opções novamente...');
      const staleProduct = getLoadedProductById(session, pf.productId) || session.currentProduct;
      const staleAttr = staleProduct?.secondaryAttributes?.find((a) => a.name === pf.variantAttributeName);
      if (staleAttr) await sendVariantList(phone, staleAttr, session);
      return;
    }

    // Formato: variant_v{version}_{valor}  →  extrai valor depois de '_v{version}_'
    const vPrefixMatch = eventId.match(/^variant_v\d+_(.+)$/);
    const chosenVariant = vPrefixMatch?.[1] || null;

    if (!chosenVariant) {
      logger.warn({ phone, eventId }, '[FSM] variant_ — não foi possível extrair valor');
      return;
    }

    logger.info({ phone, chosenVariant, product: pf.productName }, '[FSM] variant_ → variante escolhida via botão');
    await tryAdvanceToSize(phone, session, chosenVariant);
    return;
  }

  // ── size_{productId}_{size}_v{version} ────────────────────────────────
  if (eventId.startsWith('size_')) {
    // Extrai productId do eventId ANTES do isStaleEvent para poder reenviar
    // o menu do produto correto (não o que está em foco na FSM).
    const _wp = eventId.slice('size_'.length);
    const _vIdx = _wp.lastIndexOf('_v');
    const _wv = _vIdx >= 0 ? _wp.slice(0, _vIdx) : _wp;
    const _fu = _wv.indexOf('_');
    const eventProductId = _fu >= 0 ? _wv.slice(0, _fu) : null;

    if (isStaleEvent(eventId, session)) {
      const staleProd = await ensureProductStockData(
        (eventProductId && await resolveProductById(session, eventProductId))
        || getLoadedProductById(session, pf.productId)
        || session.currentProduct
      );
      logger.info({ phone, eventId }, '[FSM] size_ expirado → reenviando menu de tamanhos');
      await zapi.sendText(phone, '⏱️ Esse menu expirou! Enviando a lista de tamanhos atualizada...');
      if (staleProd) {
        const staleExcludes = String(staleProd.id) === String(pf.productId) ? (pf.addedSizes || []) : [];
        await sendStockAwareSizeList(phone, session, staleProd, pf.interactiveVersion, staleExcludes);
      }
      return;
    }
    // Formato: size_422_P_v1234567890  →  remove prefixo e sufixo de versão
    const withoutPrefix = eventId.slice('size_'.length);              // '422_P_v1234567890'
    const vIdx = withoutPrefix.lastIndexOf('_v');
    const withoutVersion = vIdx >= 0 ? withoutPrefix.slice(0, vIdx) : withoutPrefix;  // '422_P'
    const firstUnderscore = withoutVersion.indexOf('_');
    const productIdStr = withoutVersion.slice(0, firstUnderscore);    // '422'
    const size = withoutVersion.slice(firstUnderscore + 1);           // 'P'

    // ADR-022 (reply é cursor): o eventId carrega o productId do card clicado.
    // SEMPRE resolver por esse ID (inclusive buscando no Woo se evict da lista).
    // NUNCA cair para pf.productId — isso causava o bug onde o bot validava o
    // tamanho contra o produto em foco e não contra o produto do card clicado.
    const product = await ensureProductStockData(
      await resolveProductById(session, productIdStr)
    );

    if (!product || !size) {
      await zapi.sendText(phone, '❌ Não consegui identificar o tamanho. Tenta de novo?');
      if (product) await sendStockAwareSizeList(phone, session, product, pf.interactiveVersion || Date.now(), []);
      return;
    }

    // Se o cliente clicou em tamanho de OUTRO produto (reply em card antigo),
    // troca o foco da FSM — preserva o produto anterior na buyQueue via
    // switchFsmFocus (ADR-022) e reseta addedSizes para o novo produto.
    const clickedDifferentProduct = String(product.id) !== String(pf.productId);
    if (clickedDifferentProduct) {
      logger.info(
        { phone, oldProductId: pf.productId, newProductId: product.id, size },
        '[FSM] size_ de outro produto → switchFsmFocus antes da validação'
      );
      const { contextMessage: sizeCtxMsg } = switchFsmFocus(session, product);
      if (sizeCtxMsg) await zapi.replyText(phone, sizeCtxMsg, messageId);
    }

    const availableSizes = getAvailableSizesForSession(session, product, pf.addedSizes || []);

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

/**
 * Processa o próximo item da `buyQueue`, avançando a FSM para o produto seguinte.
 *
 * Chamado por:
 *  - `addToCart` quando a grade do produto atual está completa e há fila
 *  - `handleQueueGuard` quando o cliente confirma "Sim, separar a fila"
 *  - `skipCurrentProduct` quando o cliente pula o produto em foco
 *
 * Invariante crítica — `session.currentProduct` DEVE ser atualizado aqui.
 * Sem isso, `switchFsmFocus` cai no fallback errado e re-enfileira o produto
 * anterior (bug: "pulou para a terceira peça"). Ver ADR-029.
 *
 * Sequência de mensagens enviada (UX-RULE-002):
 *   1. Texto intro + válvula de escape ("pode digitar M 2, G 1 etc.")
 *   2. Foto do produto (`sendProductShowcase`)
 *   3. Lista de tamanho+quantidade (`sendStockAwareSizeQtyList`)
 */
async function processNextInQueue(phone, session, replyToMessageId = null) {
  const pf = session.purchaseFlow;
  if (!pf.buyQueue || pf.buyQueue.length === 0) return false;

  const next = pf.buyQueue.shift();
  const product = await ensureProductStockData(next.productSnapshot || await resolveProductById(session, next.productId));

  if (!product) {
    logger.warn({ phone, productId: next.productId }, '[FSM] Produto da fila não encontrado, pulando');
    // Tenta o próximo da fila recursivamente
    return processNextInQueue(phone, session, replyToMessageId);
  }

  pf.productId = product.id;
  pf.productName = product.name;
  pf.price = parseFloat(product.salePrice || product.price);
  pf.selectedSize = null;
  // Reset variant — próximo produto pode ter variante diferente
  pf.selectedVariant = null;
  pf.variantAttributeName = null;
  // Reset commit source — novo produto começa sem herança de estado do anterior.
  // Sem isso, lastCommitSource='text' do produto anterior vaza e faz switchFsmFocus
  // tratar o produto da fila como "já fechado via texto" ao ser interrompido.
  pf.lastCommitSource = null;
  // Restaura tamanhos já adicionados do snapshot (lojista pode ter adicionado alguns antes de ser interrompido)
  pf.addedSizes = Array.isArray(next.addedSizes) ? [...next.addedSizes] : [];
  pf.interactiveVersion = Date.now();
  pf.lastClickedProductId = product.id;
  pf.lastClickedProductName = product.name;
  pf.lastClickedProductTimestamp = Date.now();
  // CRÍTICO: manter session.currentProduct sincronizado com o produto em foco na FSM.
  // Sem isso, switchFsmFocus cai no fallback session.currentProduct (produto anterior)
  // e re-enfileira o produto errado quando o cliente dá reply em card antigo.
  session.currentProduct = product;

  // Se o produto tem segundo eixo de variação (ex: Mãe/Filha), pede a escolha antes do tamanho
  const nextSecondaryAttr = product.secondaryAttributes?.[0];
  if (nextSecondaryAttr) {
    pf.state = 'awaiting_variant';
    pf.variantAttributeName = nextSecondaryAttr.name;
  } else {
    pf.state = 'awaiting_size';
  }

  logger.info({ phone, productId: product.id, queueRemaining: pf.buyQueue.length, restoredSizes: pf.addedSizes, needsVariant: !!nextSecondaryAttr }, '[FSM] Processando próximo da fila');

  // [UX-RULE-002] Ao avançar para o próximo produto da fila, enviar texto
  // introdutório com instrução da VÁLVULA DE ESCAPE (digitação livre) ANTES
  // da foto e da lista interativa. Não remover: a lista pode não aparecer em
  // todos os dispositivos, e o cliente precisa saber que pode digitar.
  const queueLeft = pf.buyQueue.length;
  const queueHint = queueLeft > 0 ? ` (ainda ${queueLeft} na fila depois desse)` : '';
  const introText = `Agora vamos para *${product.name}*${queueHint} 😊\n\n_Escolha pela lista ou *digite direto* (ex: M 2, G 1, P 3)_`;
  if (replyToMessageId) {
    await zapi.replyText(phone, introText, replyToMessageId);
  } else {
    await zapi.sendText(phone, introText);
  }
  // [Fix ADR-035] Envia foto sem botão "Separar Tamanho" — evita confusão de re-enfileirar.
  // O grade prompt abaixo já é o ponto de entrada; o botão buy_ é redundante e confuso aqui.
  const PIX_DISCOUNT = parseFloat(process.env.PIX_DISCOUNT_PCT || '10') / 100;
  const showcaseBase = parseFloat(product.salePrice || product.price);
  const showcasePix  = showcaseBase * (1 - PIX_DISCOUNT);
  const showcaseFmt  = v => `R$ ${v.toFixed(2).replace('.', ',')}`;
  const showcasePriceLine = `💰 *PIX: ${showcaseFmt(showcasePix)}*\n💳 Cartão: ${showcaseFmt(showcaseBase)}`;
  // Usa estoque real (sizeDetails) pois o produto já foi enriquecido via ensureProductStockData acima
  // Se o produto tem variantSizes (Mãe/Filha), exibe tamanhos por variante
  let showcaseSizeLine = '';
  if (product.variantSizes && Object.keys(product.variantSizes).length > 0) {
    showcaseSizeLine = '\n' + Object.entries(product.variantSizes)
      .filter(([, sizes]) => sizes.length > 0)
      .map(([variant, sizes]) => `📏 *${variant}:* ${sizes.join(' | ')}`)
      .join('\n');
  } else {
    const showcaseSizes = getAvailableSizesForSession(session, product, []).filter(s => s !== 'ÚNICO');
    if (showcaseSizes.length > 0) showcaseSizeLine = `\n📏 Disponível: *${showcaseSizes.join(' | ')}*`;
  }
  const showcaseCaption = `✨ *${product.name}*\n${showcasePriceLine}${showcaseSizeLine}`;
  let showcaseMessageId = null;
  if (product.imageUrl) {
    const imgRes = await zapi.sendImage(phone, product.imageUrl, showcaseCaption);
    showcaseMessageId = imgRes?.data?.messageId || imgRes?.data?.zaapId || null;
  } else {
    const textRes = await zapi.sendText(phone, showcaseCaption);
    showcaseMessageId = textRes?.data?.messageId || textRes?.data?.zaapId || null;
  }
  if (showcaseMessageId) {
    session.productShowcaseMessageId = session.productShowcaseMessageId || {};
    session.productShowcaseMessageId[product.id] = showcaseMessageId;
  }
  if (nextSecondaryAttr && next.selectedVariant) {
    await tryAdvanceToSize(phone, session, next.selectedVariant);
  } else if (nextSecondaryAttr) {
    await sendVariantList(phone, nextSecondaryAttr, session);
  } else {
    await sendStockAwareSizeQtyList(phone, session, product, pf.interactiveVersion);
  }
  return true;
}

// Pula o produto atual da FSM sem cancelar o fluxo inteiro nem limpar a buyQueue
async function skipCurrentProduct(phone, session) {
  const pf = session.purchaseFlow;
  const skippedName = pf.productName || 'produto';

  pf.state = 'idle';
  pf.productId = null;
  pf.productName = null;
  pf.selectedSize = null;
  pf.addedSizes = [];
  pf.selectedVariant = null;
  pf.variantAttributeName = null;
  pf.interactiveVersion = Date.now();

  logger.info({ phone, skippedName, queueLength: pf.buyQueue.length }, '[FSM] skipCurrentProduct');

  if (pf.buyQueue.length > 0) {
    await zapi.sendText(phone, `Ok, pulei *${skippedName}*! Próximo da fila: 👇`);
    await processNextInQueue(phone, session);
  } else {
    await zapi.sendText(phone, `Ok, pulei *${skippedName}*! 😊 Se quiser, me diga o que mais procura ou veja seu carrinho.`);
  }
}

/**
 * Monta o resumo textual do carrinho para exibição ao cliente.
 *
 * Formato: itens numerados (1. Nome (tamanho) xQty — R$ X,XX) + total.
 * O hint de remoção `_Para remover, responda: "remover 1"_` é INTENCIONAL
 * e deve permanecer — é a valid instruçao para a válvula de escape do menu
 * "Remover Item" (UX-RULE-003). Não remover.
 */
/**
 * Normaliza o campo size/variant para exibição em linha única.
 * Dados vindos de grade multi-variante (ex: "Mãe e Filha") podem ter quebras
 * de linha e formatadores markdown (`_texto_`) que sujam o resumo.
 * Aqui colapsamos para algo escaneável: "_Mãe_ 1m · 3g · 4gg | _Filha_ 3m · 2g · 2exgg"
 */
function normalizeCartLabel(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\s*\n+\s*/g, ' · ')   // quebras de linha viram separadores
    .replace(/·\s*·/g, '·')          // colapsa separadores duplos
    .replace(/\s{2,}/g, ' ')
    .replace(/·\s*$/g, '')
    .trim();
}

/**
 * Extrai a(s) referência(s) do nome do produto como chave canônica para
 * agrupamento no resumo do cliente (atacado B2B). Captura "Ref XXX" isolado
 * ou encadeado com " e Ref YYY" (ex: "Ref 604DTF e Ref 704DTF" vira uma
 * chave única — SKU diferente de "Ref 604DTF" sozinha).
 */
function extractRefKey(name) {
  if (!name) return null;
  const matches = String(name).match(/Ref\s+[\w./-]+(?:\s+e\s+Ref\s+[\w./-]+)*/gi);
  if (!matches || matches.length === 0) return null;
  return matches.join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Remove sufixo de variante (cor, estampa) que vem após a(s) Ref(s) no
 * nome. Usado só no resumo do cliente: "Conjunto sem bojo - Ref 420L MARINHO"
 * vira "Conjunto sem bojo - Ref 420L". No bloco admin mantemos o nome completo.
 */
function stripVariantSuffix(name) {
  const m = String(name || '').match(/^(.*?Ref\s+[\w./-]+(?:\s+e\s+Ref\s+[\w./-]+)*)/i);
  return m ? m[1].trim() : name;
}

function buildCartSummary(session, title = '🛒 *SEU CARRINHO*') {
  const PIX_DISCOUNT = parseFloat(process.env.PIX_DISCOUNT_PCT || '10') / 100;

  // Agrupa itens do mesmo produto (mesmo productId) para exibir uma linha por referência.
  const productGroups = new Map();
  for (const item of session.items) {
    const key = String(item.productId);
    if (!productGroups.has(key)) {
      productGroups.set(key, {
        productName: normalizeCartLabel(item.productName),
        unitPrice: parseFloat(item.unitPrice) || 0,
        totalQty: 0,
        totalPrice: 0,
        sizeLabels: [],
      });
    }
    const g = productGroups.get(key);
    const qty = item.quantity || 1;
    g.totalQty += qty;
    g.totalPrice += parseFloat(item.price) || 0;

    const variant = normalizeCartLabel(item.variant);
    const size = normalizeCartLabel(item.size);
    const label = variant ? `${variant} ${size}` : size;
    if (label) g.sizeLabels.push(label);
  }

  let total = 0;
  let summary = `${title}\n─────────────────\n`;
  let idx = 0;

  for (const g of productGroups.values()) {
    const pixSubtotal = g.totalPrice * (1 - PIX_DISCOUNT);
    const pixUnit = g.totalQty > 0 ? pixSubtotal / g.totalQty : 0;
    total += g.totalPrice;

    const sizeLabel = g.sizeLabels.join(' · ') || '-';
    summary += `*${++idx}. ${g.productName}*\n`;
    summary += `    ${sizeLabel}\n`;
    summary += `    ${woocommerce.formatPrice(pixUnit)}/un × ${g.totalQty} = *${woocommerce.formatPrice(pixSubtotal)} no PIX*\n\n`;
  }

  const pixTotal = total * (1 - PIX_DISCOUNT);

  summary += `─────────────────\n💰 *Total no PIX: ${woocommerce.formatPrice(pixTotal)}*\n_Desconto de 10% já aplicado_\n\n_Para remover: "remover 1", "remover 2"..._`;
  return { summary, total };
}

/**
 * Agrupa os itens do carrinho por productId para envio visual à vendedora.
 * Cada grupo contém: productId, productName, imageUrl, variações (size+qty) e subtotal.
 * Usado por handoffToConsultant para enviar 1 foto por produto distinto.
 */
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
      await zapi.sendText(phone, `Qual o tamanho e a quantidade de *${product.name}*? 😊\n_Pode digitar ou mandar um áudio 🎙️ — ex: "M" ou "2P 1M". Se preferir falar com a consultora, é só me dizer!_`);
      await sendStockAwareSizeQtyList(phone, session, product, pf.interactiveVersion || Date.now());
      return;
    }
  }

  if (pf.state === 'awaiting_quantity' && pf.selectedSize) {
    await zapi.sendText(phone, `Quantas peças do tamanho *${pf.selectedSize}*? 😊\n_Pode digitar ou mandar um áudio 🎙️ — ex: "2", "3 peças". Ou diz "falar com consultora" se preferir!_`);
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

  await sendCategoryMenu(phone, 'Por qual linha você quer começar? 😊\n_Pode me dizer por texto, áudio 🎙️ ou escolher abaixo. Se preferir falar com nossa consultora, é só dizer "falar com consultora"._');
}

/**
 * Processa um quote reply na mensagem de resumo do carrinho.
 * Suporta dois padrões determinísticos:
 *   - Reduzir: "Tira 1M dessa primeira" / "Remove 2 do segundo"
 *   - Aumentar: "Coloca mais 1M dessa segunda" / "Adiciona 3 no terceiro"
 * Se o parse falhar, exibe o carrinho sem alterar nada (evita loop).
 */
async function handleCartEditFromQuote(phone, session, text) {
  const ORDINALS = {
    primeira: 0, primeiro: 0,
    segunda: 1, segundo: 1,
    terceira: 2, terceiro: 2,
    quarta: 3, quarto: 3,
    quinta: 4, quinto: 4,
  };

  const normalized = text.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const isRemove = /\b(tira|remove|diminui|retira|menos|tira[r]?)\b/.test(normalized);
  const isAdd    = /\b(coloca|adiciona|mais|aumenta|acrescenta)\b/.test(normalized);

  // Índice do item: ordinal PT-BR ou "item N"
  let itemIdx = null;
  for (const [word, idx] of Object.entries(ORDINALS)) {
    if (normalized.includes(word)) { itemIdx = idx; break; }
  }
  const numItemMatch = normalized.match(/\bitem\s+(\d+)\b/);
  if (numItemMatch) itemIdx = parseInt(numItemMatch[1]) - 1;

  // Quantidade + tamanho: "1M", "3 G", "2GG" — captura o primeiro par número+letra
  const qsMatch = normalized.match(/(\d+)\s*([a-z]{1,4})\b/);
  const qty  = qsMatch ? parseInt(qsMatch[1]) : 1;
  const size = qsMatch ? qsMatch[2].toUpperCase() : null;

  const items = session.items || [];
  const item  = (itemIdx !== null && itemIdx >= 0) ? items[itemIdx] : null;

  if (!item || (!isRemove && !isAdd)) {
    logger.warn({ from: phone, text: text.slice(0, 80), itemIdx, isRemove, isAdd }, '[CartEdit] Parse falhou — exibindo carrinho sem alteração');
    await showCart(phone, session);
    return;
  }

  // Valida que o tamanho bate (se informado)
  const itemSizeLabel = item.variant ? `${item.variant} - ${item.size}` : item.size;

  if (size && item.size.toUpperCase() !== size) {
    await zapi.sendText(phone,
      `⚠️ O item ${itemIdx + 1} é tamanho *${itemSizeLabel}*, não *${size}*.\n` +
      `Quer modificar o item ${itemIdx + 1} (*${item.productName}* — ${itemSizeLabel})?`
    );
    await showCart(phone, session);
    return;
  }

  const unitPrice = item.unitPrice || (item.quantity > 0 ? item.price / item.quantity : 0);

  if (isRemove) {
    item.quantity -= qty;
    if (item.quantity <= 0) {
      const removed = items.splice(itemIdx, 1)[0];
      const removedSizeLabel = removed.variant ? `${removed.variant} - ${removed.size}` : removed.size;
      await zapi.sendText(phone, `🗑️ *${removed.productName}* (${removedSizeLabel}) removido do carrinho.`);
      logger.info({ phone, productName: removed.productName, size: removed.size, variant: removed.variant }, '[CartEdit] Item removido via quote reply');
    } else {
      item.price = parseFloat((unitPrice * item.quantity).toFixed(2));
      await zapi.sendText(phone, `✅ Ajuste feito! *${item.productName}* (${itemSizeLabel}) agora são *x${item.quantity}*.`);
      logger.info({ phone, productName: item.productName, size: item.size, variant: item.variant, newQty: item.quantity }, '[CartEdit] Quantidade reduzida via quote reply');
    }
  } else {
    item.quantity += qty;
    item.price = parseFloat((unitPrice * item.quantity).toFixed(2));
    item.unitPrice = unitPrice;
    await zapi.sendText(phone, `✅ Adicionado! *${item.productName}* (${itemSizeLabel}) agora são *x${item.quantity}*.`);
    logger.info({ phone, productName: item.productName, size: item.size, variant: item.variant, newQty: item.quantity }, '[CartEdit] Quantidade aumentada via quote reply');
  }

  if ((session.items || []).length > 0) {
    await showCart(phone, session);
  } else {
    await sendCategoryMenu(phone, '🛒 Carrinho vazio! Qual linha você quer ver?');
  }
}

async function showCart(phone, session) {
  // Aguarda matches de foto ainda em curso pra evitar "carrinho vazio" prematuro
  await awaitPendingImageMatches(session);
  if (!session.items || session.items.length === 0) {
    await sendCategoryMenu(phone, '🛒 Seu carrinho está vazio por enquanto. Qual linha você quer ver agora?');
    return;
  }
  const { summary } = buildCartSummary(session);
  const res = await sendCartOptions(phone, session, summary);
  // Rastreia o ID da mensagem do carrinho para detectar quote replies futuros
  const cartMsgId = res?.data?.messageId || res?.data?.zaapId;
  if (cartMsgId) session.lastCartSummaryMessageId = cartMsgId;
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
    { id: 'cart_other_category', title: 'Ver Outra Categoria', description: categoryLabel },
    { id: 'cart_view', title: 'Ver Carrinho', description: `Conferir os ${itemLabel}` },
    { id: 'cart_remove_item', title: 'Remover Item', description: 'Tirar algo do carrinho' },
    { id: 'cart_more_products', title: 'Ver Mais Produtos', description: buildMoreProductsDescription(session) },
  ];

  return await zapi.sendOptionList(phone, text, 'Próximo Passo', 'Escolher', options);
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

  if (queueLength > 0) {
    lines.push(`📋 *${queueLength} produto${queueLength > 1 ? 's' : ''} na fila*`);
  }

  return lines;
}

/**
/**
 * Tenta interpretar a resposta do cliente a uma falha parcial de grade.
 * Exemplos: "Pode ser 1", "Coloca 1 então", "Ok", "Pode" → adiciona ao carrinho.
 * Retorna true se tratou a mensagem, false para fallback ao fluxo normal.
 */
async function handlePartialFailureResponse(phone, session, text, messageId) {
  const pf = session.purchaseFlow;
  const failure = pf._lastPartialFailure;
  if (!failure?.items?.length) return false;
  if (String(pf.productId) !== String(failure.productId)) {
    pf._lastPartialFailure = null;
    return false;
  }

  const normalizedText = text.trim().toLowerCase();

  // Padrões de aceitação sem quantidade → usa máximo disponível
  const acceptanceRe = /^(pode(r)?( ser)?|ok|tá bom|ta bom|sim|vai|beleza|manda( mais)?|coloca( tudo)?|blz|aceito|combinado|fechado|ótimo|otimo|perfeito|claro|certo|exato|isso|com certeza)\.?$/i;
  const isAcceptance = acceptanceRe.test(normalizedText);

  // Extrai número da mensagem: "Pode ser 1", "Coloca 2 então", "1 tá bom"
  const numberMatch = text.match(/\b(\d+)\b/);
  const requestedQty = numberMatch ? parseInt(numberMatch[1], 10) : null;

  if (!requestedQty && !isAcceptance) return false;

  const addedItems = [];
  for (const { size, available } of failure.items) {
    if (!available || available <= 0) continue; // indisponível real — pula
    const qty = requestedQty ? Math.min(requestedQty, available) : available;
    if (qty <= 0) continue;
    pushCartItem(session, failure.productId, failure.productName, size, qty, failure.unitPrice, failure.imageUrl || null, failure.variant || null);
    addedItems.push({ size, qty });
  }

  pf._lastPartialFailure = null;
  if (addedItems.length === 0) return false;

  if (messageId) zapi.sendReaction(phone, messageId, '✅').catch(() => {});
  pf.state = 'awaiting_more_sizes';
  if (!Array.isArray(pf.addedSizes)) pf.addedSizes = [];
  pf.addedSizes.push(...addedItems.map(a => a.size));
  pf.lastCommitSource = 'text';

  const confirmHistory = addedItems.map(({ size, qty }) => `• ${failure.productName} (${size}) x${qty}`).join('\n');
  appendHistory(session, 'assistant', `✅ Ajustado!\n${confirmHistory}`);
  logger.info({ phone, addedItems }, '[PartialFailure] Resposta do cliente interpretada como ajuste de quantidade');

  scheduleCartSummary(phone);
  persistSession(phone);
  return true;
}

/**
 * Agenda envio do resumo do carrinho após `delayMs` ms de inatividade.
 * Reset automático: cada nova chamada cancela o timer anterior.
 * Fire-and-forget: deve ser chamada SEM await — falhas são logadas, nunca relançadas.
 *
 * ADR-035 — UX-SILENT-ADD: bot silencioso após adição, resumo pós-inatividade.
 */
function scheduleCartSummary(phone, delayMs = 60_000) {
  const existing = silentAddDebounce.get(phone);
  if (existing?.timer) clearTimeout(existing.timer);
  logger.info({ phone, delayMs }, '[SilentAdd] Timer de resumo agendado');
  const timer = setTimeout(async () => {
    silentAddDebounce.delete(phone);
    try {
      const sess = sessions[phone];
      if (!sess) {
        logger.info({ phone }, '[SilentAdd] Timer disparou mas sessão não existe — skip');
        return;
      }
      const pf = sess.purchaseFlow;
      if (!pf || !sess.items?.length) {
        logger.info({ phone, hasItems: !!sess.items?.length }, '[SilentAdd] Timer disparou mas sem itens no carrinho — skip');
        return;
      }
      // Só dispara se ainda está em modo de compra ativo
      if (pf.state !== 'awaiting_more_sizes' && pf.state !== 'awaiting_size') {
        logger.info({ phone, state: pf.state }, '[SilentAdd] Timer disparou mas estado não é awaiting_more_sizes/awaiting_size — skip');
        return;
      }
      if (sess.purchaseFlow?.buyQueue?.length > 0) {
        logger.info({ phone, queueLen: sess.purchaseFlow.buyQueue.length }, '[SilentAdd] Timer disparou — avançando para próximo produto da fila');
        await processNextInQueue(phone, sess);
      } else {
        logger.info({ phone, state: pf.state, itemCount: sess.items.length }, '[SilentAdd] Timer disparou — enviando resumo do carrinho');
        await sendCartSummary(phone, sess);
      }
    } catch (err) {
      logger.warn({ err: err.message, phone }, '[SilentAdd] sendCartSummary falhou (non-critical)');
    }
  }, delayMs);
  silentAddDebounce.set(phone, { timer });
}

/**
 * Envia resumo do carrinho com menu de ação após inatividade (ADR-035).
 * Constrói as options diretamente (sem sendPostAddMenu) para evitar o cabeçalho
 * "📋 X na fila" gerado por buildPurchaseFlowFocusLines.
 * Usa buildCartSummary para calcular total com os campos corretos (quantity, price).
 */
async function sendCartSummary(phone, session) {
  const items = session.items || [];
  if (!items.length) return;

  const pf = session.purchaseFlow;
  const queueLength = pf?.buyQueue?.length || 0;

  // buildCartSummary já usa item.quantity e item.price corretamente
  const { total } = buildCartSummary(session, null);
  
  const PIX_DISCOUNT = parseFloat(process.env.PIX_DISCOUNT_PCT || '10') / 100;
  const pixTotal = total * (1 - PIX_DISCOUNT);
  
  const totalStr = woocommerce.formatPrice(total);
  const pixStr = woocommerce.formatPrice(pixTotal);
  const lines = items.map(i => {
    const sizeLabel = i.variant ? `${i.variant} - ${i.size}` : i.size;
    return `• ${i.productName} (${sizeLabel}) x${i.quantity || 1}`;
  }).join('\n');

  const queueNote = queueLength > 0
    ? `\n_(Ainda tenho *${queueLength} produto${queueLength > 1 ? 's' : ''}* pra separar com você — tamanhos e quantidades ainda não foram escolhidos!)_`
    : `\n\nTemos muito mais produtos disponíveis! 😊`;

  const summaryText =
    `Aqui está o que você separou até agora 😊\n\n${lines}\n\n💰 *PIX estimado: ${pixStr}*\n💳 Cartão: ${totalStr}${queueNote}\n\nO que quer fazer agora?`;

  appendHistory(session, 'assistant', summaryText);
  conversationMemory.refreshConversationMemory(session, { assistantText: summaryText, action: { type: 'CARRINHO' } });

  // Monta options manualmente — sem buildPurchaseFlowFocusLines (sem "📋 X na fila")
  const options = [];
  if (queueLength > 0) {
    const nextInQueue = pf.buyQueue[0];
    options.push({
      id: `skip_more_v${pf.interactiveVersion}`,
      title: 'Próximo Produto',
      description: nextInQueue.productName,
    });
  }
  options.push({ id: 'cart_finalize',        title: 'Finalizar Pedido',    description: 'Encaminhar para fechamento' });
  options.push({ id: 'cart_other_category',  title: 'Ver Outra Categoria', description: 'Trocar de linha agora' });
  options.push({ id: 'cart_view',            title: 'Ver Carrinho',        description: 'Conferir os itens escolhidos' });
  if (items.length > 0) {
    options.push({ id: 'cart_remove_item',   title: 'Remover Item',        description: 'Tirar algo do carrinho' });
  }
  if (queueLength === 0) {
    options.push({ id: 'cart_more_products', title: 'Ver Mais Produtos',   description: buildMoreProductsDescription(session) });
  }

  await zapi.sendOptionList(phone, summaryText, 'Resumo do Pedido', 'Escolher', options);
}

/**
 * Menu pós-adição de item ao carrinho.
 *
 * [UX-RULE-001] — REGRA PROTEGIDA — não altere sem ler:
 * Quando `remainingSizes` existe, o caller (addToCart) DEVE incluir a lista
 * de tamanhos no `customText` — o customText substitui o promptText padrão e
 * os tamanhos ficariam ocultos se não forem explicitados no texto principal.
 *
 * Ordem das opções — por importância B2B (não alterar sem revisão):
 *   1. "Outro Tamanho"     se houver — ação imediata no produto atual
 *   2. "Próximo Produto"   se houver fila — gerencia fila
 *   3. "Finalizar Pedido"  lojista B2B quer fechar rápido
 *   4. "Ver Outra Categoria" trocar de linha > ver mais da mesma
 *   5. "Ver Carrinho"      revisão
 *   6. "Remover Item"      eventual, só se há itens
 *   7. "Ver Mais Produtos" só sem fila, menor prioridade
 */
async function sendPostAddMenu(phone, session, remainingSizes, customText = null) {
  const pf = session.purchaseFlow;
  const queueLength = pf.buyQueue?.length || 0;
  const options = [];

  // 1. Ação imediata no produto atual
  if (remainingSizes.length > 0) {
    options.push({
      id: `add_size_v${pf.interactiveVersion}`,
      title: 'Outro Tamanho',
      description: `Ainda temos ${remainingSizes.join(' | ')}`,
    });
  }

  // 2. Gerenciar fila (skip_more_ prefix → interceptado pela FSM antes da IA)
  if (queueLength > 0) {
    const nextInQueue = pf.buyQueue[0];
    options.push({
      id: `skip_more_v${pf.interactiveVersion}`,
      title: 'Próximo Produto',
      description: nextInQueue.productName,
    });
  }

  // 3. Fechar pedido — lojista B2B quer rapidez
  options.push({ id: 'cart_finalize', title: 'Finalizar Pedido', description: 'Encaminhar para fechamento' });

  // 4. Trocar de linha — mais comum em B2B do que continuar na mesma categoria
  options.push({ id: 'cart_other_category', title: 'Ver Outra Categoria', description: 'Trocar de linha agora' });

  // 5. Revisão do carrinho
  options.push({ id: 'cart_view', title: 'Ver Carrinho', description: 'Conferir os itens escolhidos' });

  // 6. Remover item — eventual
  if (session.items?.length > 0) {
    options.push({ id: 'cart_remove_item', title: 'Remover Item', description: 'Tirar algo do carrinho' });
  }

  // 7. Ver mais da mesma linha — menor prioridade; some quando há fila
  if (queueLength === 0) {
    options.push({ id: 'cart_more_products', title: 'Ver Mais Produtos', description: buildMoreProductsDescription(session) });
  }

  const focusLines = buildPurchaseFlowFocusLines(session);
  let promptText = customText;
  if (!promptText) {
    if (remainingSizes.length > 0) {
      promptText = `Ainda tem *${remainingSizes.join(' | ')}* disponível 😊 Quer separar mais ou ir pro próximo?\n_Pode digitar tamanho + quantidade ou escolher pelo botão_`;
    } else if (queueLength > 0) {
      promptText = 'Perfeito! 😊 Quer ir pro próximo produto ou revisar o carrinho?';
    } else {
      promptText = 'Perfeito 😊 Quer revisar o carrinho, finalizar, ver mais produtos ou trocar de categoria?';
    }
  }

  const menuText = [...focusLines, promptText].filter(Boolean).join('\n\n');
  await zapi.sendOptionList(phone, menuText, 'Próximo Passo', 'Escolher', options);
}

/**
 * Troca o foco da FSM para um novo produto, preservando o produto antigo na buyQueue
 * se ele ainda tiver tamanhos pendentes.
 * Chamado quando o lojista dá reply em um card diferente do produto em foco.
 *
 * Retorna { contextMessage: string|null } — mensagem de contexto que o caller
 * DEVE enviar via zapi.sendText ANTES de mostrar o novo produto, para que o
 * lojista entenda o que está acontecendo (ex: "vi que você voltou para X,
 * depois a gente termina Y"). Não ignorar este retorno.
 */
function switchFsmFocus(session, newProduct) {
  const pf = session.purchaseFlow;
  let contextMessage = null;

  // Se havia produto em foco, decidir se enfileira.
  // Regra (ADR-024): commit textual explícito (lastCommitSource === 'text')
  // é tratado como "grade fechada" — NÃO enfileira. O cliente já expressou
  // a quantidade desejada; preservar na fila geraria UX confusa.
  // Commit via botão continua enfileirando se ainda restam tamanhos (ADR-022).
  if (pf.productId && String(pf.productId) !== String(newProduct.id) && pf.state !== 'idle') {
    // Fallback só usa session.currentProduct se ele corresponde ao produto em foco na FSM.
    // Sem essa guarda, quando processNextInQueue não atualizava currentProduct, o fallback
    // retornava o produto ANTERIOR (do startInteractivePurchase), re-enfileirando o produto
    // errado e perdendo o produto interrompido.
    const currentProductMatchesFsm = session.currentProduct && String(session.currentProduct.id) === String(pf.productId);
    const oldProduct = getLoadedProductById(session, pf.productId) || (currentProductMatchesFsm ? session.currentProduct : null);
    if (oldProduct) {
      const isExplicitTextCommit = pf.lastCommitSource === 'text';

      if (isExplicitTextCommit) {
        logger.info(
          { oldProduct: oldProduct.id, oldName: oldProduct.name, newProduct: newProduct.id, addedSizes: pf.addedSizes },
          '[FSM] switchFsmFocus: grade textual explícita — produto fechado, NÃO enfileira'
        );
        // Produto antigo já foi fechado — Bela apenas confirma a troca
        contextMessage = `Entendido! Vamos separar *${newProduct.name}* agora 😊`;
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
          // Bela avisa que vai pausar o produto anterior e retomá-lo depois
          contextMessage = `Tá bom! Vou separar *${newProduct.name}* agora e depois a gente volta para *${oldProduct.name}* 😊`;
        } else {
          contextMessage = `Ok! Separando *${newProduct.name}* 😊`;
        }
      }
    }
  }

  pf.productId   = newProduct.id;
  pf.productName = newProduct.name;
  pf.price       = parseFloat(newProduct.salePrice || newProduct.price) || 0;
  pf.addedSizes  = [];
  pf.selectedSize = null;
  // Reset variant — novo produto pode ter variante diferente
  pf.selectedVariant = null;
  pf.variantAttributeName = null;
  pf._variantBlacklist = []; // limpa blacklist de variantes do produto anterior
  // Se o produto tem segundo eixo de variação (ex: Mãe/Filha), pede a escolha primeiro
  const secondaryAttr = newProduct.secondaryAttributes?.[0];
  if (secondaryAttr) {
    pf.state = 'awaiting_variant';
    pf.variantAttributeName = secondaryAttr.name;
  } else {
    pf.state = 'awaiting_size';
  }
  pf.interactiveVersion = Date.now();
  // Reset do commit source — novo produto começa sem histórico de commit
  pf.lastCommitSource = null;
  pf.lastClickedProductId = newProduct.id;
  pf.lastClickedProductName = newProduct.name;
  pf.lastClickedProductTimestamp = Date.now();
  session.currentProduct = newProduct;

  return { contextMessage, needsVariant: !!secondaryAttr, secondaryAttr: secondaryAttr || null };
}

async function startInteractivePurchase(phone, product, session, introText = null, skipVariantSend = false) {
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
  session.purchaseFlow.selectedVariant = null;
  session.purchaseFlow.variantAttributeName = null;
  session.purchaseFlow._variantBlacklist = []; // limpa blacklist de variantes do produto anterior
  session.purchaseFlow.interactiveVersion = Date.now();
  // Sync lastClickedProduct* so quote-reply fallback always resolves the current product
  session.purchaseFlow.lastClickedProductId = product.id;
  session.purchaseFlow.lastClickedProductName = product.name;
  session.purchaseFlow.lastClickedProductTimestamp = Date.now();

  if (introText) {
    await zapi.sendText(phone, introText);
  }

  // Short-circuit para produtos com segundo eixo de variação (ex: Mãe/Filha) — pede escolha antes do tamanho
  const secondaryAttr = product.secondaryAttributes?.[0];
  if (secondaryAttr) {
    session.purchaseFlow.state = 'awaiting_variant';
    session.purchaseFlow.variantAttributeName = secondaryAttr.name;
    if (!skipVariantSend) {
      await sendVariantList(phone, secondaryAttr, session);
    }
    return true;
  }

  // Short-circuit para produtos com 0 ou 1 tamanho — pula awaiting_size
  const productWithStock = await ensureProductStockData(product);
  const productSizes = (productWithStock?.sizes || []).filter(Boolean);

  if (productSizes.length === 0) {
    // Produto sem variação de tamanho — usar 'ÚNICO' como tamanho padrão
    session.purchaseFlow.selectedSize = 'ÚNICO';
    session.purchaseFlow.state = 'awaiting_quantity';
    await sendTextWithTTS(phone, `📦 *${product.name}* — produto sem variação de tamanho. Quantas unidades você quer?`);
    await sendStockAwareQuantityList(phone, session, 'ÚNICO', session.purchaseFlow.interactiveVersion, productWithStock);
    return true;
  }

  if (productSizes.length === 1) {
    // Produto com único tamanho — seleciona automaticamente e pede quantidade
    const singleSize = productSizes[0];
    session.purchaseFlow.selectedSize = singleSize;
    session.purchaseFlow.state = 'awaiting_quantity';
    await sendTextWithTTS(phone, `📦 *${product.name}* vem em *${singleSize}*. Quantas unidades você quer?`);
    await sendStockAwareQuantityList(phone, session, singleSize, session.purchaseFlow.interactiveVersion, productWithStock);
    return true;
  }

  await sendStockAwareSizeQtyList(phone, session, productWithStock, session.purchaseFlow.interactiveVersion);
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
    await sendTextWithTTS(phone, `📸 Enviando as fotos de *${product.name}*...`);
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

function setCatalogSearchSessionProducts(session, products) {
  session.products = products;
  session.currentCategory = null;
  session.activeCategory = null;
  session.currentPage = 1;
  session.totalPages = 1;
  session.totalProducts = products.length;

  if (products.length > 0) {
    session.lastViewedProduct = products[products.length - 1];
    session.lastViewedProductIndex = products.length;
  }
}

function buildCatalogAssistantText(result, kind) {
  const intent = result.intent || {};
  const query = intent.query || 'esse modelo';

  if (kind === 'auto') {
    if (intent.theme) return `Achei essa estampa aqui disponível 😊`;
    if (intent.recency?.type === 'yesterday') return `Achei esse daqui de ontem ainda disponível 😊`;
    return `Achei esse aqui disponível 😊`;
  }

  if (kind === 'multiple') {
    if (intent.theme) return `Achei essas opções com essa estampa 😊`;
    return `Achei alguns modelos de *${query}* disponíveis 😊`;
  }

  if (kind === 'out_of_stock_with_similar') {
    return `Esse não apareceu disponível agora 😕 Mas separei outros parecidos que ainda tenho em estoque.`;
  }

  if (kind === 'out_of_stock') {
    return `Esse não apareceu disponível agora 😕 Me manda uma referência ou uma foto que eu tento achar outro parecido pra você.`;
  }

  return `Não consegui achar esse modelo certinho agora 😕 Me manda a referência, uma foto ou mais um detalhe da estampa.`;
}

function recordCatalogDeterministicReply(session, userText, assistantText, result) {
  if (userText) {
    appendHistory(session, 'user', userText);
    conversationMemory.refreshConversationMemory(session, { userText });
  }
  if (assistantText) {
    appendHistory(session, 'assistant', assistantText);
    conversationMemory.refreshConversationMemory(session, {
      assistantText,
      action: { type: 'BUSCAR', payload: result.intent?.query || null },
    });
  }
}

async function sendCatalogProductImageOnly(phone, product, session, productNumber = 1) {
  const caption = woocommerce.buildCaption(product, productNumber);
  if (product.imageUrl) {
    const imgRes = await zapi.sendImage(phone, product.imageUrl, caption);
    registerMessageProduct(session, imgRes?.data?.zaapId, imgRes?.data?.messageId, product);
    const messageId = imgRes?.data?.messageId || imgRes?.data?.zaapId || null;
    if (messageId) {
      session.productShowcaseMessageId = session.productShowcaseMessageId || {};
      session.productShowcaseMessageId[product.id] = messageId;
    }
    return imgRes;
  }

  const textRes = await zapi.sendText(phone, caption);
  registerMessageProduct(session, textRes?.data?.zaapId, textRes?.data?.messageId, product);
  const messageId = textRes?.data?.messageId || textRes?.data?.zaapId || null;
  if (messageId) {
    session.productShowcaseMessageId = session.productShowcaseMessageId || {};
    session.productShowcaseMessageId[product.id] = messageId;
  }
  return textRes;
}

async function sendCatalogProductCards(phone, products, session) {
  const sentProducts = [];
  session.purchaseFlow.interactiveVersion = Date.now();

  for (const [i, product] of products.entries()) {
    const enriched = await ensureProductStockData(product);
    if (!enriched) continue;
    sentProducts.push(enriched);

    if (enriched.imageUrl) {
      try {
        const showcaseButtons = buildShowcaseButtons(enriched);
        const scRes = await zapi.sendProductShowcase(phone, enriched, session.purchaseFlow.interactiveVersion, showcaseButtons);
        registerMessageProduct(session, scRes?.data?.zaapId, scRes?.data?.messageId, enriched);
        if (scRes?.data?.messageId) {
          session.productShowcaseMessageId = session.productShowcaseMessageId || {};
          session.productShowcaseMessageId[enriched.id] = scRes.data.messageId;
        }
      } catch {
        try {
          await sendCatalogProductImageOnly(phone, enriched, session, i + 1);
        } catch (imgErr) {
          logger.warn({ productId: enriched.id, err: imgErr?.message }, '[CatalogSearch] Falha ao enviar imagem');
        }
      }
    } else {
      await sendCatalogProductImageOnly(phone, enriched, session, i + 1);
    }

    await zapi.delay(400);
  }

  return sentProducts;
}

async function openCatalogProductDirectly(phone, product, session, introText) {
  const enriched = await ensureProductStockData(product);
  if (!enriched) return false;

  setCatalogSearchSessionProducts(session, [enriched]);

  if (enriched.secondaryAttributes?.length > 0) {
    await startInteractivePurchase(phone, enriched, session, introText);
    return true;
  }

  await zapi.sendText(phone, introText);
  await sendCatalogProductImageOnly(phone, enriched, session, 1);
  await startInteractivePurchase(phone, enriched, session);
  return true;
}

async function renderCommercialCatalogResult(phone, result, session, opts = {}) {
  const userText = opts.userText || null;

  if (result.shouldAutoOpen && result.inStock.length === 1) {
    const assistantText = buildCatalogAssistantText(result, 'auto');
    recordCatalogDeterministicReply(session, userText, assistantText, result);
    await openCatalogProductDirectly(phone, result.inStock[0], session, assistantText);
    return true;
  }

  if (result.inStock.length > 0) {
    const assistantText = buildCatalogAssistantText(result, 'multiple');
    recordCatalogDeterministicReply(session, userText, assistantText, result);
    await zapi.sendText(phone, assistantText);
    const sentProducts = await sendCatalogProductCards(phone, result.inStock, session);
    setCatalogSearchSessionProducts(session, sentProducts.length > 0 ? sentProducts : result.inStock);
    return true;
  }

  if (result.outOfStock.length > 0) {
    const hasSimilar = result.similarInStock.length > 0;
    const assistantText = buildCatalogAssistantText(result, hasSimilar ? 'out_of_stock_with_similar' : 'out_of_stock');
    recordCatalogDeterministicReply(session, userText, assistantText, result);
    await zapi.sendText(phone, assistantText);

    if (hasSimilar) {
      const sentProducts = await sendCatalogProductCards(phone, result.similarInStock, session);
      setCatalogSearchSessionProducts(session, sentProducts.length > 0 ? sentProducts : result.similarInStock);
    }
    return true;
  }

  const assistantText = buildCatalogAssistantText(result, 'not_found');
  recordCatalogDeterministicReply(session, userText, assistantText, result);
  await zapi.sendText(phone, assistantText);
  return true;
}

async function runCommercialCatalogSearch(phone, query, session, opts = {}) {
  const intent = opts.intent || catalogQueryResolver.resolveCatalogQuery(query);
  if (!intent.shouldHandle) return false;

  const result = await catalogSearch.searchCatalog(intent, {
    woocommerce,
    imageMatcher,
    logger,
    resolveProductById: (productId) => resolveProductById(session, productId),
  });

  return renderCommercialCatalogResult(phone, result, session, {
    userText: opts.userText || null,
  });
}

async function tryHandleCommercialCatalogQuery(phone, text, session, semanticQuick) {
  if (!CATALOG_RESOLVER_ENABLED) return false;
  if (!catalogQueryResolver.shouldUseCatalogResolver({ text, session, semanticQuick, env: process.env })) {
    return false;
  }

  const intent = catalogQueryResolver.resolveCatalogQuery(text);

  try {
    logger.info(
      { phone, query: intent.query, intentType: intent.intentType, recency: intent.recency?.type || null },
      '[CatalogResolver] Busca comercial determinística'
    );
    const phrase = pickSearchLoadingPhrase(intent.query);
    await sendLoadingMessage(phone, phrase.text, phrase.tts);
    return await runCommercialCatalogSearch(phone, intent.query, session, { intent, userText: text });
  } catch (err) {
    logger.warn({ phone, err: err?.message || String(err), text: text.slice(0, 120) }, '[CatalogResolver] Falha — caindo para fluxo antigo');
    return false;
  }
}

async function searchAndShowProducts(phone, query, session) {
  clearSupportMode(session, 'search_products');
  const phrase = pickSearchLoadingPhrase(query);
  await sendLoadingMessage(phone, phrase.text, phrase.tts);

  if (CATALOG_RESOLVER_ENABLED) {
    try {
      const intent = catalogQueryResolver.resolveCatalogQuery(query);
      if (intent.shouldHandle) {
        const handled = await runCommercialCatalogSearch(phone, query, session, { intent });
        if (handled) return;
      }
    } catch (err) {
      logger.warn({ query, err: err?.message || String(err) }, '[searchAndShowProducts] Busca comercial falhou — usando legado');
    }
  }

  let searchResult;
  try {
    searchResult = await woocommerce.searchProducts(query, 10, 1);
  } catch (err) {
    logger.error({ query, err: err.message }, '[searchAndShowProducts] Erro na busca WooCommerce');
    await zapi.sendText(phone, `⚠️ Não consegui buscar "${query}" agora. Tenta de novo em instantes? 😊`);
    return;
  }

  let products = searchResult.products;

  // Fallback semântico: WC search por nome falhou (ex: "sonic" não está em
  // "Pijama Masculino - Ref 672S"). Usa embedding de texto contra a base de
  // descrições visuais indexadas via image-matcher.
  if (!products || products.length === 0) {
    try {
      const { candidates } = await imageMatcher.searchByText(query, 8, 0.55);
      if (candidates.length > 0) {
        const resolved = await Promise.all(
          candidates.map((c) => resolveProductById(session, c.product_id).catch(() => null))
        );
        products = resolved.filter(Boolean);
        logger.info(
          { query, semanticMatches: candidates.length, resolved: products.length },
          '[searchAndShowProducts] Fallback semântico encontrou produtos'
        );
      }
    } catch (err) {
      logger.warn({ query, err: err.message }, '[searchAndShowProducts] Fallback semântico falhou');
    }
  }

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
        // Enriquece com estoque real ANTES do showcase — card mostra tamanhos com disponibilidade real.
        await ensureProductStockData(product);

        const showcaseButtons1 = buildShowcaseButtons(product);
        const scRes = await zapi.sendProductShowcase(phone, product, session.purchaseFlow.interactiveVersion, showcaseButtons1);
        registerMessageProduct(session, scRes?.data?.zaapId, scRes?.data?.messageId, product);
        if (scRes?.data?.messageId) { session.productShowcaseMessageId = session.productShowcaseMessageId || {}; session.productShowcaseMessageId[product.id] = scRes.data.messageId; }
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
    const nudge = '[SISTEMA: Os produtos da busca foram exibidos. Pergunte se gostou de algum. Instrua: deslizar a foto e enviar tamanho+quantidade, ou clicar em Separar Tamanho, ou mandar um áudio 🎙️. Se não achou o que queria, ofereça ver outra linha. Tom curto, ritmo de WhatsApp.]';
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
        await sendTextWithTTS(phone, cleanText);
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
    await sendTextWithTTS(phone, fallback);
  }
}

/**
 * Gera botões customizados para o showcase de produto com variantes (ex: Mãe/Filha).
 * Retorna null para produtos normais → sendProductShowcase usa o botão "Separar Tamanho" padrão.
 * Requer que product.variantSizes esteja populado (ensureProductStockData sem filtro de variante).
 */
function buildShowcaseButtons(product) {
  if (!product.secondaryAttributes?.length || !product.variantSizes) return null;
  const attr = product.secondaryAttributes[0];
  const availableOpts = attr.options.filter(
    opt => (product.variantSizes[opt]?.length ?? 0) > 0
  );
  if (availableOpts.length === 0) return null;
  return availableOpts.map(opt => ({
    id: `buy_variant_${product.id}_${opt}`,
    label: opt,
  }));
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
    // Rastreia categorias visitadas para upsell pós-checkout
    if (!Array.isArray(session.viewedCategories)) session.viewedCategories = [];
    if (!session.viewedCategories.includes(slug)) session.viewedCategories.push(slug);
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

    // Lançamentos exibidos A-Z para facilitar navegação visual no WhatsApp
    if (slug === 'lancamento-da-semana') {
      allProducts.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
    }

    session.products = allProducts;
    session.currentCategory = slug;
    session.activeCategory = slug;
    // Rastreia categorias visitadas para upsell pós-checkout
    if (!Array.isArray(session.viewedCategories)) session.viewedCategories = [];
    if (!session.viewedCategories.includes(slug)) session.viewedCategories.push(slug);
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

          // Enriquece com estoque real ANTES do showcase — evita mostrar tamanhos
          // esgotados como disponíveis no card (Bug: "G disponível" → "G indisponível").
          await ensureProductStockData(product);

          try {
            const showcaseButtons2 = buildShowcaseButtons(product);
            const scRes = await zapi.sendProductShowcase(phone, product, session.purchaseFlow.interactiveVersion, showcaseButtons2);
            registerMessageProduct(session, scRes?.data?.zaapId, scRes?.data?.messageId, product);
            if (scRes?.data?.messageId) { session.productShowcaseMessageId = session.productShowcaseMessageId || {}; session.productShowcaseMessageId[product.id] = scRes.data.messageId; }
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
        ? 'Deslize o produto que chamou atenção e me envie o *tamanho e a quantidade* — ou manda um *áudio* 🎙️ Pode também clicar em *Separar Tamanho* embaixo da foto 😊\n\nOu revisa o carrinho ou vê outra linha abaixo:'
        : 'Deslize o produto que chamou atenção e me envie o *tamanho e a quantidade* — ou manda um *áudio* 🎙️ Pode também clicar em *Separar Tamanho* embaixo da foto 😊\n\nSe quiser ver outra linha, é só escolher abaixo:';

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
    logger.error(
      { slug, code: err.code, errMsg: err.message, status: err.response?.status, data: err.response?.data },
      '[showAllCategory] Falha ao buscar categoria'
    );
    // Fallback: não trava o bot — mostra menu de categorias para o cliente escolher outra linha
    try {
      await sendCategoryMenu(phone, '😕 Tive uma dificuldade aqui agora. Qual linha você quer ver?');
    } catch (menuErr) {
      logger.error({ menuErr: menuErr.message }, '[showAllCategory] Falha também no menu de fallback');
    }
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

        // Enriquece com estoque real ANTES do showcase — card mostra tamanhos com disponibilidade real.
        await ensureProductStockData(product);

        try {
          const showcaseButtons3 = buildShowcaseButtons(product);
          const scRes = await zapi.sendProductShowcase(phone, product, session.purchaseFlow.interactiveVersion, showcaseButtons3);
          registerMessageProduct(session, scRes?.data?.zaapId, scRes?.data?.messageId, product);
          if (scRes?.data?.messageId) { session.productShowcaseMessageId = session.productShowcaseMessageId || {}; session.productShowcaseMessageId[product.id] = scRes.data.messageId; }
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
    ? `[SISTEMA: Página ${session.currentPage} de ${session.totalPages} exibida. Pergunte se gostou de algum. Instrua: deslizar a foto e enviar tamanho+quantidade, ou clicar em Separar Tamanho, ou mandar áudio 🎙️. Mencione que ainda tem mais produtos. Tom curto, ritmo de WhatsApp.]`
    : `[SISTEMA: Todos os produtos da categoria foram exibidos. Pergunte se gostou de algum. Instrua: deslizar a foto e enviar tamanho+quantidade, ou clicar em Separar Tamanho, ou mandar áudio 🎙️. Ofereça ver outra linha: feminino, masculino ou infantil. Tom curto, ritmo de WhatsApp.]`;
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

// ── Compound Grade — Raciocínio multimodal sobre múltiplas fotos + texto composto ─────
// Casos cobertos: cliente envia N fotos de pijamas em sequência + texto como
// "6 de cada estampa / 2 de cada tamanho". A Bela precisa: contar estampas,
// validar aritmética, confirmar visualmente antes de executar pushCartItem.
// Ver ADR-046 (compound reasoning) e plano em plans/qual-seria-a-abordagem-indexed-piglet.md

/**
 * Varre os textos pendentes de uma sessão em modo fechar_pedido e decide se o
 * caso é composto — ou seja, se há 2+ fotos identificadas + texto com spec
 * "N de cada estampa" ou "N de cada tamanho".
 *
 * @returns {{ spec: {perVariant, perSize}, sourceText: string } | null}
 */
function detectCompoundCase(session) {
  const matched = session.matchedProducts || [];
  if (matched.length < 2) return null;

  const candidates = [];
  for (const t of (session.pendingSizeTexts || [])) {
    if (t?.text) candidates.push(t.text);
  }
  for (const m of matched) {
    if (m?.caption) candidates.push(m.caption);
  }
  if (candidates.length === 0) return null;

  for (const text of candidates) {
    const spec = parseCompoundSpec(text);
    if (spec) return { spec, sourceText: text };
  }
  return null;
}

/**
 * Classifica resposta do cliente após Bela mandar a confirmação da grade composta.
 * @returns {'accept'|'reject'|'correct'|'unclear'}
 */
function classifyCompoundReply(text) {
  if (!text || typeof text !== 'string') return 'unclear';
  const t = text.trim().toLowerCase();

  const acceptRegex = /^(sim|isso|ok|okay|certo|fechou|fechado|pode|bora|manda|confirma|confirmado|t[aá] certo|perfeito|show|beleza|blz|pode mandar|pode ser|tudo certo|s)\.?!?$/i;
  if (acceptRegex.test(t)) return 'accept';

  const rejectRegex = /^(n[aã]o|nao|negativo|peraí|pera|espera|calma|muda|trocar|troca|espera a[ií]|deixa|nops|ñ|nn)\.?!?$/i;
  if (rejectRegex.test(t)) return 'reject';

  // Presença de números ou tamanhos no texto → correção
  if (/\d+|\b(pp|p|m|g|gg|xg|xgg)\b/i.test(t)) return 'correct';

  return 'unclear';
}

function clearCompoundState(session) {
  session.pendingCompoundGrade = null;
  session.awaitingCompoundConfirmation = false;
  session.compoundConfirmationExpiresAt = null;
  session.pendingCompoundPlan = null;
  session.pendingCompoundSpec = null;
}

/**
 * Agenda a confirmação composta da Bela com debounce curto (3s). Toda vez
 * que uma nova mensagem chega no fluxo composto, o timer é resetado.
 * Quando expirar, chama `runCompoundConfirmation` que orquestra:
 *   1. distributeCompoundGrade (determinístico)
 *   2. cross-check determinístico de incertezas/duplicatas
 *   3. template fixo + envio da mensagem de confirmação
 */
function schedulePendingCompoundConfirmation(phone, session) {
  const existing = compoundConfirmationTimers.get(phone);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    compoundConfirmationTimers.delete(phone);
    try {
      const inFlight = session.pendingImageMatches || 0;
      const waitedSince = session.firstPhotoAt || Date.now();
      const waitedMs = Date.now() - waitedSince;

      if (inFlight > 0 && waitedMs < MAX_WAIT_FOR_FLIGHT) {
        logger.info(
          { phone, inFlight, waitedMs },
          '[Compound] Aguardando fila ImageMatch — re-agendando'
        );
        schedulePendingCompoundConfirmation(phone, session);
        return;
      }

      if (inFlight > 0) {
        logger.warn(
          { phone, inFlight, waitedMs },
          '[Compound] Timeout esperando fila — disparando com lista parcial'
        );
      }

      await runCompoundConfirmation(phone, session);
    } catch (err) {
      logger.error(
        { phone, err: err.message, stack: err?.stack?.slice(0, 400) },
        '[Compound] Falha em runCompoundConfirmation — fallback para handoff'
      );
      // Fallback seguro: volta para fluxo humano normal
      clearCompoundState(session);
      scheduleFecharPedidoHandoff(phone, session);
    }
  }, COMPOUND_DEBOUNCE_MS);

  compoundConfirmationTimers.set(phone, timer);
  logger.info({ phone, debounceMs: COMPOUND_DEBOUNCE_MS }, '[Compound] Timer de confirmação agendado');
}

/**
 * Variante do schedulePendingCompoundConfirmation para o fluxo NORMAL
 * (ver lançamento, catálogo). Usa debounce mais curto (1.5s) e em caso de
 * falha NÃO faz handoff humano — apenas limpa o estado e deixa a IA seguir
 * naturalmente. Antes de disparar, integra ADR-022 (Reply é Cursor): se a
 * FSM está em outro produto, enfileira via switchFsmFocus.
 */
function scheduleNormalCompoundCheck(phone, session) {
  const existing = normalCompoundTimers.get(phone);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    normalCompoundTimers.delete(phone);
    try {
      const inFlight = session.pendingImageMatches || 0;
      const waitedSince = session.firstPhotoAt || Date.now();
      const waitedMs = Date.now() - waitedSince;

      if (inFlight > 0 && waitedMs < MAX_WAIT_FOR_FLIGHT) {
        logger.info(
          { phone, inFlight, waitedMs },
          '[Compound] Aguardando fila ImageMatch — re-agendando'
        );
        scheduleNormalCompoundCheck(phone, session);
        return;
      }

      if (inFlight > 0) {
        logger.warn(
          { phone, inFlight, waitedMs },
          '[Compound] Timeout esperando fila — disparando com lista parcial'
        );
      }

      // ADR-022: se há produto em foco diferente dos do compound, enfileira
      const matched = (session.matchedProducts || []).filter((m) => m.compoundOrigin === 'normal');
      const pf = session.purchaseFlow;
      const focusedId = pf?.productId ? String(pf.productId) : null;
      const compoundIds = new Set(matched.map((m) => String(m.productId)));
      if (focusedId && pf?.state && pf.state !== 'idle' && !compoundIds.has(focusedId)) {
        const firstMatch = matched[0];
        if (firstMatch) {
          const productForFocus = getLoadedProductById(session, firstMatch.productId)
            || (await resolveProductById(session, firstMatch.productId).catch(() => null));
          if (productForFocus) {
            const { contextMessage } = switchFsmFocus(session, productForFocus);
            if (contextMessage) {
              appendHistory(session, 'assistant', contextMessage);
              conversationMemory.refreshConversationMemory(session, { assistantText: contextMessage });
            }
          }
        }
      }

      await runCompoundConfirmation(phone, session, { fromNormal: true });
    } catch (err) {
      logger.error(
        { phone, err: err.message, stack: err?.stack?.slice(0, 400) },
        '[Compound] Falha em scheduleNormalCompoundCheck — limpando estado'
      );
      clearCompoundState(session);
      // Em modo normal, não força handoff — IA segue na próxima mensagem
    }
  }, NORMAL_COMPOUND_DEBOUNCE_MS);

  normalCompoundTimers.set(phone, timer);
  logger.info({ phone, debounceMs: NORMAL_COMPOUND_DEBOUNCE_MS }, '[Compound] Timer modo normal agendado');
}

const COMPOUND_CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5min

/**
 * Cross-check determinístico do compound. Não bloqueia a confirmação: só deixa
 * visível para a cliente quando há identificação incerta ou duplicata suspeita.
 */
function detectCompoundInconsistencies(matched, plan) {
  const issues = [...(Array.isArray(plan?.inconsistencies) ? plan.inconsistencies : [])];
  const uncertain = (matched || []).filter((m) => m.uncertain || (m.confidence ?? 1) < 0.65);

  if (uncertain.length > 0) {
    issues.push(`${uncertain.length} foto(s) com identificação incerta — vou confirmar uma a uma se você concordar`);
  }

  const idCounts = {};
  for (const match of matched || []) {
    if (!match?.productId) continue;
    idCounts[match.productId] = (idCounts[match.productId] || 0) + 1;
  }
  const duplicate = Object.entries(idCounts).find(([, count]) => count > 1);
  if (duplicate) {
    issues.push(`Identifiquei o mesmo produto em ${duplicate[1]} fotos — pode ser estampa diferente parecida`);
  }

  return issues;
}

function renderCompoundConfirmation(plan) {
  const lines = [];
  lines.push('Deixa eu confirmar pra não errar 😊');
  lines.push('');

  for (const item of plan.items || []) {
    const grade = (item.grade || [])
      .map((entry) => `${entry.qty}${entry.size}${entry.variant ? ` ${entry.variant}` : ''}`)
      .join(' ');
    lines.push(`• *${item.name}* — ${grade}`);
  }

  lines.push('');
  lines.push(`Total: *${plan.totalPieces} peças*`);

  if (plan.inconsistencies?.length > 0) {
    lines.push('');
    lines.push('⚠️ Algumas inconsistências que precisam confirmar:');
    for (const issue of plan.inconsistencies) {
      lines.push(`- ${issue}`);
    }
  }

  lines.push('');
  lines.push('É isso mesmo? Manda *sim* que eu fecho 💖');
  return lines.join('\n');
}

async function runCompoundConfirmation(phone, session, options = {}) {
  const fromNormal = options.fromNormal === true;
  const fallback = (reason) => {
    if (fromNormal) {
      logger.info({ phone, reason }, '[Compound] Fallback em modo normal — limpando estado, IA segue');
      clearCompoundState(session);
      // Limpa buffer normal pra não re-disparar
      if (Array.isArray(session.matchedProducts)) {
        session.matchedProducts = session.matchedProducts.filter((m) => m.compoundOrigin !== 'normal');
      }
    } else {
      scheduleFecharPedidoHandoff(phone, session);
    }
  };

  const detected = detectCompoundCase(session);
  if (!detected) {
    logger.warn({ phone }, '[Compound] runCompoundConfirmation sem caso composto');
    fallback('no_compound_detected');
    return;
  }

  const matched = session.matchedProducts || [];
  const productsForPlan = matched.map((m) => ({
    productId: m.productId,
    name: m.name,
    sizes: Array.isArray(m.sizes) && m.sizes.length > 0 ? m.sizes : ['P', 'M', 'G'],
    attrOptions: Array.isArray(m.attrOptions) ? m.attrOptions : null,
  }));

  const computed = distributeCompoundGrade(productsForPlan, detected.spec);
  const plan = {
    items: Array.isArray(computed.items) ? computed.items : (computed.plan || []),
    totalPieces: computed.totalPieces || 0,
    inconsistencies: detectCompoundInconsistencies(matched, computed),
  };

  if (!Array.isArray(plan.items) || plan.items.length === 0 || plan.totalPieces <= 0) {
    logger.warn({ phone, computed }, '[Compound] Plano determinístico vazio — fallback');
    fallback('empty_deterministic_plan');
    return;
  }

  session.pendingCompoundSpec = detected.spec;
  session.pendingCompoundPlan = computed;
  session.pendingCompoundGrade = plan;
  session.awaitingCompoundConfirmation = true;
  session.compoundConfirmationExpiresAt = Date.now() + COMPOUND_CONFIRMATION_TTL_MS;

  const visibleMessage = renderCompoundConfirmation(plan);
  appendHistory(session, 'assistant', visibleMessage);
  conversationMemory.refreshConversationMemory(session, { assistantText: visibleMessage });
  await zapi.sendText(phone, visibleMessage);

  logger.info(
    {
      phone,
      totalPieces: plan.totalPieces,
      itemCount: plan.items.length,
      inconsistencyCount: plan.inconsistencies.length,
    },
    '[Compound] Grade composta determinística proposta ao cliente — aguardando confirmação'
  );

  persistSession(phone);
}

// ── Handoff humano (fluxo tradicional) ─────────────────────────────────────

/**
 * Finalizes the order by notifying the customer and forwarding the order summary to the admin.
 * Called when the AI emits [HANDOFF] or the customer confirms checkout with a pending queue.
 *
 * @param {string} phone - Customer phone number
 * @param {object} session - Current session object
 */
function scheduleFecharPedidoHandoff(phone, session) {
  const existing = fecharPedidoInactivityTimers.get(phone);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    fecharPedidoInactivityTimers.delete(phone);
    // Só dispara se a sessão ainda está no modo fechar pedido e sem compras em andamento
    if (session.supportMode !== 'fechar_pedido_pending') return;

    const relayBuffer = Array.isArray(session.fecharPedidoRelayBuffer) ? session.fecharPedidoRelayBuffer : [];
    const matched = session.matchedProducts || [];
    const pendingSizeTexts = Array.isArray(session.pendingSizeTexts) ? session.pendingSizeTexts : [];
    const hasAnyOrderInput = relayBuffer.length > 0 || matched.length > 0 || pendingSizeTexts.length > 0;

    if (!hasAnyOrderInput) {
      const helpMsg =
        'Ainda quer enviar as fotos do seu pedido? 😊\n\n' +
        'Pode mandar aqui mesmo: *foto do produto + tamanho + quantidade*.\n' +
        'Se precisar de ajuda ou tiver *dúvidas*, me chama por aqui que eu te explico.';
      try {
        await zapi.sendText(phone, helpMsg);
        appendHistory(session, 'assistant', helpMsg);
        conversationMemory.refreshConversationMemory(session, { assistantText: helpMsg });
      } catch (err) {
        logger.error({ phone, err: err.message }, '[FecharPedido] Falha ao enviar lembrete sem itens');
      }
      session.fecharPedidoEmptyPromptSentAt = Date.now();
      persistSession(phone);
      logger.info({ phone }, '[FecharPedido] Nenhum item recebido — lembrete enviado sem handoff');
      return;
    }

    session.supportMode = 'human_pending';

    // Monta resumo dos produtos identificados pela IA de visão.
    // Divide em confirmados (alta confiança) e incertos (precisa revisão humana).
    const confirmed = matched.filter((m) => !m.uncertain);
    const uncertain = matched.filter((m) => m.uncertain);

    /**
     * Extrai quantidade total de peças da caption da cliente.
     * Padrão: números antes de letras de tamanho (ex: "2g" → 2, "3m 2g" → 5, "2p" → 2).
     * Fallback: 1 se nenhum número for encontrado.
     */
    function parseQtyFromCaption(caption) {
      if (!caption) return 1;
      const matches = [...caption.matchAll(/\b(\d+)\s*[a-z]/gi)];
      if (matches.length === 0) return 1;
      return matches.reduce((sum, m) => sum + parseInt(m[1], 10), 0);
    }

    const fmt = (v) => v.toFixed(2).replace('.', ',');

    let cartSummaryForClient = '';
    let cartSummaryForAdmin = '';
    let totalAdminPix = 0;
    let orphanTexts = [];

    if (matched.length > 0) {
      // --- Bloco CLIENTE ---
      // Atacado B2B: agrupa por REFERÊNCIA (não por productId). Variantes de
      // cor da mesma Ref viram uma linha só, com quantidades somadas.
      // Produto sem Ref no nome cai no fallback por productId (linha isolada).
      const productGroups = new Map();
      for (const m of confirmed) {
        const refKey = extractRefKey(m.name);
        const key = refKey || `pid:${m.productId}`;
        if (!productGroups.has(key)) {
          productGroups.set(key, {
            name: stripVariantSuffix(m.name),
            unitPrice: parseFloat(m.price) || 0,
            totalQty: 0,
            captions: [],
          });
        }
        const g = productGroups.get(key);
        const currentPrice = parseFloat(m.price) || 0;
        if (Math.abs(currentPrice - g.unitPrice) > 0.01) {
          logger.warn(
            { refKey: key, productId: m.productId, expected: g.unitPrice, got: currentPrice },
            '[FecharPedido] Preços divergentes na mesma referência — revisar catálogo',
          );
        }
        const qty = parseQtyFromCaption(m.caption);
        g.totalQty += qty;
        const normalized = normalizeCartLabel(m.caption);
        if (normalized) g.captions.push(normalized);
      }

      let totalPix = 0;
      const confirmedLines = [];
      let lineIdx = 0;
      for (const g of productGroups.values()) {
        const pixUnit  = g.unitPrice * 0.90;
        const pixTotal = pixUnit * g.totalQty;
        totalPix += pixTotal;
        const name           = normalizeCartLabel(g.name);
        const uniqueCaptions = [...new Set(g.captions.filter(Boolean))];
        const sizeLabel      = uniqueCaptions.join(' · ') || '-';
        confirmedLines.push(`*${++lineIdx}. ${name}*\n    ${sizeLabel}\n    R$ ${fmt(pixUnit)}/un × ${g.totalQty} = *R$ ${fmt(pixTotal)} no PIX*`);
      }

      if (confirmed.length > 0) {
        cartSummaryForClient =
          `\n\n📦 *Resumo do que recebi:*\n` +
          confirmedLines.join('\n\n') +
          `\n\n─────────────────` +
          `\n💰 *Total no PIX:* R$ ${fmt(totalPix)}` +
          `\n_Desconto de 10% já aplicado. Valores e frete confirmados pela consultora._ 😊`;
      }

      // Avisa que fotos incertas também foram recebidas (sem citar produto errado)
      if (uncertain.length > 0) {
        const extra = uncertain.length === 1
          ? `\n_1 foto adicional será confirmada pela consultora._`
          : `\n_${uncertain.length} fotos adicionais serão confirmadas pela consultora._`;
        cartSummaryForClient += extra;
      }

      // --- Bloco ADMIN ---
      const adminParts = [];

      if (confirmed.length > 0) {
        const confirmedAdminLines = confirmed.map((m, i) => {
          const unitPrice = parseFloat(m.price) || 0;
          const qty       = parseQtyFromCaption(m.caption);
          const pixPrice  = unitPrice * qty * 0.90;
          totalAdminPix  += pixPrice;
          const conf      = Math.round((m.confidence || 0) * 100);
          const sizeQty   = m.caption ? ` | _"${m.caption}"_` : '';
          const qtyLabel  = qty > 1 ? ` ×${qty}` : '';
          return `${i + 1}. #${m.productId} — ${m.name}${sizeQty}${qtyLabel} — R$ ${fmt(pixPrice)} PIX _(${conf}% confiança)_`;
        });
        adminParts.push(
          `\n\n🛒 *CARRINHO IDENTIFICADO (IA):*\n` +
          confirmedAdminLines.join('\n') +
          `\n💰 *Total no PIX:* R$ ${fmt(totalAdminPix)}`,
        );
      }

      if (uncertain.length > 0) {
        adminParts.push(
          `\n\n⚠️ *FOTOS NÃO IDENTIFICADAS COM CERTEZA* (revisar manualmente):\n` +
          uncertain.map((m, i) => {
            const unitPrice = parseFloat(m.price) || 0;
            const qty       = parseQtyFromCaption(m.caption);
            const pixPrice  = unitPrice * qty * 0.90;
            const conf      = Math.round((m.confidence || 0) * 100);
            const sizeQty   = m.caption ? ` | _"${m.caption}"_` : '';
            const qtyLabel  = qty > 1 ? ` ×${qty}` : '';
            return `${i + 1}. Palpite: #${m.productId} — ${m.name}${sizeQty}${qtyLabel} — R$ ${fmt(pixPrice)} PIX _(${conf}% confiança — CONFIRMAR)_`;
          }).join('\n'),
        );
      }

      // Textos de grade que sobraram na fila (sem foto correspondente) vão pra
      // vendedora como órfãos — nunca descartar silenciosamente.
      orphanTexts = pendingSizeTexts
        .map((o) => (typeof o === 'string' ? o : o?.text))
        .filter(Boolean);
      if (orphanTexts.length > 0) {
        adminParts.push(
          `\n\n⚠️ *TEXTOS NÃO PAREADOS* (grades sem foto correspondente — confirmar com cliente):\n` +
          orphanTexts.map((t) => `• "${t}"`).join('\n'),
        );
        logger.warn(
          { phone, orphans: orphanTexts },
          '[FecharPedido] Textos órfãos no handoff — revisar com cliente',
        );
      }

      cartSummaryForAdmin = adminParts.join('');
    }

    // Mensagem ao cliente: acolhedora, confirma recebimento, avisa sobre próximos passos
    const confirmMsg =
      `✅ Recebi todos os seus produtos! 🎉\n` +
      `Nossa consultora vai entrar em contato em breve para confirmar os itens, tamanhos, valor do frete e finalizar o pedido. 🌸` +
      cartSummaryForClient;
    try {
      await zapi.sendText(phone, confirmMsg);
      appendHistory(session, 'assistant', confirmMsg);
    } catch (err) {
      logger.error({ phone, err: err.message }, '[FecharPedido] Falha ao enviar confirmação');
    }

    // Upsell pós-checkout: mostra todas as categorias (cards separados com foto + botão).
    // Dá última chance do lojista acrescentar algo antes do handoff final.
    try {
      await zapi.delay(1200);
      const vocative = session.customerName ? `, ${session.customerName}` : '';
      const upsellPrompts = [
        `Imagina${vocative}! Tô aqui pra te ajudar a deixar sua loja com as peças mais vendidas da região ✨ Dá uma olhadinha nos lançamentos da semana e nas outras linhas — inclusive tenho itens em promoção 💛`,
        `Antes da consultora entrar${vocative}, deixa eu te mostrar o que tá saindo mais por aqui ✨ Lançamentos da semana, as linhas completas e a vitrine de promoção — pode ser que algum item faça sentido no seu mix 💛`,
        `${session.customerName || 'Amiga'}, tô aqui pra te ajudar a montar sua loja com o que mais vende no atacado 💛 Dá uma passada rápida nos lançamentos, nas linhas e nos itens em promoção — vai que rola acrescentar algo.`,
      ];
      const upsellMsg = upsellPrompts[Math.floor(Math.random() * upsellPrompts.length)];
      await sendTextWithTTS(phone, upsellMsg);
      await sendCategoryShowcase(phone, session, { includeImages: false });
      logger.info({ phone }, '[FecharPedido] Showcase de upsell enviado');
    } catch (err) {
      logger.warn({ phone, err: err.message }, '[FecharPedido] Falha no showcase de upsell');
    }

    // ADR-044: espera 30s após o upsell antes de mandar qualquer coisa pra vendedora.
    // Objetivo: dar tempo do cliente acrescentar algo via catálogo/showcase se for o caso.
    await new Promise((r) => setTimeout(r, 30_000));

    // Header + replay fiel do buffer (foto + legenda exata que o cliente enviou)
    const openingMsg =
      `📦 *NOVO PEDIDO — Agente Belux*\n` +
      `📱 wa.me/${phone}\n` +
      (session.customerName ? `👤 *${session.customerName}*\n` : '') +
      `\n_Fotos e legendas exatas do cliente abaixo 👇_`;

    const buffer = relayBuffer;

    for (const adminPhone of ADMIN_PHONES) {
      try { await zapi.sendText(adminPhone, openingMsg); } catch (err) {
        logger.error({ phone, adminPhone, err: err.message }, '[FecharPedido] Falha no opening');
      }
      for (const ev of buffer) {
        try {
          if (ev.type === 'image') {
            await zapi.sendImage(adminPhone, ev.imageUrl, ev.caption || '');
          } else if (ev.type === 'text') {
            const textToSend = ev.quote ? `↩️ ${ev.text}` : ev.text;
            await zapi.sendText(adminPhone, textToSend);
          } else if (ev.type === 'audio') {
            await zapi.sendText(adminPhone, `🎙️ _Cliente mandou áudio (abra o chat: wa.me/${phone})_`);
          }
          await zapi.delay(400);
        } catch (err) {
          logger.error({ phone, adminPhone, err: err.message }, '[FecharPedido] Falha no replay do buffer');
        }
      }
    }

    // Resumo formatado pela IA (Gemini). Fallback: formato hard-coded cartSummaryForAdmin.
    let formattedSummary = null;
    if (matched.length > 0) {
      try {
        formattedSummary = await ai.formatOrderSummaryForSeller({
          matchedProducts: matched,
          orphanTexts,
          customerName: session.customerName,
          totalPix: totalAdminPix,
        });
      } catch (err) {
        logger.warn({ phone, err: err.message }, '[FecharPedido] Gemini summary falhou — usando fallback');
      }
    }
    const finalSummary = formattedSummary || cartSummaryForAdmin;

    const closeMsg =
      `✅ *FIM DO ENVIO*\n` +
      `📱 wa.me/${phone}\n` +
      (session.customerName ? `👤 *${session.customerName}*\n` : '') +
      `\n_A cliente está aguardando seu contato para fechar o pedido._\n` +
      finalSummary;

    for (const adminPhone of ADMIN_PHONES) {
      try {
        await zapi.sendText(adminPhone, closeMsg);
        logger.info({ phone, adminPhone, aiUsed: !!formattedSummary }, '[FecharPedido] Fim do relay enviado');
      } catch (err) {
        logger.error({ phone, adminPhone, err: err.message }, '[FecharPedido] Falha ao enviar fim do relay');
      }
    }

    // ── PDF do pedido (admin + cliente) ────────────────────────────────
    // Gera o PDF só se houve match confirmado; incertos não entram para evitar
    // confusão no documento formal. Falha silenciosa não bloqueia o fluxo —
    // o resumo de texto acima já supre a vendedora com tudo que precisa.
    if (confirmed.length > 0) {
      let pdfBuffer = null;
      const pdfGroups = buildProductGroupsFromMatched(confirmed);
      const pdfTotalGross = totalAdminPix / (1 - HANDOFF_PIX_DISCOUNT_PCT / 100);
      const pdfFileName = `pedido-belux-${String(phone).replace(/\D/g, '')}-${Date.now()}.pdf`;

      try {
        pdfBuffer = await pdfService.generateOrderPdf({
          customerName: session.customerName,
          phone,
          productGroups: pdfGroups,
          total: pdfTotalGross,
          pixDiscountPct: HANDOFF_PIX_DISCOUNT_PCT,
        });
      } catch (err) {
        logger.error(
          { phone, err: err?.message || String(err) },
          '[FecharPedido] Falha ao gerar PDF — pulando envio',
        );
      }

      if (pdfBuffer) {
        for (const adminPhone of ADMIN_PHONES) {
          try {
            await zapi.sendDocument(adminPhone, pdfBuffer, pdfFileName);
            logger.info({ phone, adminPhone, fileName: pdfFileName }, '[FecharPedido] PDF enviado ao admin');
          } catch (err) {
            logger.error({ phone, adminPhone, fileName: pdfFileName, err: err.message, status: err?.response?.status, data: err?.response?.data }, '[FecharPedido] Falha ao enviar PDF ao admin — sendDocument');
          }
        }
        try {
          await zapi.sendDocument(phone, pdfBuffer, pdfFileName);
          logger.info({ phone, fileName: pdfFileName }, '[FecharPedido] PDF enviado ao cliente');
        } catch (err) {
          logger.error({ phone, fileName: pdfFileName, err: err.message, status: err?.response?.status, data: err?.response?.data }, '[FecharPedido] Falha ao enviar PDF ao cliente — sendDocument');
        }
      }
    }

    session.matchedProducts = [];
    session.pendingSizeTexts = [];
    session.fecharPedidoRelayBuffer = [];
    persistSession(phone);
  }, 180_000);

  fecharPedidoInactivityTimers.set(phone, timer);
  logger.info({ phone }, '[FecharPedido] Timer de 180s agendado');
}

async function handoffToHuman(phone, session) {
  if (session.supportMode === 'human_pending') {
    logger.info({ phone }, '[HumanHandoff] Duplicate request while already pending');
    await sendTextWithTTS(phone, 'Perfeito 😊 Nossa consultora já foi avisada e vai seguir com você por aqui.');
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

  await sendTextWithTTS(
    phone,
    'Perfeito 😊 Vou sinalizar nossa consultora aqui para seguir com você no atendimento.'
  );

  if (!ADMIN_PHONES.length) {
    logger.warn({ phone }, '[HumanHandoff] ADMIN_PHONES not configured — skipping admin notification');
    return;
  }

  const adminMsg =
    `🙋 *ATENDIMENTO HUMANO SOLICITADO*\n` +
    `📱 wa.me/${phone}\n` +
    (session.customerName ? `👤 ${session.customerName}\n` : '') +
    `${cartBlock}`;

  for (const adminPhone of ADMIN_PHONES) {
    try {
      await zapi.sendText(adminPhone, adminMsg);
      logger.info({ phone, adminPhone, itemCount }, '[HumanHandoff] Admin notified');
    } catch (err) {
      logger.error({ err: err?.message || String(err), adminPhone }, '[HumanHandoff] Failed to notify admin');
    }
  }
}

/**
 * Executa a notificação real ao admin + persistência no Supabase + reset da FSM.
 * Chamada por scheduleUpsellAndHandoff (após 5min) ou imediatamente se cliente
 * confirmar de novo durante o upsell.
 */
async function executeHandoff(phone, session) {
  const handoffConfirmationText = 'Perfeito! 🎉 Seu pedido foi confirmado e nossa consultora vai entrar em contato em breve para finalizar tudo com você. Obrigada pela preferência! 💕';

  if (session.handoffDone) {
    logger.warn({ phone }, '[Handoff] executeHandoff bloqueado — handoffDone já true');
    return;
  }

  // Usa snapshot do upsell se disponível (pode ter itens novos adicionados durante os 5min)
  const itemsToSend = session.upsellSnapshot?.items || session.items;
  const summaryToSend = session.upsellSnapshot?.summary || buildCartSummary(session, '🛒 *RESUMO DO SEU PEDIDO*').summary;
  const totalToSend   = session.upsellSnapshot?.total   || buildCartSummary(session, '🛒 *RESUMO DO SEU PEDIDO*').total;
  const productGroups = buildProductGroupsFromCart({ items: itemsToSend });
  const pdfFileName = `pedido-belux-${String(phone).replace(/\D/g, '')}-${Date.now()}.pdf`;
  let pdfBuffer = null;

  try {
    pdfBuffer = await pdfService.generateOrderPdf({
      customerName: session.customerName,
      phone,
      productGroups,
      total: totalToSend,
      pixDiscountPct: HANDOFF_PIX_DISCOUNT_PCT,
    });
  } catch (err) {
    logger.error(
      { phone, err: err?.message || String(err), stack: err?.stack },
      '[Handoff] Falha ao gerar PDF do pedido — usando fluxo legado'
    );
  }

  // ── Confirmação ao cliente ────────────────────────────────────────────
  // Enviada sempre que executeHandoff dispara (timer 5min OU finalização durante upsell).
  // handoffToConsultant já enviou o resumo do pedido — aqui é o encerramento/agradecimento.
  try {
    await sendTextWithTTS(phone, handoffConfirmationText);
  } catch (err) {
    logger.warn({ err: err?.message }, '[Handoff] Falha ao enviar confirmação de texto ao cliente — continuando');
  }

  if (pdfBuffer) {
    try {
      await zapi.sendDocument(phone, pdfBuffer, pdfFileName);
      logger.info({ phone, fileName: pdfFileName }, '[Handoff] PDF sent to customer');
    } catch (err) {
      logger.error(
        { phone, fileName: pdfFileName, err: err?.message, status: err?.response?.status, data: err?.response?.data },
        '[Handoff] Falha ao enviar PDF ao cliente — sendDocument'
      );
    }
  }

  // ── Notifica o admin ──────────────────────────────────────────────────
  if (!pdfBuffer) {
    await sendLegacyHandoffToAdmins(phone, session, summaryToSend, itemsToSend);
  } else if (!ADMIN_PHONES.length) {
    logger.warn({ phone }, '[Handoff] ADMIN_PHONES not configured — skipping admin notification');
  } else {
    const adminHeader = buildAdminPdfHeader(phone, session.customerName, productGroups, totalToSend);

    for (const adminPhone of ADMIN_PHONES) {
      try {
        await zapi.sendText(adminPhone, adminHeader);
        await zapi.sendDocument(adminPhone, pdfBuffer, pdfFileName);
        logger.info({ phone, adminPhone, fileName: pdfFileName }, '[Handoff] PDF sent to admin');
      } catch (err) {
        logger.error(
          { err: err?.message || String(err), adminPhone },
          '[Handoff] Falha ao enviar PDF ao admin — usando fallback legado'
        );

        try {
          await zapi.sendText(adminPhone, '⚠️ Falha ao anexar o PDF. Reenviando o pedido no formato legado.');
        } catch (warnErr) {
          logger.warn({ err: warnErr?.message, adminPhone }, '[Handoff] Falha ao avisar admin sobre fallback do PDF');
        }

        try {
          await sendLegacyHandoffToAdmin(adminPhone, phone, session, summaryToSend, itemsToSend);
        } catch (fallbackErr) {
          logger.error(
            { err: fallbackErr?.message || String(fallbackErr), adminPhone },
            '[Handoff] Failed to notify admin after PDF fallback'
          );
        }
      }
    }
  }

  // ── Persiste no Supabase ──────────────────────────────────────────────
  try {
    await db.saveOrder({
      phone,
      customerName: session.customerName || null,
      items: itemsToSend,
      total: totalToSend,
    });
    logger.info({ phone, total: totalToSend }, '[Handoff] Order persisted to Supabase');
  } catch (err) {
    logger.error({ err: err?.message || String(err) }, '[Handoff] Failed to persist order — handoff continues');
  }

  // ── Reset ──────────────────────────────────────────────────────────────
  resetPurchaseFlow(session);
  session.handoffDone  = true;
  session.upsellPending = false;
  session.upsellSnapshot = null;

  await persistSession(phone);
  logger.info({ phone }, '[Handoff] executeHandoff concluído');
}

/**
 * Agenda o envio do pedido para o admin em 5 minutos (janela de upsell).
 * Enquanto aguarda, reexibe o showcase de categorias (todas as 5) para o cliente
 * dar uma última olhada e eventualmente acrescentar itens.
 * Se o cliente finalizar de novo durante o upsell → handoff imediato via interceptor.
 */
async function scheduleUpsellAndHandoff(phone, session) {
  const vocative = session.customerName ? `, ${session.customerName}` : '';
  const upsellMsgs = [
    `Imagina${vocative}! Tô aqui pra te ajudar a deixar sua loja com as peças mais vendidas da região ✨ Antes de fechar, dá uma olhadinha nos lançamentos da semana e nas outras linhas — inclusive tenho itens em promoção 💛`,
    `Antes da consultora entrar${vocative}, deixa eu te mostrar o que tá saindo mais por aqui ✨ Lançamentos da semana, as linhas completas e a vitrine de promoção — pode ser que algum item faça sentido no seu mix 💛`,
    `${session.customerName || 'Amiga'}, tô aqui pra te ajudar a montar sua loja com o que mais vende no atacado 💛 Antes de fechar, dá uma passada rápida nos lançamentos, nas linhas e nos itens em promoção — vai que rola acrescentar algo no pedido.`,
  ];
  const upsellMsg = upsellMsgs[Math.floor(Math.random() * upsellMsgs.length)];

  try {
    await sendTextWithTTS(phone, upsellMsg);
    await sendCategoryShowcase(phone, session, { includeImages: false });
    await persistSession(phone);
  } catch (err) {
    logger.warn({ err: err?.message, phone }, '[UpsellHandoff] Falha ao exibir showcase de upsell');
  }

  // Cancela timer anterior se houver (idempotência)
  const existing = upsellHandoffTimers.get(phone);
  if (existing?.timer) clearTimeout(existing.timer);

  const delayMs = Math.max(0, (session.handoffDueAt || 0) - Date.now());
  const timer = setTimeout(async () => {
    upsellHandoffTimers.delete(phone);
    try {
      const sess = sessions[phone];
      if (!sess || sess.handoffDone) return;

      // Se o cliente adicionou itens durante o upsell, avisa e atualiza snapshot
      const prevCount = sess.upsellSnapshot?.items?.length || 0;
      if (sess.items?.length > prevCount) {
        const { summary, total } = buildCartSummary(sess, '🛒 *RESUMO DO SEU PEDIDO*');
        sess.upsellSnapshot = { items: [...sess.items], total, summary };
        await zapi.sendText(phone,
          `✅ Ótimo! Já acrescentei os novos itens.\n\n${summary}\n\nAgora sim, vou passar tudo pra nossa consultora! 💕`
        );
      }

      await executeHandoff(phone, sess);
    } catch (err) {
      logger.error({ err: err?.message, phone }, '[UpsellHandoff] Falha ao executar handoff diferido');
    }
  }, delayMs);

  upsellHandoffTimers.set(phone, { timer });
  logger.info({ phone, delayMs }, '[UpsellHandoff] Timer de handoff agendado');
}

async function handoffToConsultant(phone, session) {
  // Guard: upsell já ativo (cliente finalizou de novo durante os 5min)
  if (session.upsellPending) {
    logger.info({ phone }, '[Handoff] upsellPending=true — handoff diferido já em curso');
    return;
  }

  // Guard: prevent duplicate handoff in the same session
  if (session.handoffDone) {
    logger.warn({ phone }, '[Handoff] Duplicated handoff blocked');
    return;
  }

  // Guard race condition: cliente clica "Finalizar" enquanto matchProductFromImage
  // ainda processa (até 8s). Sem isso, lê items vazio e responde "carrinho vazio"
  // mesmo o pushCartItem da foto estando para rodar nos próximos ms.
  await awaitPendingImageMatches(session);

  if (!session.items || session.items.length === 0) {
    await zapi.sendText(phone, '😊 Seu carrinho está vazio! Adicione alguns produtos antes de fechar o pedido.');
    return;
  }

  const { summary, total } = buildCartSummary(session, '🛒 *RESUMO DO SEU PEDIDO*');

  // Verifica o pedido mínimo de R$ 150
  if (total < 150) {
    await sendTextWithTTS(phone, `⚠️ O pedido mínimo da nossa loja no atacado é de *R$ 150,00*.\n\nSeu carrinho atual está em *${woocommerce.formatPrice(total)}*.\n\nFalta bem pouquinho! Que tal dar mais uma olhadinha nos nossos produtos para atingir o mínimo? 😊`);
    session.purchaseFlow.state = 'idle';
    return;
  }

  // ── 1. Notifica o cliente (igual antes) ──────────────────────────────────
  const customerMsg =
    `${summary}\n\n` +
    `✅ *Pedido recebido!*\n` +
    `Nossa consultora vai confirmar os detalhes e combinar pagamento e envio em breve. 😊\n\n` +
    `_Qualquer dúvida, é só chamar!_ 💕`;

  await sendTextWithTTS(phone, customerMsg);
  logger.info({ phone, total, itemCount: session.items.length }, '[Handoff] Order summary sent to customer');

  // ── 2. Salva snapshot e agenda upsell + handoff diferido ─────────────────
  session.upsellSnapshot = { items: [...session.items], total, summary };
  session.upsellPending  = true;
  session.handoffDueAt   = Date.now() + 5 * 60 * 1000;
  persistSession(phone);

  // Fire-and-forget: não bloqueia o webhook
  scheduleUpsellAndHandoff(phone, session).catch(err =>
    logger.error({ err: err?.message, phone }, '[UpsellHandoff] Erro em scheduleUpsellAndHandoff')
  );
}

app.get('/', (_req, res) => res.json({ status: 'online', activeSessions: Object.keys(sessions).length }));

app.delete('/admin/reset-sessions', async (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.headers['x-admin-token'] !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const count = Object.keys(sessions).length;
  for (const phone of Object.keys(sessions)) delete sessions[phone];
  try {
    await db.clearAllSessions();
  } catch (err) {
    logger.error({ err: err.message }, '[Admin] Erro ao limpar sessões no Supabase');
    return res.status(500).json({ error: 'Supabase error', detail: err.message });
  }
  logger.info({ count }, '[Admin] Todas as sessões foram limpas');
  res.json({ ok: true, cleared: count });
});

server.listen(PORT, () => {
  logger.info({ port: PORT, tts: TTS_ENABLED, ttsModel: process.env.TTS_MODEL || 'gemini-2.5-flash-preview-tts' }, '🚀 Agente Belux running');

  // Pré-aquece o cache de produtos imediatamente após o servidor subir.
  // Fire-and-forget: nunca bloqueia o servidor — apenas loga se falhar.
  // Com o cache aquecido, o primeiro "oi" de qualquer cliente é respondido
  // em milissegundos em vez de esperar 30s pelo WordPress.
  woocommerce.warmupCache().catch((err) => {
    logger.error({ err: err.message }, '[Startup] warmupCache falhou inesperadamente');
  });

  // Catalog sync automático (boot em 30s + incremental 1h + reconcile 24h).
  // Garante que produtos novos/atualizados/deletados no WooCommerce fiquem
  // refletidos no Supabase sem intervenção manual.
  catalogSync.start();

  // Recover handoffs pendentes: sessões que tinham upsellPending=true quando o
  // servidor foi reiniciado recebem o timer recriado com o delay restante.
  db.getExpiredSessions(0).then(rows => {
    const pending = rows.filter(r => r.data?.upsellPending && !r.data?.handoffDone);
    if (pending.length === 0) return;
    logger.info({ count: pending.length }, '[Boot] Recriando timers de handoff pendentes');
    for (const row of pending) {
      const phone = row.phone;
      const sess  = row.data;
      sessions[phone] = sess;
      scheduleUpsellAndHandoff(phone, sess).catch(err =>
        logger.error({ phone, err: err?.message }, '[Boot] Falha ao recriar timer de handoff')
      );
    }
  }).catch(err => logger.error({ err: err?.message }, '[Boot] Falha ao verificar handoffs pendentes'));
});
