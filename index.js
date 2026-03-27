require('dotenv').config();

const express = require('express');
const woocommerce = require('./services/woocommerce');
const zapi = require('./services/zapi');
// const groq = require('./services/groq');       // Standby — Groq (llama-3.3-70b)
// const groq = require('./services/gemini');     // Standby — Gemini (2.0-flash-lite)
const groq = require('./services/openrouter');    // Ativo — Llama 4 Maverick via OpenRouter
const tts = require('./services/tts');

const TTS_ENABLED = process.env.TTS_ENABLED === 'true';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_PHONE = process.env.ADMIN_PHONE || null;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes inactivity
const PRODUCTS_PER_PAGE = 10;

// ── Sessions ──────────────────────────────────────────────────────────────
// { phone: { history, items, products, currentProduct, customerName, lastActivity } }
const sessions = {};

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = {
      history: [],
      items: [],
      products: [],
      productOffset: 0,
      currentProduct: null,
      customerName: null,
      lastActivity: Date.now(),
    };
  } else {
    sessions[phone].lastActivity = Date.now();
  }
  return sessions[phone];
}

// Clean up sessions that have been inactive for SESSION_TIMEOUT_MS
setInterval(() => {
  const now = Date.now();
  for (const phone of Object.keys(sessions)) {
    if (now - sessions[phone].lastActivity > SESSION_TIMEOUT_MS) {
      delete sessions[phone];
      console.log(`[Session] Expired: ${phone}`);
    }
  }
}, 10 * 60 * 1000); // runs every 10 minutes

