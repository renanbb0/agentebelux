const axios = require('axios');
const logger = require('./logger');

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

/** Desconto PIX em decimal (ex: 0.10 = 10%). Configurável via PIX_DISCOUNT_PCT no .env. */
const PIX_DISCOUNT = parseFloat(process.env.PIX_DISCOUNT_PCT || '10') / 100;
const ZAPI_BASE_URL = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

const zapiClient = axios.create({
  baseURL: ZAPI_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
});

if (ZAPI_CLIENT_TOKEN && ZAPI_CLIENT_TOKEN !== 'seu_client_token') {
  zapiClient.defaults.headers.common['Client-Token'] = ZAPI_CLIENT_TOKEN;
}

async function readMessage(phone, messageId) {
  try {
    await zapiClient.post('/read-message', { phone, messageId });
  } catch (err) {
    logger.error({ err: err.message }, '[Z-API] readMessage failed');
  }
}

async function sendText(to, message) {
  const typingSeconds = Math.min(Math.max(Math.ceil(message.length / 80), 1), 5);
  const res = await zapiClient.post('/send-text', {
    phone: to,
    message,
    delayTyping: typingSeconds,
  });
  logger.info({ to, typingSeconds, zaapId: res.data?.zaapId }, '[Z-API] sendText');
  return res;
}

async function replyText(to, message, replyToMessageId) {
  if (!replyToMessageId) {
    logger.warn({ to, messagePreview: message.slice(0, 50) }, '[Z-API] replyText chamado SEM replyToMessageId — fallback para sendText (sem citação)');
    return sendText(to, message);
  }
  const typingSeconds = Math.min(Math.max(Math.ceil(message.length / 80), 1), 5);
  try {
    const res = await zapiClient.post('/send-text', {
      phone: to,
      message,
      messageId: replyToMessageId,
      delayTyping: typingSeconds,
    });
    logger.info({ to, typingSeconds, replyTo: replyToMessageId, zaapId: res.data?.zaapId }, '[Z-API] replyText OK');
    return res;
  } catch (err) {
    logger.error({ to, replyTo: replyToMessageId, err: err.message, status: err.response?.status, data: err.response?.data }, '[Z-API] replyText FALHOU — tentando sendText sem citação');
    return sendText(to, message);
  }
}

async function sendImage(to, imageUrl, caption) {
  const res = await zapiClient.post('/send-image', {
    phone: to,
    image: imageUrl,
    caption,
  });
  logger.info({ to, zaapId: res.data?.zaapId }, '[Z-API] sendImage');
  return res;
}

async function sendAudio(to, audioBuffer, mimeType = 'audio/mpeg') {
  const base64 = audioBuffer.toString('base64');
  const dataUri = `data:${mimeType};base64,${base64}`;
  const res = await zapiClient.post('/send-audio', {
    phone: to,
    audio: dataUri,
  });
  logger.info({ to, zaapId: res.data?.zaapId }, '[Z-API] sendAudio');
  return res;
}

/**
 * Fetches full message details by ID from Z-API REST endpoint.
 * Fallback for when quotedMessage inline doesn't contain the caption.
 */
