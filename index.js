require('dotenv').config();

const express = require('express');
const woocommerce = require('./services/woocommerce');
const zapi = require('./services/zapi');
const ai       = require('./services/gemini');
const tts      = require('./services/tts');
const db       = require('./services/supabase');
const learnings = require('./services/learnings');

const TTS_ENABLED = process.env.TTS_ENABLED === 'true';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_PHONE = process.env.ADMIN_PHONE || null;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes inactivity
const PRODUCTS_PER_PAGE = 10;

// ── Sessions ──────────────────────────────────────────────────────────────
const sessions = {};

const SLUG_MAP = { 'infantil': 'femininoinfantil' };
function normalizeCategorySlug(slug) {
  if (!slug) return null;
  return SLUG_MAP[slug.toLowerCase()] || slug.toLowerCase();
}

async function getSession(phone) {
  if (!sessions[phone]) {
    const stored = await db.getSession(phone);
    sessions[phone] = stored
      ? {
          history:         stored.history         || [],
          items:           stored.items            || [],
          products:        stored.products         || [],
          currentProduct:  stored.current_product  || null,
          customerName:    stored.customer_name    || null,
          currentCategory: normalizeCategorySlug(stored.current_category) || null,
          currentPage:     stored.current_page     || 0,
          totalPages:      stored.total_pages      || 1,
          totalProducts:   stored.total_products   || 0,
          lastViewedProduct: stored.last_viewed_product || null,
          lastViewedProductIndex: stored.last_viewed_product_index || null,
          lastActivity:    Date.now(),
        }
      : {
          history: [], items: [], products: [],
          currentProduct: null, customerName: null,
          currentCategory: null, currentPage: 0,
          totalPages: 1, totalProducts: 0,
          lastViewedProduct: null,
          lastViewedProductIndex: null,
          lastActivity: Date.now(),
        };
  } else {
    sessions[phone].lastActivity = Date.now();
  }
  return sessions[phone];
}

function persistSession(phone) {
  const session = sessions[phone];
  if (!session) return;
  db.upsertSession(phone, session)
    .catch(err => console.error('[Supabase] upsertSession:', err.message));
}

// Clean up sessions
setInterval(() => {
  const now = Date.now();
  for (const phone of Object.keys(sessions)) {
    if (now - sessions[phone].lastActivity > SESSION_TIMEOUT_MS) {
      delete sessions[phone];
      console.log(`[Session] Expired: ${phone}`);
    }
  }
  db.deleteExpiredSessions(SESSION_TIMEOUT_MS)
    .catch(err => console.error('[Supabase] deleteExpiredSessions:', err.message));
}, 10 * 60 * 1000);

