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
const ADMIN_PHONES = (process.env.ADMIN_PHONES || process.env.ADMIN_PHONE || '')
  .split(',').map(n => n.trim()).filter(Boolean);
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
  text = text.replace(/[\n\r]/g, ' '); // normalizar quebras de linha

  // ── Expressões de "N de cada tamanho" (PT-BR naturais) ──────────────────
  // Ex: "1 de cada tamanho", "um de cada", "2 de cada", "manda toda a grade"
  {
    const WORD_TO_NUM = { um: 1, uma: 1, dois: 2, duas: 2, três: 3, tres: 3, quatro: 4, cinco: 5 };
    const eachPattern = /\b(?:manda\s+)?(\d+|um|uma|dois|duas|tr[eê]s|quatro|cinco)\s+de\s+cada\s*(?:tamanho)?\b/i;
    const fullGradePattern = /\b(?:toda\s+[ao]\s+grade|uma?\s+grade\s+completa|manda\s+toda\s+[ao]\s+grade)\b/i;
    const eachMatch = text.match(eachPattern);
    const fullGrade = fullGradePattern.test(text);
    if (eachMatch || fullGrade) {
      const rawQty = eachMatch ? eachMatch[1].toLowerCase() : '1';
      const qty = WORD_TO_NUM[rawQty] ?? parseInt(rawQty, 10);
      if (qty > 0 && qty <= 999) {
        return knownSizes.map(s => ({ size: s, qty }));
      }
    }
  }

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

  // Passe 3: tamanhos sem quantidade (ex: "gg", "p m g") → qty implícita = 1.
  // Só adiciona tamanhos que os passes 1 e 2 ainda não capturaram (não sobrescreve).
  const regexSizeOnly = new RegExp(`\\b(${sizesPattern})\\b`, 'gi');
  while ((match = regexSizeOnly.exec(text)) !== null) {
    const sizeOnly = String(match[1]).toUpperCase();
    if (knownSizesUpper.has(sizeOnly) && !totalsBySize.has(sizeOnly)) {
      addGradeEntry(sizeOnly, '1');
    }
  }

  const validResults = orderedSizes.map(size => ({ size, qty: totalsBySize.get(size) }));

  // Detecta tamanhos "órfãos": padrões de tamanho comum (P, M, G, GG, etc.) que o
  // cliente digitou no texto mas NÃO correspondem a nenhum knownSize do produto.
  // Sem isso, "1P" num produto que só tem M/G/GG é silenciosamente descartado.
  const COMMON_SIZES = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'EXGG', 'EXG', 'XGG', 'EG', 'XXG', 'XXXG'];
  const orphanSizes = [];
  // Regex genérica: captura padrões qty+size ou size+qty com qualquer letra(s) maiúscula(s)
  const orphanRegex = /(?:(\d+)\s*(?:do|da|de|dos|das|x|:|tamanho)?\s*([A-Z]{1,4})(?=\s|,|;|\.|$))|(?:\b([A-Z]{1,4})\s*[=:\-]\s*(\d+))/gi;
  let oMatch;
  while ((oMatch = orphanRegex.exec(text)) !== null) {
    const orphanSize = (oMatch[2] || oMatch[3] || '').toUpperCase();
    if (
      orphanSize &&
      !knownSizesUpper.has(orphanSize) &&
      !orphanSizes.includes(orphanSize) &&
      COMMON_SIZES.includes(orphanSize)
    ) {
      orphanSizes.push(orphanSize);
    }
  }

  if (validResults.length === 0 && orphanSizes.length === 0) return null;

  // Retorna array com grade + _orphanSizes para que os callers possam avisar o cliente.
  // Quando só há órfãos (nenhum match válido), retorna array vazio com a propriedade.
  const result = validResults.length > 0 ? validResults : [];
  result._orphanSizes = orphanSizes;
  return result;
}

// ── Sessions ──────────────────────────────────────────────────────────────
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

