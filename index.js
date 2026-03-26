require('dotenv').config();

const express = require('express');
const woocommerce = require('./services/woocommerce');
const zapi = require('./services/zapi');
const groq = require('./services/groq');

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

  try {
    const body = req.body;

    const from = body?.phone || '';
    if (!from) return;
    if (body?.fromMe) return;
    if (body?.isGroup) return;
    if (body?.isStatusReply) return;
    if (body?.broadcast) return;
    if (body?.type === 'DeliveryCallback' || body?.type === 'ReadCallback') return;

    const messageId = body?.messageId || null;

    const text = extractTextFromEvent(body);
    if (!text) return;

    console.log(`[MSG] ${from}: "${text}"`);

    // Mark as read — shows blue ticks before typing starts
    if (messageId) zapi.readMessage(from, messageId);

    const session = getSession(from);

    // Inject quoted message context so the AI knows what the client is replying to
    if (body?.quotedMessage) {
      const quotedText = body.quotedMessage.text?.message || '[mensagem anterior]';
      session.history.push({
        role: 'system',
        content: `[O cliente está respondendo à seguinte mensagem: "${quotedText}"]`,
      });
    }

    session.history.push({ role: 'user', content: text });

    const catalogContext = buildCatalogContext(session);
    const aiRaw = await groq.chat(session.history, catalogContext);
    console.log(`[AI] ${from}: "${aiRaw}"`);

    const { cleanText, action } = groq.parseAction(aiRaw);

    session.history.push({ role: 'assistant', content: cleanText });

    // Cap history at last 20 messages
    if (session.history.length > 20) {
      session.history = session.history.slice(-20);
    }

    if (cleanText) {
      await zapi.sendText(from, cleanText);
    }

    if (action) {
      await executeAction(from, action, session);
    }

  } catch (error) {
    console.error('[Webhook Error]', error.message);
    if (error.response) {
      console.error('[Response]', JSON.stringify(error.response.data));
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
        await zapi.sendText(phone, '✅ Você já viu todos os produtos disponíveis! Quer escolher algum ou buscar outra coisa?');
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
      const count = session.items.length;
      await zapi.sendText(
        phone,
        `✅ *${product.name}* (Tam: ${size}) adicionado ao carrinho!\n🛒 ${count} ${count === 1 ? 'item' : 'itens'} no carrinho.\n\nContinue escolhendo ou diga *"finalizar"* para fechar o pedido.`
      );
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

    case 'FINALIZAR':
      await finalizeOrder(phone, session);
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
  list += '\n_Digite o número do produto para ver os tamanhos._';

  await zapi.sendText(phone, list);

  for (const product of page) {
    if (product.imageUrl) {
      await zapi.delay(500);
      await zapi.sendImage(phone, product.imageUrl, woocommerce.buildCaption(product));
    }
  }

  session.productOffset = end;
  session.remainingProducts = remaining;
}

async function showSizes(phone, product) {
  if (!product.sizes || product.sizes.length === 0) {
    await zapi.sendText(phone, `⚠️ *"${product.name}"* não possui tamanhos disponíveis no momento.`);
    return;
  }

  let msg = `📏 *${product.name}*\nEscolha o tamanho:\n\n`;
  product.sizes.forEach((s, i) => { msg += `${i + 1}. ${s}\n`; });
  msg += '\n_Digite o número do tamanho desejado._';

  await zapi.sendText(phone, msg);
}

async function showCart(phone, session) {
  if (session.items.length === 0) {
    await zapi.sendText(phone, '🛒 Seu carrinho está vazio!\n\nEscolha uma categoria para começar:\n👗 *Feminino* | 👔 *Masculino* | 👶 *Infantil*');
    return;
  }

  let summary = '🛒 *SEU CARRINHO*\n─────────────────\n';
  let total = 0;

  session.items.forEach((item, idx) => {
    const price = parseFloat(item.price);
    total += price;
    summary += `${idx + 1}. *${item.productName}*\n   📏 Tam: ${item.size} | 💰 ${woocommerce.formatPrice(price)}\n`;
  });

  summary += `─────────────────\n💰 *Total: ${woocommerce.formatPrice(total)}*\n\n`;
  summary += `➕ Continue escolhendo\n🗑️ Para remover: diga _"remover item N"_\n✅ Para fechar: diga _"finalizar"_`;

  await zapi.sendText(phone, summary);
}

async function finalizeOrder(phone, session) {
  if (session.items.length === 0) {
    await zapi.sendText(phone, '🛒 Seu carrinho está vazio! Adicione produtos antes de finalizar.');
    return;
  }

  const customerName = session.customerName || 'Cliente';
  const orderDate = new Date().toLocaleString('pt-BR');
  let total = 0;

  let orderBlock = `📋 *RESUMO DO PEDIDO*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  orderBlock += `👤 ${customerName}\n📱 ${phone}\n📅 ${orderDate}\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  session.items.forEach((item, idx) => {
    const price = parseFloat(item.price);
    total += price;
    orderBlock += `${idx + 1}. ${item.productName}\n   📏 ${item.size} | 💰 ${woocommerce.formatPrice(price)}\n`;
  });

  orderBlock += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n💰 *TOTAL: ${woocommerce.formatPrice(total)}*\n📦 ${session.items.length} ${session.items.length === 1 ? 'item' : 'itens'}`;

  // Confirm to customer
  await zapi.sendText(
    phone,
    `✅ *Pedido recebido com sucesso!*\n\n${orderBlock}\n\n💜 Uma consultora Belux entrará em contato em breve para combinar entrega e pagamento.\n\n_Obrigada por escolher *Belux Moda Íntima*!_ 👗`
  );

  // Notify admin if ADMIN_PHONE is configured
  if (ADMIN_PHONE) {
    try {
      await zapi.sendText(ADMIN_PHONE, `🆕 *NOVO PEDIDO via WhatsApp*\n${orderBlock}`);
    } catch (err) {
      console.error('[Admin Notification Error]', err.message);
    }
  }

  console.log(`\n[ORDER] ${orderBlock}\n`);
  delete sessions[phone];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function extractTextFromEvent(body) {
  if (body?.text?.message) return body.text.message.trim();
  if (body?.audio)   return '[O cliente enviou um áudio]';
  if (body?.image)   return `[O cliente enviou uma imagem${body.image.caption ? `: "${body.image.caption}"` : ''}]`;
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

  if (session.products?.length > 0) {
    let catalog = `\nProdutos disponíveis (${session.products.length}):\n`;
    session.products.forEach((p, i) => {
      const price = p.salePrice || p.price;
      catalog += `${i + 1}. ${p.name} — R$ ${price}`;
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
  ║   IA: Groq (llama-3.3-70b)          ║
  ║   Server running on port ${PORT}       ║
  ╚══════════════════════════════════════╝
  `);
});