// ── Webhook ───────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  let from = '';
  try {
    const body = req.body;
    from = body?.phone || '';
    if (!from) return;
    if (body?.fromMe || body?.isGroup || body?.isStatusReply || body?.broadcast) return;
    if (body?.type === 'DeliveryCallback' || body?.type === 'ReadCallback') return;

    const messageId = body?.messageId;
    const text = extractTextFromEvent(body);
    if (!text) return;

    if (text === '[Áudio]') {
      console.log(`[Intercept] Áudio recebido. Mandando fallback humano.`);
      await zapi.replyText(from, 'Puts amada, tô sem fone aqui no depósito 😅. Consegue me digitar rapidinho o que precisa?', messageId);
      return;
    }
    if (text === '[Sticker]') {
      console.log(`[Intercept] Sticker recebido. Ignorando silenciosamente para poupar token.`);
      return;
    }

    if (text.includes('CONTA EM TRIAL') || text.includes('MENSAGEM DE TESTE')) return;

    console.log(`[MSG] ${from}: "${text}"`);
    if (messageId) zapi.readMessage(from, messageId);

    const session = await getSession(from);

    // FIX-16 — Saudação pura com histórico antigo: limpa contexto para novo atendimento.
    // Preserva carrinho e nome do cliente.
    const PURE_GREETING = /^(o+i+|ol[aá]+|bom dia|boa tarde|boa noite|hey+|hello|tudo bem|tudo bom|e a[ií]|eai|opa|boas)(\s|[!?.,]|$)/i;
    if (PURE_GREETING.test(text.trim()) && session.history.length > 2) {
      console.log(`[FIX-16] Saudação com histórico antigo — resetando contexto de ${from}`);
      session.history = [];
      session.products = [];
      session.currentProduct = null;
      session.currentCategory = null;
      session.currentPage = 0;
      session.totalPages = 1;
      session.totalProducts = 0;
      session.lastViewedProduct = null;
      session.lastViewedProductIndex = null;
    }

    // Extrai o número do produto da legenda citada — independe de bold/markdown do WhatsApp.
    // Formato esperado: "✨ 3. Nome..." ou "✨ *3. Nome...*" (com ou sem asteriscos)
    let quotedProductIdx = null;
    let finalUserText = text;

    if (body?.quotedMessage) {
      // Log do payload bruto para diagnóstico de estrutura do Z-API
      console.log(`[QuotedMsg raw] ${JSON.stringify(body.quotedMessage)}`);

      // Z-API pode entregar a caption em vários campos dependendo da versão
      const quotedText =
        body.quotedMessage.text?.message ||
        body.quotedMessage.image?.caption ||
        body.quotedMessage.imageMessage?.caption ||
        body.quotedMessage.caption ||
        null;

      console.log(`[QuotedMsg text] "${quotedText}"`);

      if (quotedText) {
        finalUserText = `[O cliente citou a seguinte mensagem sua: "${quotedText}"]\n\nMensagem do cliente: "${text}"`;

        if (session.products?.length > 0) {
          const numMatch = quotedText.match(/\u2728[^0-9]*(\d+)\./);
          if (numMatch) {
            const n = parseInt(numMatch[1], 10);
            if (n >= 1 && n <= session.products.length) {
              quotedProductIdx = n;
              console.log(`[QuotedProduct] Produto #${n} identificado na legenda citada.`);
            }
          } else {
            console.log(`[QuotedProduct] Número não encontrado na legenda.`);
          }
        }
      }
    }

    session.history.push({ role: 'user', content: finalUserText });

    // Intercept: pedido de fotos — resolve pelo número da legenda ou do próprio texto.
    // Z-API não envia quotedMessage; número inline é o fallback confiável.
    const IS_PHOTO_REQUEST = /mais foto|ver foto|outra foto|tem foto|foto dela|foto dis|mais desse|tem mais|quero ver mais|ver mais|me mostra mais|mostrar mais/i.test(text);

    if (IS_PHOTO_REQUEST && !quotedProductIdx && session.products?.length > 0) {
      const inlineNum = text.match(/\b(\d+)\b/);
      if (inlineNum) {
        const n = parseInt(inlineNum[1], 10);
        if (n >= 1 && n <= session.products.length) {
          quotedProductIdx = n;
          console.log(`[InlineNum] Produto #${n} extraído do texto.`);
        }
      }
    }

    // Se o cliente citou um produto (quotedProductIdx), qualquer mensagem curta ou pedido
    // de fotos/mais é tratado como solicitação de mais fotos daquele produto.
    const isShortMessage = text.trim().length <= 40;
    if (quotedProductIdx && (IS_PHOTO_REQUEST || isShortMessage)) {
      console.log(`[Intercept] Pedido de fotos para produto #${quotedProductIdx} — resolvido em código.`);
      await showProductPhotos(from, quotedProductIdx, session);
      if (session.history.length > 20) session.history = session.history.slice(-20);
      persistSession(from);
      return;
    }

    // Se o cliente citou uma imagem mas a caption era texto de trial (sem número),
    // e há um lastViewedProduct disponível, usa ele diretamente.
    const quotedHasImage = !!(body?.quotedMessage && (
      body.quotedMessage.image ||
      body.quotedMessage.imageMessage ||
      body.quotedMessage.type === 'image'
    ));
    if ((IS_PHOTO_REQUEST || (quotedHasImage && isShortMessage)) && !quotedProductIdx && session.lastViewedProduct) {
      const idx = session.lastViewedProductIndex || 1;
      console.log(`[LastViewed] Produto #${idx} — "${session.lastViewedProduct.name}"`);
      await showProductPhotos(from, idx, session);
      if (session.history.length > 20) session.history = session.history.slice(-20);
      persistSession(from);
      return;
    }

    if (IS_PHOTO_REQUEST && session.products?.length > 0) {
      const guide = 'Me diz o número da peça (tá no início da legenda de cada foto) e te mostro todas as imagens 😊';
      session.history.push({ role: 'assistant', content: guide });
      await zapi.sendText(from, guide);
      if (session.history.length > 20) session.history = session.history.slice(-20);
      persistSession(from);
      return;
    }

    const catalogContext = woocommerce.buildCatalogContext(session);
    const aiRaw = await ai.chat(session.history, catalogContext);
    console.log(`[AI] ${from}: "${aiRaw}"`);

    let { cleanText, action } = ai.parseAction(aiRaw);

    // Guard: bloqueia VER/BUSCAR quando a IA pergunta QUAL categoria ver (sem que o cliente pediu).
    const askingForCategory = action &&
      (action.type === 'VER' || action.type === 'BUSCAR') &&
      cleanText.includes('?') &&
      /qual.*categoria|que tipo|qual.*linha|por onde|qual.*prefer|começa por|começar por/i.test(cleanText);

    if (askingForCategory) {
      console.log(`[Guard] Token [${action.type}] descartado — IA perguntou sobre categoria junto com ação.`);
      action = null;
    }

    // Guard: bloqueia VER/BUSCAR em saudações — IA não deve disparar catálogo em "boa tarde/oi/olá".
    const isGreeting = action &&
      (action.type === 'VER' || action.type === 'BUSCAR') &&
      /^(o+i+|ol[aá]+|bom dia|boa tarde|boa noite|hey+|hello|tudo bem|tudo bom|e a[ií]|eai|opa|boas)(\s|[!?.,]|$)/i.test(text.trim());

    if (isGreeting) {
      console.log(`[Guard] Token [${action.type}] descartado — mensagem é saudação, não pedido de catálogo.`);
      action = null;
    }

    // Guard: limpa texto quando ação de produto vai disparar (sistema mostra os produtos).
    // Também descarta qualquer lista inventada com preços (R$ ou R\$).
    // Quando o sistema vai mostrar produtos, qualquer texto da IA antes é ruído — descarta.
    if (action && ['VER', 'BUSCAR', 'PROXIMOS'].includes(action.type)) {
      if (cleanText) console.log(`[Guard] Texto descartado — ação ${action.type} vai mostrar produtos.`);
      cleanText = '';
    } else {
      // Descarta listas com preços em qualquer formato (R$ / R\$ / reais / número decimal)
      const hasNumberedItems = (cleanText.match(/^\s*\d+[\.\)]\s+\S/mg) || []).length >= 2;
      const hasPrices = /R\s*\\?\$\s*\d|reais|\d+[,\.]\d{2}/i.test(cleanText);
      if (hasNumberedItems && hasPrices) {
        console.log(`[Guard] Lista inventada descartada.`);
        cleanText = '';
      }
    }

    if (cleanText) session.history.push({ role: 'assistant', content: cleanText });
    if (session.history.length > 20) session.history = session.history.slice(-20);

    if (cleanText) {
      await zapi.replyText(from, cleanText, messageId);
      if (TTS_ENABLED) {
        try {
          const { buffer, mimeType } = await tts.textToSpeech(cleanText);
          await zapi.sendAudio(from, buffer, mimeType);
        } catch (ttsErr) {
          console.error('[TTS Error]', ttsErr.message);
        }
      }
    }

    if (action) {
      await executeAction(from, action, session);
    }

    persistSession(from);

  } catch (error) {
    console.error('[Webhook Error]', error.message);
    const isRateLimit = error.status === 429 || error.message?.includes('429');
    if (isRateLimit && from) {
      await zapi.sendText(from, 'Estou sobrecarregada no momento 😅 Tenta de novo em alguns minutinhos!').catch(() => {});
    }
  }
});