/** Timer de upsell pós-checkout: atrasa envio para admin em 5min, mostra categoria não vista */
const upsellHandoffTimers = new Map();
// Estrutura: phone → { timer: Timeout }

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
async function sendCategoryShowcase(phone, session) {
  const SHOWCASE_CATEGORIES = [
    { slug: 'feminino',             id: 'CAT_FEMININO',          label: 'Feminino',          desc: 'Moda íntima feminina adulta' },
    { slug: 'femininoinfantil',     id: 'CAT_FEMININOINFANTIL',  label: 'Feminino Infantil', desc: 'Conforto para as meninas' },
    { slug: 'masculino',            id: 'CAT_MASCULINO',         label: 'Masculino',         desc: 'Moda íntima masculina adulta' },
    { slug: 'masculinoinfantil',    id: 'CAT_MASCULINOINFANTIL', label: 'Masculino Infantil',desc: 'Conforto para os meninos' },
    { slug: 'lancamento-da-semana', id: 'CAT_LANCAMENTOS',       label: '🆕 Lançamentos',    desc: 'As novidades da semana' },
  ];

  for (const cat of SHOWCASE_CATEGORIES) {
    try {
      const result = await woocommerce.getProductsByCategory(cat.slug, 1, 1);
      const imageUrl = result.products?.[0]?.imageUrl || null;
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
      await zapi.delay(800); // 800ms entre cards — evita flood rejection da Z-API
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
    // Multiplica price * quantity para refletir o total real de cada linha
    const cartTotal = session.items.reduce((acc, it) => acc + parseFloat(it.price || 0) * (it.quantity || 1), 0);
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

// ── Inactivity Greeting (20 minutos sem interação) ────────────────────────
setInterval(async () => {
  const now = Date.now();
  for (const [phone, session] of Object.entries(sessions)) {
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
      if (listId === 'cart_remove_item') return 'CART_REMOVE_ITEM';
      if (listId === 'cart_other_category') return 'VER_OUTRA_CATEGORIA';
      // Sentinela determinístico — evita colisão com detector de fotos ("ver mais").
      // Interceptado no webhook e roteado direto para navegação/catálogo.
      if (listId === 'cart_more_products') return 'VER_MAIS_PRODUTOS';
      if (listId === 'falar_atendente') return 'FALAR_ATENDENTE';
      if (listId === 'buscar_produto') return 'BUSCAR_PRODUTO_MENU';
      return listId;
    }

    // Botões de cards sendButtonList (buttonsResponseMessage) — ex: sendCategoryShowcase
    // Z-API envia este campo para cliques em send-button-list, NÃO como button_reply
    const brmId = event.buttonsResponseMessage?.buttonId;
    if (brmId) {
      logger.info({ buttonId: brmId }, '[extractText] buttonsResponseMessage recebido');
      // Normaliza IDs legados lowercase → sentinelas canônicas
      if (brmId === 'cat_feminina')        return 'CAT_FEMININO';
      if (brmId === 'cat_masculina')       return 'CAT_MASCULINO';
      if (brmId === 'cat_lancamentos')     return 'CAT_LANCAMENTOS';
      if (brmId === 'btn_outra_cat')       return 'OUTRA CATEGORIA';
      if (brmId === 'cart_view')           return 'CART_VIEW';
      if (brmId === 'cart_finalize')       return 'CART_FINALIZE';
      if (brmId === 'cart_remove_item')    return 'CART_REMOVE_ITEM';
      if (brmId === 'cart_other_category') return 'VER_OUTRA_CATEGORIA';
      if (brmId === 'cart_more_products')  return 'VER_MAIS_PRODUTOS';
      if (brmId === 'falar_atendente')     return 'FALAR_ATENDENTE';
      if (brmId === 'buscar_produto')      return 'BUSCAR_PRODUTO_MENU';
      // IDs já canônicos (CAT_MASCULINO, CAT_FEMININO, CAT_FEMININOINFANTIL,
      // CAT_MASCULINOINFANTIL, CAT_LANCAMENTOS, buy_*, size_*, qty_*, etc.)
      return brmId;
    }

    // Intercepta botões da Z-API e trata como texto transparente para a IA
    if (event.type === 'button_reply' && event.buttonReply?.id) {
       if (event.buttonReply.id === 'btn_outra_cat') return 'OUTRA CATEGORIA';
       if (event.buttonReply.id === 'cart_view') return 'CART_VIEW';
       if (event.buttonReply.id === 'cart_finalize') return 'CART_FINALIZE';
       if (event.buttonReply.id === 'cart_remove_item') return 'CART_REMOVE_ITEM';
       if (event.buttonReply.id === 'cart_other_category') return 'VER_OUTRA_CATEGORIA';
       if (event.buttonReply.id === 'cart_more_products') return 'VER_MAIS_PRODUTOS';
       if (event.buttonReply.id === 'falar_atendente') return 'FALAR_ATENDENTE';
       if (event.buttonReply.id === 'cat_feminina')    return 'CAT_FEMININO';
       if (event.buttonReply.id === 'cat_masculina')   return 'CAT_MASCULINO';
       if (event.buttonReply.id === 'cat_lancamentos') return 'CAT_LANCAMENTOS';
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

    // ── Cancela resumo silencioso agendado (ADR-035) ──────────────────────
    // Qualquer nova interação do cliente cancela o timer de 30s.
    // O timer é reiniciado pelo próximo add bem-sucedido se aplicável.
    if (from && silentAddDebounce.has(from)) {
      clearTimeout(silentAddDebounce.get(from).timer);
      silentAddDebounce.delete(from);
      logger.debug({ from }, '[SilentAdd] Timer de resumo cancelado — nova interação recebida');
    }
    // ────────────────────────────────────────────────────────────────────

    const messageId = body?.messageId;

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

      // buy_ events são debounced: acumula cliques por 15s antes de processar
      // buy_variant_ tem handler próprio em handlePurchaseFlowEvent — NÃO deve passar pelo debounce
      if (fsmEventId.startsWith('buy_') && !fsmEventId.startsWith('buy_variant_')) {
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
      logger.warn({ from, bodyKeys: Object.keys(body), hasList: Boolean(body.listResponseMessage), hasBtn: Boolean(body.buttonsResponseMessage) }, '[Webhook] extractTextFromEvent retornou vazio — evento descartado');
      return;
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

Vamos lá! 👀`;

      // Texto TTS — sem markdown, escrito para ser falado
      const welcomeTTS = `${turno}! Que bom ter você aqui! Sou a Bela, consultora da Belux Moda Íntima, e vou te acompanhar em cada passo dessa compra!

Antes de começar, deixa eu te contar uma coisa importante: aqui na Belux trabalhamos no atacado. Isso significa que você compra direto da fábrica, para revender ou montar o seu estoque. O pedido mínimo é de cento e cinquenta reais. E se quiser pagar via PIX, você ainda tem desconto especial!

Agora deixa eu te mostrar como é simples comprar aqui.

Primeiro: vou te mostrar os produtos um por um, com foto, preço e tamanhos disponíveis. É só olhar com calma!

Segundo, e esse é o pulo do gato: quando você ver um modelo que gostar, desliza a foto para o lado esquerdo. Só isso. Vai aparecer um espaço para você escrever o tamanho e a quantidade que você quer. Por exemplo: se você quer duas peças de tamanho grande, escreve assim — dois G. Se quer uma grande e uma média, escreve — um G e um M. É bem isso mesmo, simples assim! E se preferir, também tem botões bem visíveis embaixo de cada foto para você clicar. Ou então manda um áudio falando o que quer — eu entendo tudo!

Terceiro: pode pedir quantas peças quiser! Vou somando tudo no seu carrinho sem pressa.

Quarto: quando terminar de escolher, é só me avisar que terminou. Eu te mando um resumo completo do pedido, com tudo certinho.

Qualquer dúvida que aparecer no caminho — sobre tamanho, disponibilidade, preço ou o que for — pode me perguntar à vontade e na hora que quiser.

Então bora lá! Vou começar te mostrando os lançamentos da semana — as peças mais novas e mais pedidas aqui da Belux. Dá uma olhada com carinho!

E sabe o que é bom? Temos muito mais além dos lançamentos! Linha feminina, infantil, masculina e outras coleções incríveis esperando por você. Se quiser explorar qualquer uma delas, é só me pedir: "quero ver feminino", ou "mostra a linha infantil", e eu apareço na hora com tudo!`;

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
        // showAllCategory já tem seu próprio catch — isso só protege contra re-throw inesperado
        logger.error({ err: err.message }, '[FirstContact] showAllCategory lançou exceção não tratada');
        await sendCategoryMenu(from, 'Por onde você quer começar?');
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

    // ── Auto-escalação: reset do contador quando IA processa com sucesso ──
    if (cleanText || action) {
      session.consecutiveFailures = 0;
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
        logger.info({ phone: from, failures: session.consecutiveFailures }, '[AutoEscalation] 2 falhas consecutivas — encaminhando para atendente');
        session.consecutiveFailures = 0;
        await handoffToHuman(from, session);
        persistSession(from);
        return;
      }

      await sendContextualFallback(from, session);
    }

    persistSession(from);

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

  await zapi.sendSizeList(phone, productForList, version, excludeSizes, true);
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
  await zapi.sendSizeQuantityList(phone, stockProduct, version, sizeDetails);
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
      await zapi.sendVariantOptionList(phone, filteredAttr, version, productName);
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
 * Normalizes text for fuzzy matching against variant option labels.
 * Strips accents and lowercases.
 */
function normalizeVariantText(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim();
}

/**
 * Tries to match user input against a list of variant options.
 * Returns the original option string on match, null otherwise.
 * Supports: exact name, normalized name, or 1-based numeric index.
 */
function matchVariant(text, options) {
  if (!text || !Array.isArray(options)) return null;
  const normInput = normalizeVariantText(text);

  // Numeric: "1" → options[0]
  const numMatch = normInput.match(/^(\d+)$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
    return null;
  }

  // Name match (normalized)
  return options.find((opt) => normalizeVariantText(opt) === normInput) || null;
}

/**
 * Tenta extrair pares (variante, grade) de uma mensagem combinada.
 *
 * Exemplos de input suportados:
 *   "mae 2g filha 1p"         → [{ variant: 'Mãe', grade: [{size:'G',qty:2}] }, { variant:'Filha', grade:[{size:'P',qty:1}] }]
 *   "mãe 3P 2M filha 1P"     → [{ variant: 'Mãe', grade: [{size:'P',qty:3},{size:'M',qty:2}] }, ...]
 *   "mae 2g"                  → [{ variant: 'Mãe', grade: [{size:'G',qty:2}] }]
 *
 * Retorna null se não encontrar nenhum par válido (variante + grade).
 *
 * @param {string} text
 * @param {string[]} attrOptions - opções de variante (ex: ['Mãe', 'Filha'])
 * @param {string[]} productSizes - tamanhos conhecidos do produto (ex: ['P','M','G','GG'])
 * @returns {{ variant: string, grade: {size: string, qty: number}[] }[] | null}
 */
function parseMultiVariantGrade(text, attrOptions, productSizes) {
  if (!text || !attrOptions?.length || !productSizes?.length) return null;
  text = text.replace(/[\n\r]/g, ' '); // normalizar quebras de linha

  // Build a regex that matches any variant option name (normalized, word boundary)
  const escapedOptions = attrOptions.map((opt) =>
    normalizeVariantText(opt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  const variantRx = new RegExp(`\\b(${escapedOptions.join('|')})\\b`, 'gi');

  // BUG-1 FIX: normalize text for matching (remove accents) while keeping original for slicing.
  // PT-BR: NFD expansion then removing combining marks yields same length as original NFC text,
  // so indices in normText map 1:1 to indices in original text (e.g. "mãe"→"mae", both length 3).
  const normText = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // Find all variant matches in order of appearance (search on normText, not original text)
  const hits = [...normText.matchAll(variantRx)].map((m) => ({
    index: m.index,
    length: m[0].length,
    original: attrOptions.find((opt) => normalizeVariantText(opt) === normalizeVariantText(m[0])) || m[0],
  }));

  if (hits.length === 0) return null;

  // Ordenação 1: grade APÓS a variante ("mãe 2G filha 1M")
  const afterPairs = [];
  for (let i = 0; i < hits.length; i++) {
    const gradeText = text.slice(hits[i].index + hits[i].length, hits[i + 1]?.index ?? text.length).trim();
    if (!gradeText) continue;
    const grade = parseGradeText(gradeText, productSizes);
    if (grade?.length > 0) afterPairs.push({ variant: hits[i].original, grade });
  }

  // Ordenação 2: grade ANTES da variante ("2G mãe 1M filha" / "3g mãe\n2P filha")
  // SEMPRE calculada — não faz short-circuit em afterPairs, para poder comparar cobertura.
  const beforePairs = [];
  for (let i = 0; i < hits.length; i++) {
    const start = i === 0 ? 0 : hits[i - 1].index + hits[i - 1].length;
    const gradeText = text.slice(start, hits[i].index).trim();
    if (!gradeText) continue;
    const grade = parseGradeText(gradeText, productSizes);
    if (grade?.length > 0) beforePairs.push({ variant: hits[i].original, grade });
  }
  // Caso especial: grade após o último hit na ordem 2 ("2G mãe filha 1M")
  if (hits.length >= 2) {
    const lastHit = hits[hits.length - 1];
    const trailingText = text.slice(lastHit.index + lastHit.length).trim();
    if (trailingText) {
      const grade = parseGradeText(trailingText, productSizes);
      if (grade?.length > 0) beforePairs.push({ variant: lastHit.original, grade });
    }
  }

  // Prefere a ordenação que cobre mais variantes distintas.
  // Ex: "3g mãe 2P filha" → afterPairs cobre 1 variante (Mãe←"2P"), beforePairs cobre 2 (Mãe←"3g", Filha←"2P").
  // Quando empatados, prefere "after" (ordem natural pt-BR).
  if (beforePairs.length > afterPairs.length) return beforePairs;
  if (afterPairs.length > 0) return afterPairs;
  return beforePairs.length > 0 ? beforePairs : null;
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
  if (eventId.startsWith('buy_variant_')) {
    const withoutPrefix = eventId.slice('buy_variant_'.length); // "{id}_{opt}"
    productId = parseInt(withoutPrefix.split('_')[0], 10);
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

  // Deduplica por productId
  if (!entry.products.some(p => p.id === product.id)) {
    entry.products.push(product);
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
        if (!pf.buyQueue.some(q => q.productId === p.id)) {
          pf.buyQueue.push({ productId: p.id, productName: p.name, productSnapshot: p });
        }
      }
      if (rest.length > 0) {
        const namesStr = rest.map(p => `*${p.name}*`).join(', ');
        await zapi.sendText(phone, `📋 Guardei na fila: ${namesStr}. Vamos começar com *${first.name}*! 😊`);
      }
      await startInteractivePurchase(phone, first, session);
    } else {
      // FSM ocupada: todos os produtos vão para a fila — UMA única notificação
      if (!Array.isArray(pf.buyQueue)) pf.buyQueue = [];
      const added = [];
      for (const p of entry.products) {
        if (String(p.id) !== String(pf.productId) && !pf.buyQueue.some(q => q.productId === p.id)) {
          pf.buyQueue.push({ productId: p.id, productName: p.name, productSnapshot: p });
          added.push(p.name);
        }
      }
      if (added.length > 0) {
        const namesStr = added.map(n => `*${n}*`).join(', ');
        const queueMsg = added.length === 1
          ? `✅ *${namesStr}* adicionado à fila!`
          : `✅ Adicionei à fila: ${namesStr}`;
        await zapi.sendText(phone, queueMsg);
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
    if (isStaleEvent(eventId, session)) {
      logger.info({ phone, eventId }, '[FSM] sizeqty_ expirado → reenviando lista combinada');
      await zapi.sendText(phone, '⏱️ Esse menu expirou! Enviando a lista atualizada...');
      const staleProd = await ensureProductStockData(
        getLoadedProductById(session, pf.productId) || session.currentProduct
      );
      if (staleProd) await sendStockAwareSizeQtyList(phone, session, staleProd, Date.now());
      return;
    }

    // Parse resiliente: sizeqty_{productId}_{size}_{qty}_v{version}
    const withoutPrefix = eventId.slice('sizeqty_'.length);
    const vIdx = withoutPrefix.lastIndexOf('_v');
    const withoutVersion = vIdx >= 0 ? withoutPrefix.slice(0, vIdx) : withoutPrefix;
    const parts = withoutVersion.split('_');
    const productIdStr = parts[0];
    const qty = parseInt(parts[parts.length - 1], 10);
    const size = parts.slice(1, -1).join('_'); // suporta tamanhos multi-char como GG, EXG

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
  if (product.imageUrl) {
    await zapi.sendImage(phone, product.imageUrl, showcaseCaption);
  } else {
    await zapi.sendText(phone, showcaseCaption);
  }
  if (nextSecondaryAttr) {
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
function buildCartSummary(session, title = '🛒 *SEU CARRINHO*') {
  let total = 0;
  let summary = `${title}\n─────────────────\n`;

  session.items.forEach((item, idx) => {
    const qty = item.quantity || 1;
    const subtotal = parseFloat(item.price) * qty; // price é unitário — multiplica pela quantidade
    total += subtotal;
    const qtyLabel = qty > 1 ? ` x${qty}` : '';
    const sizeLabel = item.variant ? `${item.variant} - ${item.size}` : item.size;
    summary += `${idx + 1}. *${item.productName}* (${sizeLabel})${qtyLabel} — ${woocommerce.formatPrice(subtotal)}\n`;
  });

  const PIX_DISCOUNT = parseFloat(process.env.PIX_DISCOUNT_PCT || '10') / 100;
  const pixTotal = total * (1 - PIX_DISCOUNT);

  summary += `─────────────────\n💰 *PIX estimado: ${woocommerce.formatPrice(pixTotal)}*\n💳 Cartão: ${woocommerce.formatPrice(total)}\n\n_Para remover um item, responda: "remover 1", "remover 2", etc._`;
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
      variant: item.variant || null,
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
  if (session.handoffDone) {
    logger.warn({ phone }, '[Handoff] executeHandoff bloqueado — handoffDone já true');
    return;
  }

  // Usa snapshot do upsell se disponível (pode ter itens novos adicionados durante os 5min)
  const itemsToSend = session.upsellSnapshot?.items || session.items;
  const summaryToSend = session.upsellSnapshot?.summary || buildCartSummary(session, '🛒 *RESUMO DO SEU PEDIDO*').summary;
  const totalToSend   = session.upsellSnapshot?.total   || buildCartSummary(session, '🛒 *RESUMO DO SEU PEDIDO*').total;

  // ── Confirmação ao cliente ────────────────────────────────────────────
  // Enviada sempre que executeHandoff dispara (timer 5min OU finalização durante upsell).
  // handoffToConsultant já enviou o resumo do pedido — aqui é o encerramento/agradecimento.
  try {
    await sendTextWithTTS(
      phone,
      'Perfeito! 🎉 Seu pedido foi confirmado e nossa consultora vai entrar em contato em breve para finalizar tudo com você. Obrigada pela preferência! 💕'
    );
  } catch (err) {
    logger.warn({ err: err?.message }, '[Handoff] Falha ao enviar confirmação ao cliente — continuando');
  }

  // ── Notifica o admin ──────────────────────────────────────────────────
  if (ADMIN_PHONES.length) {
    const adminHeader =
      `📦 *NOVO PEDIDO — Agente Belux*\n` +
      `─────────────────\n` +
      `📱 *Lojista:* wa.me/${phone}\n` +
      (session.customerName ? `👤 *Nome:* ${session.customerName}\n` : '') +
      `─────────────────\n` +
      `${summaryToSend}\n\n` +
      `📸 _Enviando fotos dos produtos a seguir..._`;

    const groups = buildProductGroupsFromCart({ items: itemsToSend });

    for (const adminPhone of ADMIN_PHONES) {
      try {
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
      } catch (err) {
        logger.error({ err: err?.message || String(err), adminPhone }, '[Handoff] Failed to notify admin');
      }
    }
  } else {
    logger.warn({ phone }, '[Handoff] ADMIN_PHONES not configured — skipping admin notification');
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
 * Enquanto aguarda, mostra ao cliente uma categoria que ele ainda não viu.
 * Se o cliente finalizar de novo durante o upsell → handoff imediato via interceptor.
 */
async function scheduleUpsellAndHandoff(phone, session) {
  const ALL_CATS = ['feminino', 'femininoinfantil', 'masculino', 'masculinoinfantil', 'lancamento-da-semana'];
  const seen = Array.isArray(session.viewedCategories) ? session.viewedCategories : [];
  const unseen = ALL_CATS.filter(c => !seen.includes(c));
  const upsellSlug = unseen[0] || 'lancamento-da-semana';
  const displayName = getCategoryDisplayName(upsellSlug);

  const upsellMsgs = [
    `Péra um segundo antes de fechar! 😄 Tenho umas peças incríveis de *${displayName}* que tô querendo muito te mostrar — às vezes a gente acha aquela pecinha que faltava no pedido 💛`,
    `Seu pedido tá guardadinho aqui 🛒 Mas olha, preciso te mostrar o que temos em *${displayName}* antes de fechar... essa linha tá saindo muito bem! Vai que você quer acrescentar? 😉`,
    `Amor, me dá só um minutinho! 🙏 Antes de mandar pra consultora, quero te mostrar *${displayName}* — é rapidinho e pode valer muito a pena no seu mix! 👀`,
  ];
  const upsellMsg = upsellMsgs[Math.floor(Math.random() * upsellMsgs.length)];

  try {
    await sendTextWithTTS(phone, upsellMsg);
    await showCategory(phone, upsellSlug, session);
    await persistSession(phone);
  } catch (err) {
    logger.warn({ err: err?.message, phone, upsellSlug }, '[UpsellHandoff] Falha ao exibir categoria de upsell');
  }

  // Cancela timer anterior se houver (idempotência)
  const existing = upsellHandoffTimers.get(phone);
  if (existing?.timer) clearTimeout(existing.timer);

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
  }, 5 * 60 * 1000); // 5 minutos

  upsellHandoffTimers.set(phone, { timer });
  logger.info({ phone, upsellSlug, delayMs: 300_000 }, '[UpsellHandoff] Timer de 5min agendado');
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
});