// ── Webhook ───────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  let from = '';
  try {
    const body = req.body;

    from = body?.phone || '';
    if (!from) return;
    if (body?.fromMe) return;
    if (body?.isGroup) return;
    if (body?.isStatusReply) return;
    if (body?.broadcast) return;
    if (body?.type === 'DeliveryCallback' || body?.type === 'ReadCallback') return;

    const messageId = body?.messageId || null;

    const text = extractTextFromEvent(body);
    if (!text) return;

    // Ignora mensagens de sistema do Z-API trial ("MENSAGEM DE TESTE / CONTA EM TRIAL")
    if (text.includes('CONTA EM TRIAL') || text.includes('MENSAGEM DE TESTE')) return;

    console.log(`[MSG] ${from}: "${text}"`);

    // Mark as read — shows blue ticks before typing starts
    if (messageId) zapi.readMessage(from, messageId);

    const session = getSession(from);

    // Inject quoted message context so the AI knows what the client is replying to.
    // For image replies, Z-API puts the original image caption in quotedMessage.image.caption.
    if (body?.quotedMessage) {
      const quotedText =
        body.quotedMessage.text?.message ||
        body.quotedMessage.image?.caption ||
        null;
      if (quotedText) {
        session.history.push({
          role: 'system',
          content: `[O cliente está respondendo à seguinte mensagem: "${quotedText}"]`,
        });
      }
    }

    session.history.push({ role: 'user', content: text });

    const catalogContext = buildCatalogContext(session);
    const aiRaw = await groq.chat(session.history, catalogContext);
    console.log(`[AI] ${from}: "${aiRaw}"`);

    let { cleanText, action } = groq.parseAction(aiRaw);

    // Guard: bloqueia VER/BUSCAR apenas quando a IA está perguntando QUAL categoria ver.
    // Permite tokens quando a pergunta é sobre os produtos já mostrados (ex: "Qual você gostaria?").
    const askingForCategory = action &&
      (action.type === 'VER' || action.type === 'BUSCAR') &&
      cleanText.includes('?') &&
      /qual.*categoria|que tipo|qual.*linha|por onde|qual.*prefer|começa por|começar por/i.test(cleanText);
    if (askingForCategory) {
      console.log(`[Guard] Token [${action.type}] descartado — IA perguntou sobre categoria junto com ação.`);
      action = null;
    }

    session.history.push({ role: 'assistant', content: cleanText });

    // Cap history at last 20 messages
    if (session.history.length > 20) {
      session.history = session.history.slice(-20);
    }

    if (cleanText) {
      await zapi.sendText(from, cleanText);

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

  } catch (error) {
    console.error('[Webhook Error]', error.message);
    if (error.response) {
      console.error('[Response]', JSON.stringify(error.response.data));
    }
    // Rate limit do Groq — avisa o cliente em vez de sumir
    const isRateLimit = error.status === 429 || error.response?.status === 429 ||
      error.message?.includes('429') || error.message?.includes('rate_limit');
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

    case 'VER_MAIS':
      if (!session.products || session.products.length === 0) {
        await zapi.sendText(phone, '❌ Não há produtos para mostrar. Escolha uma categoria primeiro.');
        return;
      }
      if (session.productOffset >= session.products.length) {
        // Let the AI respond naturally when all products have been shown
        const nudgeFim = `[SISTEMA: O lojista pediu ver mais produtos, mas já viu todos os ${session.products.length} disponíveis na categoria. Informe isso de forma natural e sugira escolher algum ou explorar outra categoria. Máximo 2 frases.]`;
        session.history.push({ role: 'system', content: nudgeFim });
        const catalogContext = buildCatalogContext(session);
        const aiRaw = await groq.chat(session.history, catalogContext);
        const { cleanText } = groq.parseAction(aiRaw);
        if (cleanText) {
          session.history.push({ role: 'assistant', content: cleanText });
          await zapi.sendText(phone, cleanText);
        }
        return;
      }
      await sendProductPage(phone, session);
      break;

    case 'SELECIONAR': {
      const idx = parseInt(action.payload, 10) - 1;
      const product = session.products[idx];
      if (!product) {
        await zapi.sendText(phone, '❌ Produto não encontrado. Verifique o número e tente novamente.');
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

      // Let the AI confirm naturally — no robot message
      const nudge = `[SISTEMA: O item "${product.name}" tamanho ${size} foi adicionado ao carrinho. Carrinho: ${itemCount} ${itemCount === 1 ? 'item' : 'itens'}, total ${woocommerce.formatPrice(cartTotal)}. Confirme de forma natural (sem emojis excessivos) e pergunte se quer adicionar mais ou finalizar. Máximo 2 frases. NÃO emita nenhum token de ação.]`;
      session.history.push({ role: 'system', content: nudge });

      try {
        const aiRaw = await groq.chat(session.history, null);
        const { cleanText } = groq.parseAction(aiRaw);
        const reply = cleanText || `*${product.name}* (${size}) no carrinho! Quer continuar escolhendo ou vê o resumo do pedido?`;
        session.history.push({ role: 'assistant', content: reply });
        await zapi.sendText(phone, reply);
      } catch (err) {
        console.error('[TAMANHO AI Error]', err.message);
        await zapi.sendText(phone, `*${product.name}* (${size}) adicionado! Quer continuar ou finalizar o pedido?`);
      }
      break;
    }

    case 'NOME':
      session.customerName = action.payload.trim();
      console.log(`[Session] Nome registrado: "${session.customerName}" (${phone})`);
      break;

    case 'CARRINHO':
      await showCart(phone, session);
      break;

    case 'REMOVER': {
      const itemIdx = parseInt(action.payload, 10) - 1;
      if (isNaN(itemIdx) || !session.items[itemIdx]) {
        await zapi.sendText(phone, '❌ Item não encontrado. Veja seu carrinho para confirmar os números.');
        await showCart(phone, session);
        return;
      }
      const removed = session.items.splice(itemIdx, 1)[0];
      const remaining = session.items.length;
      await zapi.sendText(
        phone,
        `🗑️ *${removed.productName}* (Tam: ${removed.size}) removido.\n🛒 ${remaining} ${remaining === 1 ? 'item' : 'itens'} restante${remaining !== 1 ? 's' : ''}.`
      );
      if (remaining > 0) await showCart(phone, session);
      break;
    }

    case 'HANDOFF':
      await handoffToConsultant(phone, session);
      break;

    case 'FINALIZAR': // fallback legado — fluxo principal usa [HANDOFF]
      await handoffToConsultant(phone, session);
      break;
  }
}

// ── Flow Functions ────────────────────────────────────────────────────────

async function showCategory(phone, slug, session) {
  const label = slug.charAt(0).toUpperCase() + slug.slice(1);
  await zapi.sendText(phone, `🔍 Buscando produtos *${label}*...`);

  try {
    const products = await woocommerce.getAllProductsByCategory(slug);

    if (products.length === 0) {
      await zapi.sendText(phone, `😕 Nenhum produto encontrado em *${label}* no momento. Que tal explorar outra categoria?`);
      return;
    }

    session.products = products;
    session.productOffset = 0;

    await sendProductPage(phone, session, label);
  } catch (err) {
    console.error('[WooCommerce showCategory]', err.message);
    await zapi.sendText(phone, '⚠️ Erro ao buscar produtos. Tente novamente em instantes.');
  }
}

async function searchAndShowProducts(phone, query, session) {
  await zapi.sendText(phone, `🔍 Buscando *"${query}"*...`);

  try {
    const products = await woocommerce.searchProducts(query);

    if (products.length === 0) {
      await zapi.sendText(phone, `😕 Não encontrei produtos para *"${query}"*.\n\nTente buscar de outra forma ou escolha uma categoria: *Feminino*, *Masculino* ou *Infantil*.`);
      return;
    }

    session.products = products;
    session.productOffset = 0;

    await sendProductPage(phone, session);
  } catch (err) {
    console.error('[WooCommerce searchProducts]', err.message);
    await zapi.sendText(phone, '⚠️ Erro ao buscar produtos. Tente novamente.');
  }
}

async function sendProductPage(phone, session, label = '') {
  const { products, productOffset } = session;
  const total = products.length;
  const end = Math.min(productOffset + PRODUCTS_PER_PAGE, total);
  const page = products.slice(productOffset, end);
  const remaining = total - end;

  const isFirstPage = productOffset === 0;
  const header = isFirstPage
    ? `🏆 *${label || 'Produtos'} — Top ${end} mais vendidos (${total} no estoque):*\n\n`
    : `📦 *Produtos ${productOffset + 1}–${end} de ${total}:*\n\n`;

  let list = header;
  page.forEach((p, i) => {
    const globalIdx = productOffset + i + 1;
    const price = woocommerce.formatPrice(p.salePrice || p.price);
    list += `${globalIdx}. *${p.name}* — ${price}\n`;
  });
  // No instruction text — AI asks naturally via askAfterProducts

  await zapi.sendText(phone, list);

  for (const product of page) {
    if (product.imageUrl) {
      await zapi.delay(500);
      await zapi.sendImage(phone, product.imageUrl, woocommerce.buildCaption(product));
    }
  }

  session.productOffset = end;
  session.remainingProducts = remaining;

  // After showing products, let the AI engage naturally
  await askAfterProducts(phone, session);
}

async function askAfterProducts(phone, session) {
  const nudge = session.remainingProducts > 0
    ? `[SISTEMA: As fotos acabaram de ser enviadas. Responda com APENAS 1 frase de texto puro — sem tokens, sem lista, sem preços. Pergunte naturalmente se algum chamou atenção ou se quer ver os próximos ${session.remainingProducts}. NÃO emita nenhum token de ação.]`
    : `[SISTEMA: As fotos acabaram de ser enviadas e todos os produtos foram mostrados. Responda com APENAS 1 frase de texto puro — sem tokens, sem lista, sem preços. Pergunte naturalmente se algum chamou atenção ou se quer buscar algo específico. NÃO emita nenhum token de ação.]`;

  session.history.push({ role: 'system', content: nudge });

  try {
    // Pass null context — no product list, so the model can't enumerate them.
    // The nudge in history is enough to guide the follow-up question.
    const aiRaw = await groq.chat(session.history, null);
    console.log(`[askAfterProducts] raw="${aiRaw}"`);
    const { cleanText } = groq.parseAction(aiRaw);
    console.log(`[askAfterProducts] cleanText="${cleanText}"`);

    const reply = cleanText || (session.remainingProducts > 0
      ? `Algum produto chamou sua atenção? Ainda tenho mais ${session.remainingProducts} pra mostrar 😊`
      : 'Algum produto chamou sua atenção? Me fala qual que eu te conto mais detalhes 😊');

    session.history.push({ role: 'assistant', content: reply });
    await zapi.sendText(phone, reply);
  } catch (err) {
    console.error('[askAfterProducts Error]', err.message);
  }
}

async function showSizes(phone, product) {
  if (!product.sizes || product.sizes.length === 0) {
    await zapi.sendText(phone, `⚠️ *"${product.name}"* não possui tamanhos disponíveis no momento.`);
    return;
  }

  let msg = `📏 *${product.name}*\n\n`;
  product.sizes.forEach((s, i) => { msg += `${i + 1}. ${s}\n`; });

  await zapi.sendText(phone, msg);
}

async function showCart(phone, session) {
  if (session.items.length === 0) {
    await zapi.sendText(phone, '🛒 Carrinho vazio ainda.');
    return;
  }

  let summary = '🛒 *SEU CARRINHO*\n─────────────────\n';
  let total = 0;

  session.items.forEach((item, idx) => {
    const price = parseFloat(item.price);
    total += price;
    summary += `${idx + 1}. *${item.productName}*\n   📏 Tam: ${item.size} | 💰 ${woocommerce.formatPrice(price)}\n`;
  });

  summary += `─────────────────\n💰 *Total: ${woocommerce.formatPrice(total)}*`;

  await zapi.sendText(phone, summary);
}

async function handoffToConsultant(phone, session) {
  if (session.items.length === 0) {
    await zapi.sendText(phone, 'Ainda não temos nada no pedido! Me conta o que você procura e a gente monta junto 😊');
    return;
  }

  const customerName = session.customerName || 'Lojista';
  const orderDate = new Date().toLocaleString('pt-BR');
  let total = 0;

  let orderBlock = `📋 *PEDIDO PARA ATENDIMENTO*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  orderBlock += `👤 ${customerName}\n📱 ${phone}\n📅 ${orderDate}\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  session.items.forEach((item, idx) => {
    const price = parseFloat(item.price);
    total += price;
    orderBlock += `${idx + 1}. ${item.productName}\n   📏 ${item.size} | 💰 ${woocommerce.formatPrice(price)}\n`;
  });

  orderBlock += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n💰 *TOTAL: ${woocommerce.formatPrice(total)}*\n📦 ${session.items.length} ${session.items.length === 1 ? 'item' : 'itens'}`;

  // Notify consultant (admin) with full order
  if (ADMIN_PHONE) {
    try {
      await zapi.sendText(ADMIN_PHONE, `🆕 *HANDOFF — Pedido pronto para fechar*\n${orderBlock}\n\n_Sessão preservada — entre em contato com o lojista para finalizar._`);
    } catch (err) {
      console.error('[Admin Handoff Error]', err.message);
    }
  }

  console.log(`\n[HANDOFF] ${orderBlock}\n`);
  // Session preserved intentionally — consultant may need to consult it
}

// ── Helpers ───────────────────────────────────────────────────────────────

function extractTextFromEvent(body) {
  if (body?.text?.message) return body.text.message.trim();
  if (body?.audio)   return '[O cliente enviou um áudio]';
  if (body?.image) {
    // When the user replies to a bot photo, Z-API sends it as an image event
    // with the user's reply text in `caption`. Treat that as normal text input.
    if (body.image.caption) return body.image.caption.trim();
    return '[O cliente enviou uma imagem]';
  }
  if (body?.sticker) return '[O cliente enviou um sticker]';
  return null; // reactions e outros eventos silenciosos
}

function buildCatalogContext(session) {
  const lines = [];

  // Session state — helps the AI know exactly where the conversation is
  const stateLines = ['ESTADO DA SESSÃO:'];
  if (session.products?.length > 0) {
    stateLines.push(`- Categoria carregada: ${session.products.length} produto(s)`);
  } else {
    stateLines.push('- Nenhum produto carregado ainda');
  }
  stateLines.push(`- Carrinho: ${session.items.length === 0 ? 'vazio' : `${session.items.length} item(ns)`}`);
  if (session.currentProduct) {
    stateLines.push(`- Aguardando escolha de tamanho para: ${session.currentProduct.name}`);
  }
  if (session.customerName) {
    stateLines.push(`- Nome do cliente: ${session.customerName}`);
  }
  lines.push(stateLines.join('\n'));

  // Only include products that have actually been shown to the user (up to productOffset),
  // capped at last 30 to avoid bloating the context with 200-product lists.
  if (session.products?.length > 0 && session.productOffset > 0) {
    const shownCount = session.productOffset;
    const startIdx = Math.max(0, shownCount - 30);
    const visibleProducts = session.products.slice(startIdx, shownCount);

    let catalog = `\nProdutos mostrados ao cliente (itens ${startIdx + 1}–${shownCount} de ${session.products.length}):\n`;
    visibleProducts.forEach((p, i) => {
      const num = startIdx + i + 1;
      const price = p.salePrice || p.price;
      catalog += `${num}. ${p.name} — R$ ${price}`;
      if (p.sizes.length > 0) catalog += ` — Tamanhos: ${p.sizes.join(', ')}`;
      catalog += '\n';
    });
    lines.push(catalog);
  }

  if (session.remainingProducts > 0) {
    lines.push(`[SISTEMA] Ainda há ${session.remainingProducts} produto(s) desta categoria que o cliente ainda não viu. Convide-o de forma calorosa a ver mais, se fizer sentido na conversa.`);
  }

  if (session.items.length > 0) {
    let cart = `\nCarrinho atual (${session.items.length} ${session.items.length === 1 ? 'item' : 'itens'}):\n`;
    session.items.forEach((item, i) => {
      cart += `${i + 1}. ${item.productName} (Tam: ${item.size}) — R$ ${item.price}\n`;
    });
    lines.push(cart);
  }

  return lines.join('\n') || null;
}

// ── Health Check ──────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    status: 'online',
    service: 'Vendedor Digital - Belux Moda Íntima',
    activeSessions: Object.keys(sessions).length,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   🤖 Vendedor Digital - Belux       ║
  ║   IA: Llama 4 Maverick (OpenRouter)  ║
  ║   Server running on port ${PORT}       ║
  ╚══════════════════════════════════════╝
  `);
});