// ── Action Executor ───────────────────────────────────────────────────────

async function executeAction(phone, action, session) {
  switch (action.type) {
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
      session.currentProduct = product;
      await showSizes(phone, product);
      break;
    }

    case 'TAMANHO': {
      const product = session.currentProduct;
      if (!product) {
        await zapi.sendText(phone, '❌ Nenhum produto selecionado. Escolha um produto primeiro.');
        return;
      }
      const sizeIdx = parseInt(action.payload, 10) - 1;
      if (isNaN(sizeIdx) || !product.sizes[sizeIdx]) {
        await zapi.sendText(phone, `❌ Tamanho inválido. Escolha entre 1 e ${product.sizes.length}.`);
        await showSizes(phone, product);
        return;
      }
      const size = product.sizes[sizeIdx];
      session.items.push({
        productId: product.id,
        productName: product.name,
        size,
        price: product.salePrice || product.price,
      });
      session.currentProduct = null;
      
      const itemCount = session.items.length;
      const cartTotal = session.items.reduce((acc, it) => acc + parseFloat(it.price), 0);
      const nudge = `[SISTEMA: O item "${product.name}" tamanho ${size} foi adicionado ao carrinho. Carrinho: ${itemCount} itens, total ${woocommerce.formatPrice(cartTotal)}. Confirme de forma natural e pergunte se quer mais algo ou finalizar.]`;
      session.history.push({ role: 'system', content: nudge });

      try {
        const aiRaw = await ai.chat(session.history, null);
        const { cleanText } = ai.parseAction(aiRaw);
        const reply = cleanText || `✅ *${product.name}* (${size}) adicionado! Quer mais algo?`;
        session.history.push({ role: 'assistant', content: reply });
        await zapi.sendText(phone, reply);
      } catch (err) {
        await zapi.sendText(phone, `✅ *${product.name}* (${size}) adicionado!`);
      }
      break;
    }

    case 'CARRINHO':
      await showCart(phone, session);
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

    case 'HANDOFF':
      await handoffToConsultant(phone, session);
      break;
  }
}