async function getMessageById(messageId) {
  try {
    const { data } = await zapiClient.get(`/messages/${messageId}`);
    return data;
  } catch (err) {
    logger.error({ messageId, error: err.message }, '[Z-API] getMessageById failed');
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendButtonList(to, message, title, footer, buttonList) {
  const payload = {
    phone: to,
    message,
    title,
    footer,
    buttonList,
  };

  try {
    const res = await zapiClient.post("/send-button-list", payload);
    logger.info({ to, zaapId: res.data?.zaapId }, "[Z-API] sendButtonList");
    return res;
  } catch (err) {
    logger.error({ err: err.message, payload }, "[Z-API] sendButtonList failed");
    throw err;
  }
}

/**
 * Envia uma mensagem de lista (Option List) - menu lateral profissional.
 * Endpoint correto da Z-API: /send-option-list
 * @param {string} to - telefone destino
 * @param {string} message - texto principal
 * @param {string} title - título da lista
 * @param {string} buttonLabel - texto do botão (max 20 chars)
 * @param {Array<{id:string, title:string, description:string}>} options - itens do menu
 */
async function sendOptionList(to, message, title, buttonLabel, options) {
  try {
    const typingSeconds = Math.min(Math.max(Math.ceil(message.length / 80), 1), 5);
    const payload = {
      phone: to,
      message,
      optionList: {
        title,
        buttonLabel,
        options,
      },
      delayMessage: typingSeconds,
    };
    const res = await zapiClient.post('/send-option-list', payload);
    logger.info({ to, zaapId: res.data?.zaapId }, '[Z-API] sendOptionList');
    return res;
  } catch (err) {
    logger.error({ err: err.message }, '[Z-API] sendOptionList failed');
    throw err;
  }
}

/**
 * Vitrine do produto: imagem + botão "Separar Tamanho" via /send-button-list.
 * @param {string} phone
 * @param {{ id: number, name: string, price: string, salePrice: string, imageUrl: string }} product
 * @param {number} version - interactiveVersion da sessão (anti-stale)
 */
async function sendProductShowcase(phone, product, version, customButtons = null) {
  const fmt = v => `R$ ${v.toFixed(2).replace('.', ',')}`;

  // Linha de preço: se há preços por variante, mostrá-los individualmente
  let priceLine;
  if (product.variantPrices && Object.keys(product.variantPrices).length > 0) {
    const lines = Object.entries(product.variantPrices)
      .map(([opt, p]) => {
        const pix = p.salePrice * (1 - PIX_DISCOUNT);
        return `• *${opt}* — PIX: ${fmt(pix)} | Cartão: ${fmt(p.salePrice)}`;
      })
      .join('\n');
    priceLine = lines;
  } else {
    // Preço base = salePrice se houver promoção WooCommerce, senão price normal
    const basePrice = parseFloat(product.salePrice || product.price);
    const pixPrice  = basePrice * (1 - PIX_DISCOUNT);
    priceLine = `💰 *PIX: ${fmt(pixPrice)}*\n💳 Cartão: ${fmt(basePrice)}`;
  }

  // Tamanhos disponíveis: usa sizeDetails (estoque real) se o produto foi enriquecido;
  // caso contrário usa product.sizes do catálogo como fallback.
  // sizeDetails é populado por woocommerce.enrichProductWithStock antes de chamar esta função.
  const availSizes = product.sizeDetails
    ? product.sizeDetails.filter(d => d.isAvailable !== false).map(d => d.size).filter(s => s !== 'ÚNICO')
    : (product.sizes || []).filter(s => s && s !== 'ÚNICO');

  // Para produtos com variantSizes, usar os tamanhos por variante na caption
  let sizeLine = '';
  if (product.variantSizes && Object.keys(product.variantSizes).length > 0) {
    const lines = Object.entries(product.variantSizes)
      .filter(([, sizes]) => sizes.length > 0)
      .map(([variant, sizes]) => `📏 ${variant}: *${sizes.join(' | ')}*`);
    if (lines.length > 0) sizeLine = '\n' + lines.join('\n');
  } else if (availSizes.length > 0) {
    sizeLine = `\n📏 Disponível: *${availSizes.join(' | ')}*`;
  }

  const payload = {
    phone,
    message: `✨ *${product.name}*\n${priceLine}${sizeLine}`,
    buttonList: {
      image: product.imageUrl,
      buttons: customButtons || [
        { id: `buy_${product.id}_v${version}`, label: '📐 Separar Tamanho' },
      ],
    },
  };

  try {
    const res = await zapiClient.post('/send-button-list', payload);
    logger.info({ phone, productId: product.id, zaapId: res.data?.zaapId }, '[Z-API] sendProductShowcase');
    return res;
  } catch (err) {
    logger.error({ err: err.message, productId: product.id }, '[Z-API] sendProductShowcase failed');
    throw err;
  }
}

/**
 * Menu de tamanhos disponíveis via /send-option-list.
 * @param {string} phone
 * @param {{ id: number, name: string, sizes: string[] }} product
 * @param {number} version
 */
async function sendSizeList(phone, product, version, excludeSizes = [], showSkip = false) {
  const sizeDetails = Array.isArray(product.sizeDetails) && product.sizeDetails.length > 0
    ? product.sizeDetails
    : (product.sizes || []).map((size) => ({ size, stockLabel: 'Disponível', isAvailable: true }));
  const options = sizeDetails
    .filter((detail) => detail.isAvailable !== false)
    .filter((detail) => !excludeSizes.includes(detail.size))
    .map((detail) => ({
      id: `size_${product.id}_${detail.size}_v${version}`,
      title: `Tamanho ${detail.size}`,
      description: detail.stockLabel || 'Disponível',
    }));

  if (showSkip) {
    options.push({ id: `skip_product_v${version}`, title: 'Não quero esse produto', description: 'Pular este item' });
  }

  if (options.length === 0 || (options.length === 1 && showSkip)) {
    const hasAvailableSizes = sizeDetails.some((detail) => detail.isAvailable !== false);
    await sendText(
      phone,
      !hasAvailableSizes
        ? `No momento *${product.name}* está sem tamanhos disponíveis para separar.`
        : `✅ Todos os tamanhos de *${product.name}* já foram adicionados!`
    );
    return;
  }

  const visibleDetails = sizeDetails
    .filter((detail) => detail.isAvailable !== false)
    .filter((detail) => !excludeSizes.includes(detail.size));

  const gradeItems = visibleDetails.map((detail) => {
    const qty = typeof detail.availableQuantity === 'number'
      ? detail.availableQuantity
      : typeof detail.stockQuantity === 'number'
        ? detail.stockQuantity
        : null;
    return qty !== null ? `${detail.size}→${qty}` : detail.size;
  });

  const variantLabel = product.variantLabel ? ` (${product.variantLabel})` : '';
  const gradeLine = `\n\n📋 *Grade${variantLabel}:* ${gradeItems.join(' · ')}`;

  const payload = {
    phone,
    message: `Qual tamanho de *${product.name}* você deseja?${gradeLine}`,
    optionList: {
      title: 'Tamanhos Disponíveis',
      buttonLabel: 'Escolher Tamanho',
      options,
    },
  };

  try {
    const res = await zapiClient.post('/send-option-list', payload);
    logger.info({ phone, productId: product.id, excludeSizes, zaapId: res.data?.zaapId }, '[Z-API] sendSizeList');
    return res;
  } catch (err) {
    logger.error({ err: err.message, productId: product.id }, '[Z-API] sendSizeList failed');
    throw err;
  }
}

/**
 * Lista de quantidades via /send-option-list — adequada para atacado.
 * Oferece de 1 a 12 peças; o cliente também pode digitar o número.
 * @param {string} phone
 * @param {string} size - tamanho já selecionado
 * @param {number} version
 */
async function sendQuantityList(phone, size, version, availableQty = null, showSkip = false) {
  const presetOptions = [
    { id: `qty_1_v${version}`,  title: '1 peça',   description: '' },
    { id: `qty_2_v${version}`,  title: '2 peças',  description: '' },
    { id: `qty_3_v${version}`,  title: '3 peças',  description: '' },
    { id: `qty_6_v${version}`,  title: '6 peças',  description: '' },
    { id: `qty_12_v${version}`, title: '12 peças', description: '' },
  ];
  const options = availableQty === null
    ? presetOptions
    : presetOptions.filter((option) => {
      const qty = Number(option.id.split('_')[1]);
      return Number.isFinite(qty) && qty <= availableQty;
    });

  if (showSkip) {
    options.push({ id: `skip_product_v${version}`, title: 'Não quero esse produto', description: 'Pular este item' });
  }

  const availabilityText = availableQty === null
    ? ''
    : ` Disponível: *${availableQty}*${availableQty === 1 ? ' peça' : ' peças'}.`;

  try {
    const res = await sendOptionList(
      phone,
      `Quantas peças no tamanho *${size}*?${availabilityText} (Pode digitar outro número se preferir 😊)`,
      'Quantidade',
      'Escolher Quantidade',
      options,
    );
    logger.info({ phone, size, availableQty, zaapId: res?.data?.zaapId }, '[Z-API] sendQuantityList');
    return res;
  } catch (err) {
    logger.error({ err: err.message }, '[Z-API] sendQuantityList failed');
    throw err;
  }
}

/**
 * Lista combinada tamanho+quantidade — uma interação fecha tamanho e qty.
 * ID: sizeqty_{productId}_{size}_{qty}_v{version}
 * @param {string} phone
 * @param {{ id: number, name: string }} product
 * @param {number} version - interactiveVersion anti-stale
 * @param {Array<{size, isAvailable, availableQuantity, stockLabel}>} sizeDetails
 */
async function sendSizeQuantityList(phone, product, version, sizeDetails) {
  const PRESET_QTY = [1, 2, 3, 6, 12];
  const options = [];

  for (const detail of sizeDetails.filter((d) => d.isAvailable !== false)) {
    const availQty = typeof detail.availableQuantity === 'number' ? detail.availableQuantity : null;
    let qtys = availQty === null ? PRESET_QTY : PRESET_QTY.filter((q) => q <= availQty);
    if (availQty !== null && qtys.length === 0) continue; // sem estoque
    if (availQty !== null && !qtys.includes(availQty)) qtys = [...qtys, availQty]; // adiciona "tudo"

    const stockDesc = availQty !== null
      ? `${availQty} ${availQty === 1 ? 'disponível' : 'disponíveis'} neste tamanho`
      : (detail.stockLabel || 'Disponível');

    for (const qty of qtys) {
      options.push({
        id: `sizeqty_${product.id}_${detail.size}_${qty}_v${version}`,
        title: `${detail.size} — ${qty} ${qty === 1 ? 'peça' : 'peças'}`,
        description: stockDesc,
      });
    }
  }

  if (options.length === 0) {
    await sendText(phone, `No momento *${product.name}* está sem tamanhos disponíveis para separar.`);
    return;
  }

  return await sendOptionList(
    phone,
    `Escolha o tamanho e a quantidade de *${product.name}* 😊\n_Pode digitar tamanho + quantidade (ex: 2M, 1G) ou usar o botão 👇_`,
    'Tamanho e Quantidade',
    'Ver Opções',
    options,
  );
}

/**
 * Botões "Sim, outro tamanho" / "Não, próximo produto" — fluxo atacado.
 * @param {string} phone
 * @param {string} productName
 * @param {number} version
 */
async function sendMoreSizesButtons(phone, productName, version) {
  const payload = {
    phone,
    message: `Quer adicionar outro tamanho de *${productName}*?`,
    buttonList: {
      buttons: [
        { id: `add_size_v${version}`,  label: '✅ Sim, outro tamanho' },
        { id: `skip_more_v${version}`, label: '➡️ Não, próximo produto' },
      ],
    },
  };

  try {
    const res = await zapiClient.post('/send-button-list', payload);
    logger.info({ phone, productName, zaapId: res.data?.zaapId }, '[Z-API] sendMoreSizesButtons');
    return res;
  } catch (err) {
    logger.error({ err: err.message }, '[Z-API] sendMoreSizesButtons failed');
    throw err;
  }
}

/**
 * Confirmação simplificada para produtos de tamanho único (selectedSize = 'ÚNICO').
 * Disparada quando o cliente ignora a pergunta de quantidade — evita loop de insistência.
 * Envia foto do produto + 3 botões: Adicionar (qty=1) | Pular | Escolher quantidade.
 *
 * Callers: interceptor awaiting_quantity ÚNICO em index.js.
 * Os IDs confirm_add_v{version} e show_qty_v{version} são tratados em handleFsmInteraction.
 * O botão skip_product_v{version} reutiliza o handler existente (linha ~2819).
 */
async function sendSingleSizeConfirm(phone, product, version) {
  const price = product.salePrice && product.salePrice !== product.price
    ? `~R$ ${parseFloat(product.price).toFixed(2).replace('.', ',')}~ → *R$ ${parseFloat(product.salePrice).toFixed(2).replace('.', ',')}*`
    : `R$ ${parseFloat(product.price).toFixed(2).replace('.', ',')}`;

  const payload = {
    phone,
    message: `Quer adicionar *${product.name}* ao pedido? 😊\n💰 ${price}`,
    buttonList: {
      image: product.imageUrl,
      buttons: [
        { id: `confirm_add_v${version}`,  label: '✅ Sim, adicionar' },
        { id: `skip_product_v${version}`, label: '❌ Pular este produto' },
        { id: `show_qty_v${version}`,     label: '🔢 Escolher quantidade' },
      ],
    },
  };

  try {
    const res = await zapiClient.post('/send-button-list', payload);
    logger.info({ phone, productId: product.id, zaapId: res.data?.zaapId }, '[Z-API] sendSingleSizeConfirm');
    return res;
  } catch (err) {
    logger.error({ err: err.message, productId: product.id }, '[Z-API] sendSingleSizeConfirm failed');
    throw err;
  }
}

/**
 * Reage a uma mensagem com emoji (ex: ✅, ❤️, 😂).
 * Fire-and-forget: nunca lança exceção — falha de reação não interrompe o fluxo.
 * Requer o messageId da mensagem original (vem de body?.messageId no webhook).
 *
 * Endpoint Z-API: POST /send-reaction
 * Callers: bloco grade parser em index.js (grade textual processada com sucesso).
 */
async function sendReaction(phone, messageId, reaction) {
  if (!messageId) return;
  try {
    await zapiClient.post('/send-reaction', { phone, messageId, reaction });
    logger.info({ phone, messageId, reaction }, '[Z-API] sendReaction');
  } catch (err) {
    logger.warn({ err: err.message, phone, reaction }, '[Z-API] sendReaction failed (non-critical)');
    // Intencionalmente não relança — reação nunca deve quebrar o fluxo principal
  }
}

/**
 * Lista interativa para escolha de variante (ex: Mãe / Filha).
 * ID de cada opção: `variant_v{version}_{valorNormalizado}`
 * @param {string} phone
 * @param {{ name: string, options: string[] }} attr
 * @param {number} version - versão da FSM (interactiveVersion)
 * @param {string} productName
 */
async function sendVariantOptionList(phone, attr, version, productName) {
  const options = attr.options.map((opt) => ({
    id: `variant_v${version}_${opt}`,
    title: opt,
    description: `Versão ${opt}`,
  }));

  const payload = {
    phone,
    message: `Qual versão de *${productName}* você quer separar?`,
    optionList: {
      title: attr.name || 'Versão',
      buttonLabel: 'Escolher Versão',
      options,
    },
  };

  try {
    const res = await zapiClient.post('/send-option-list', payload);
    logger.info({ phone, attr: attr.name, version, zaapId: res.data?.zaapId }, '[Z-API] sendVariantOptionList');
    return res;
  } catch (err) {
    logger.error({ err: err.message }, '[Z-API] sendVariantOptionList failed');
    throw err;
  }
}

/**
 * Envia card com foto do produto + botões de variante (ex: Mãe / Filha).
 * Usa /send-button-list — mesmo endpoint dos showcases de produto.
 * @param {string} phone
 * @param {{ name: string, imageUrl: string, salePrice: string, price: string }} product
 * @param {{ name: string, options: string[] }} attr
 * @param {number} version - versão da FSM (interactiveVersion)
 */
async function sendVariantButtonCard(phone, product, attr, version) {
  const fmt = v => `R$ ${v.toFixed(2).replace('.', ',')}`;

  const buildGradeLine = (details) => {
    if (!Array.isArray(details) || details.length === 0) return '';
    return details.map((d) => d.stockQuantity !== null ? `${d.size} (${d.stockQuantity})` : d.size).join(' | ');
  };

  let message;
  if (product.variantPrices && Object.keys(product.variantPrices).length > 0) {
    const lines = attr.options.map((opt) => {
      const prices = product.variantPrices[opt];
      if (!prices) return null;
      const pix  = prices.salePrice * (1 - PIX_DISCOUNT);
      const card = prices.salePrice;
      const priceLine = `• *${opt}* — PIX: ${fmt(pix)} | Cartão: ${fmt(card)}`;
      const grade = buildGradeLine(product.variantSizeDetails?.[opt]);
      return grade ? `${priceLine}\n  📏 ${grade}` : priceLine;
    }).filter(Boolean).join('\n');
    message = `✨ *${product.name}*\n\n${lines}`;
  } else {
    const basePrice = parseFloat(product.salePrice || product.price || '0');
    const pixPrice  = basePrice * (1 - PIX_DISCOUNT);
    message = `Qual versão de *${product.name}* você quer separar?\n💰 *PIX: ${fmt(pixPrice)}*  💳 ${fmt(basePrice)}`;
  }

  const buttons = attr.options.map(opt => ({
    id: `variant_v${version}_${opt}`,
    label: opt,
  }));

  const payload = {
    phone,
    message,
    buttonList: {
      image: product.imageUrl,
      buttons,
    },
  };

  const res = await zapiClient.post('/send-button-list', payload);
  logger.info({ phone, attr: attr.name, opts: attr.options, version }, '[Z-API] sendVariantButtonCard');
  return res;
}

/**
 * Menu inicial de escolha: catálogo ou vendedora humana.
 * Enviado antes de qualquer interação com clientes novos (history vazio).
 */
async function sendInitialGate(phone) {
  const payload = {
    phone,
    message: 'Olá! Sou a *Bela*, consultora da *Belux Moda Íntima* 👋\n\nO que você prefere agora?',
    buttonList: {
      buttons: [
        { id: 'btn_fechar_pedido', label: '📦 Fechar meu pedido' },
        { id: 'gate_catalog',      label: '🆕 Ver lançamentos' },
        { id: 'gate_seller',       label: '❓ Resolver um problema' },
      ],
    },
  };
  try {
    const res = await zapiClient.post('/send-button-list', payload);
    logger.info({ phone, zaapId: res.data?.zaapId }, '[Z-API] sendInitialGate');
    return res;
  } catch (err) {
    logger.error({ err: err.message }, '[Z-API] sendInitialGate failed');
    throw err;
  }
}

module.exports = { readMessage, sendText, replyText, sendImage, sendAudio, getMessageById, delay, sendButtonList, sendOptionList, sendProductShowcase, sendSizeList, sendQuantityList, sendSizeQuantityList, sendMoreSizesButtons, sendSingleSizeConfirm, sendReaction, sendVariantOptionList, sendVariantButtonCard, sendInitialGate };
