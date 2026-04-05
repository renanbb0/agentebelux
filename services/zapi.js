const axios = require('axios');
const logger = require('./logger');

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
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
  if (!replyToMessageId) return sendText(to, message);
  const typingSeconds = Math.min(Math.max(Math.ceil(message.length / 80), 1), 5);
  const res = await zapiClient.post('/send-text', {
    phone: to,
    message,
    messageId: replyToMessageId,
    delayTyping: typingSeconds,
  });
  logger.info({ to, typingSeconds, replyTo: replyToMessageId, zaapId: res.data?.zaapId }, '[Z-API] replyText');
  return res;
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

async function sendAudio(to, audioBuffer, mimeType = 'audio/mp3') {
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
 * Vitrine do produto: imagem + botão "Comprar" via /send-button-list.
 * @param {string} phone
 * @param {{ id: number, name: string, price: string, salePrice: string, imageUrl: string }} product
 * @param {number} version - interactiveVersion da sessão (anti-stale)
 */
async function sendProductShowcase(phone, product, version) {
  const price = product.salePrice && product.salePrice !== product.price
    ? `~R$ ${parseFloat(product.price).toFixed(2).replace('.', ',')}~ → *R$ ${parseFloat(product.salePrice).toFixed(2).replace('.', ',')}*`
    : `R$ ${parseFloat(product.price).toFixed(2).replace('.', ',')}`;

  const payload = {
    phone,
    message: `✨ *${product.name}*\n💰 ${price}`,
    buttonList: {
      image: product.imageUrl,
      buttons: [
        { id: `buy_${product.id}_v${version}`, label: '🛍️ Comprar' },
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
async function sendSizeList(phone, product, version, excludeSizes = []) {
  const options = product.sizes
    .filter(size => !excludeSizes.includes(size))
    .map(size => ({
      id: `size_${product.id}_${size}_v${version}`,
      title: `Tamanho ${size}`,
      description: 'Disponível',
    }));

  if (options.length === 0) {
    await sendText(phone, `✅ Todos os tamanhos de *${product.name}* já foram adicionados!`);
    return;
  }

  const payload = {
    phone,
    message: `Qual tamanho de *${product.name}* você deseja?`,
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
async function sendQuantityList(phone, size, version) {
  const options = [
    { id: `qty_1_v${version}`,  title: '1 peça',   description: '' },
    { id: `qty_2_v${version}`,  title: '2 peças',  description: '' },
    { id: `qty_3_v${version}`,  title: '3 peças',  description: '' },
    { id: `qty_6_v${version}`,  title: '6 peças',  description: '' },
    { id: `qty_12_v${version}`, title: '12 peças', description: '' },
  ];

  try {
    const res = await sendOptionList(
      phone,
      `Quantas peças no tamanho *${size}*? (Pode digitar outro número se preferir 😊)`,
      'Quantidade',
      'Escolher Quantidade',
      options,
    );
    logger.info({ phone, size, zaapId: res?.data?.zaapId }, '[Z-API] sendQuantityList');
    return res;
  } catch (err) {
    logger.error({ err: err.message }, '[Z-API] sendQuantityList failed');
    throw err;
  }
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

module.exports = { readMessage, sendText, replyText, sendImage, sendAudio, getMessageById, delay, sendButtonList, sendOptionList, sendProductShowcase, sendSizeList, sendQuantityList, sendMoreSizesButtons };