// ── Flow Functions ────────────────────────────────────────────────────────

async function showCategory(phone, slug, session) {
  slug = normalizeCategorySlug(slug);
  await zapi.sendText(phone, `🔍 Buscando produtos *${slug.toUpperCase()}*...`);

  try {
    const result = await woocommerce.getProductsByCategory(slug, 10, 1);

    if (result.products.length === 0) {
      await zapi.sendText(phone, `😕 Nenhum produto encontrado em *${slug}*.`);
      return;
    }

    session.products = result.products;
    session.currentCategory = slug;
    session.currentPage = result.page;
    session.totalPages = result.totalPages;
    session.totalProducts = result.total;

    await sendProductPage(phone, result, session);
  } catch (err) {
    console.error(`[showCategory] slug=${slug} code=${err.code} status=${err.response?.status} msg=${err.message}`);
    await zapi.sendText(phone, '⚠️ Erro ao buscar produtos.');
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
    console.error('[showNextPage]', err.message);
    await zapi.sendText(phone, '⚠️ Erro ao carregar mais produtos.');
  }
}

async function sendProductPage(phone, result, session, startIdx = 0) {
  let msg = `📦 *${session.currentCategory.toUpperCase()}* — Produtos ${startIdx + 1}–${session.products.length} de ${result.total}:\n\n`;
  
  result.products.forEach((p, i) => {
    const price = woocommerce.formatPrice(p.salePrice || p.price);
    msg += `${startIdx + i + 1}. *${p.name}* — ${price}\n`;
  });

  if (result.hasMore) {
    msg += `\n_Diga "ver mais" para ver os próximos produtos._`;
  }

  await zapi.sendText(phone, msg);

  for (const [i, product] of result.products.entries()) {
    if (product.imageUrl) {
      const globalIdx = startIdx + i + 1;
      await zapi.sendImage(phone, product.imageUrl, woocommerce.buildCaption(product, globalIdx));
      await zapi.delay(400);
    }
  }

  // Atualiza lastViewedProduct após enviar a última imagem do lote
  if (result.products.length > 0) {
    session.lastViewedProduct = result.products[result.products.length - 1];
    session.lastViewedProductIndex = startIdx + result.products.length;
  }

  // Nudge natural da IA após as fotos
  const remaining = result.total - session.products.length;
  const nudge = remaining > 0
    ? `[SISTEMA: Fotos enviadas. Há mais ${remaining} produtos. Pergunte se algum chamou atenção ou se quer ver mais.]`
    : `[SISTEMA: Fotos enviadas. Todos os produtos mostrados. Pergunte se algum chamou atenção.]`;
  
  session.history.push({ role: 'system', content: nudge });
  const aiRaw = await ai.chat(session.history, null);
  const { cleanText } = ai.parseAction(aiRaw);
  if (cleanText) {
    session.history.push({ role: 'assistant', content: cleanText });
    await zapi.sendText(phone, cleanText);
  }
}

async function showProductPhotos(phone, index, session) {
  const product = session.products[index - 1];
  if (!product) {
    await zapi.sendText(phone, `❌ Produto #${index} não encontrado.`);
    return;
  }

  const images = product.images || (product.imageUrl ? [product.imageUrl] : []);

  if (images.length <= 1) {
    const onlyOne = [
      `Essa peça só tem uma foto no momento 😊 Quer ver os tamanhos disponíveis?`,
      `Só temos uma imagem dessa por enquanto — quer conferir os tamanhos?`,
      `Foto única por aqui! Se quiser, já posso mostrar os tamanhos 😊`,
    ];
    const reply = onlyOne[Math.floor(Math.random() * onlyOne.length)];
    session.history.push({ role: 'assistant', content: reply });
    await zapi.sendText(phone, reply);
    return;
  }

  for (const url of images) {
    await zapi.sendImage(phone, url, woocommerce.buildCaption(product, index));
    await zapi.delay(500);
  }

  // Atualiza lastViewedProduct após enviar fotos específicas
  session.lastViewedProduct = product;
  session.lastViewedProductIndex = index;

  // Follow-up fixo humanizado — sem chamar a IA para evitar respostas robóticas
  const followUps = [
    `Bonita né? Quer ver os tamanhos disponíveis ou já adiciona ao pedido? 😊`,
    `Essa vende bem! Me diz se quer fechar ou ver os tamanhos 😊`,
    `Gostou? Posso mostrar os tamanhos agora pra a gente montar o pedido 😊`,
    `Essa peça é ótima — quer os tamanhos ou prefere continuar vendo mais produtos?`,
  ];
  const reply = followUps[Math.floor(Math.random() * followUps.length)];
  session.history.push({ role: 'assistant', content: reply });
  await zapi.sendText(phone, reply);
}

async function searchAndShowProducts(phone, query, session) {
  await zapi.sendText(phone, `🔍 Buscando *"${query}"*...`);
  try {
    const products = await woocommerce.searchProducts(query);
    if (products.length === 0) {
      await zapi.sendText(phone, `😕 Não encontrei produtos para *"${query}"*.`);
      return;
    }
    session.products = products;
    session.currentPage = 1;
    session.totalPages = 1;

    let msg = `🔍 *Resultados para "${query}":*\n\n`;
    products.forEach((p, i) => {
      msg += `${i + 1}. *${p.name}* — ${woocommerce.formatPrice(p.salePrice || p.price)}\n`;
    });
    await zapi.sendText(phone, msg);

    for (const [i, p] of products.entries()) {
      if (p.imageUrl) {
        await zapi.sendImage(phone, p.imageUrl, woocommerce.buildCaption(p, i + 1));
        await zapi.delay(400);
      }
    }
  } catch (err) {
    console.error('[searchProducts]', err.message);
  }
}

async function showSizes(phone, product) {
  if (!product.sizes?.length) {
    await zapi.sendText(phone, `⚠️ *${product.name}* sem tamanhos disponíveis.`);
    return;
  }
  let msg = `📏 *${product.name}*\n\n`;
  product.sizes.forEach((s, i) => { msg += `${i + 1}. ${s}\n`; });
  await zapi.sendText(phone, msg);
}

async function showCart(phone, session) {
  if (session.items.length === 0) {
    await zapi.sendText(phone, '🛒 Carrinho vazio.');
    return;
  }
  let summary = '🛒 *SEU CARRINHO*\n─────────────────\n';
  let total = 0;
  session.items.forEach((item, idx) => {
    const price = parseFloat(item.price);
    total += price;
    summary += `${idx + 1}. *${item.productName}* (${item.size}) — ${woocommerce.formatPrice(price)}\n`;
  });
  summary += `─────────────────\n💰 *Total: ${woocommerce.formatPrice(total)}*`;
  await zapi.sendText(phone, summary);
}

async function handoffToConsultant(phone, session) {
  if (session.items.length === 0) return;
  const customerName = session.customerName || 'Lojista';
  let total = 0;
  let orderBlock = `📋 *PEDIDO PARA ATENDIMENTO*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  orderBlock += `👤 ${customerName}\n📱 ${phone}\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  session.items.forEach((item, idx) => {
    total += parseFloat(item.price);
    orderBlock += `${idx + 1}. ${item.productName} (${item.size})\n`;
  });
  orderBlock += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n💰 *TOTAL: ${woocommerce.formatPrice(total)}*`;
  
  if (ADMIN_PHONE) await zapi.sendText(ADMIN_PHONE, `🆕 *HANDOFF*\n${orderBlock}`);
  console.log(`[HANDOFF] ${orderBlock}`);

  db.saveOrder({ phone, customerName, items: session.items, total })
    .catch(err => console.error('[Supabase] saveOrder:', err.message));

  // Extrai aprendizado em background — não bloqueia o handoff
  extractLearning(session).catch(err => console.error('[Learning]', err.message));
}

// ── Continuous Learning ───────────────────────────────────────────────────

async function extractLearning(session) {
  const turns = session.history.filter(m => m.role === 'user' || m.role === 'assistant');
  if (turns.length < 4) return;

  const convo = turns
    .map(m => `${m.role === 'user' ? 'Lojista' : 'Bela'}: ${m.content}`)
    .join('\n');

  const prompt = [{
    role: 'user',
    content: `Você é um analista de vendas B2B de moda íntima atacado.

Analise esta conversa entre a Bela (vendedora) e um lojista que chegou até o pedido:

${convo}

Extraia APENAS 1 insight específico e acionável sobre o comportamento desse lojista ou sobre o que funcionou na abordagem da Bela.

Regras:
- Máximo 20 palavras
- Comece com "Lojistas que..." ou "Quando o lojista..." ou "A abordagem de..."
- Deve ajudar a Bela a vender melhor em conversas futuras
- Se não houver nada útil, responda apenas: NENHUM`,
  }];

  const raw = await ai.chat(prompt, null);
  const insight = raw?.trim();
  if (!insight || insight.toUpperCase().includes('NENHUM')) return;

  await learnings.addLearning(insight);
  console.log(`[Learning] Novo insight: "${insight}"`);
}

function extractTextFromEvent(body) {
  if (body?.text?.message) return body.text.message.trim();
  if (body?.audio) return '[Áudio]';
  if (body?.image?.caption) return body.image.caption.trim();
  if (body?.sticker) return '[Sticker]';
  return null;
}

app.get('/', (_req, res) => res.json({ status: 'online', activeSessions: Object.keys(sessions).length }));

app.listen(PORT, () => {
  console.log(`🚀 Agente Belux running on port ${PORT}`);
});
