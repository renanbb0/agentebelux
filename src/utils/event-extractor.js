const logger = require('../../services/logger');

function extractTextFromEvent(event) {
  try {
    if (!event) return '';

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
      if (listId === 'cart_more_products') return 'VER_MAIS_PRODUTOS';
      if (listId === 'falar_atendente') return 'FALAR_ATENDENTE';
      if (listId === 'buscar_produto') return 'BUSCAR_PRODUTO_MENU';
      return listId;
    }

    // Botões de cards sendButtonList (buttonsResponseMessage)
    const brmId = event.buttonsResponseMessage?.buttonId;
    if (brmId) {
      logger.info({ buttonId: brmId }, '[extractText] buttonsResponseMessage recebido');
      if (brmId === 'btn_fechar_pedido')   return 'BTN_FECHAR_PEDIDO';
      if (brmId === 'btn_lancamentos')     return 'CAT_LANCAMENTOS';
      if (brmId === 'btn_problema')        return 'FALAR_ATENDENTE';
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
      return brmId;
    }

    if (event.type === 'button_reply' && event.buttonReply?.id) {
      if (event.buttonReply.id === 'btn_outra_cat')       return 'OUTRA CATEGORIA';
      if (event.buttonReply.id === 'cart_view')           return 'CART_VIEW';
      if (event.buttonReply.id === 'cart_finalize')       return 'CART_FINALIZE';
      if (event.buttonReply.id === 'cart_remove_item')    return 'CART_REMOVE_ITEM';
      if (event.buttonReply.id === 'cart_other_category') return 'VER_OUTRA_CATEGORIA';
      if (event.buttonReply.id === 'cart_more_products')  return 'VER_MAIS_PRODUTOS';
      if (event.buttonReply.id === 'falar_atendente')     return 'FALAR_ATENDENTE';
      if (event.buttonReply.id === 'cat_feminina')        return 'CAT_FEMININO';
      if (event.buttonReply.id === 'cat_masculina')       return 'CAT_MASCULINO';
      if (event.buttonReply.id === 'cat_lancamentos')     return 'CAT_LANCAMENTOS';
      return event.buttonReply.id;
    }

    if (typeof event.text === 'string') return event.text;
    if (event.text && typeof event.text.message === 'string') return event.text.message;
    if (event.content && typeof event.content === 'string') return event.content;
    if (event.audio || event?.message?.audio) return '[Áudio_STT]';
    if (event.image?.caption) return event.image.caption.trim();
    if (event.sticker) return '[Sticker]';

    return event.text?.message || event.content || '';
  } catch {
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

function extractEventVersion(eventId) {
  const match = eventId.match(/_v(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

function parseSizeQtyEvent(eventId) {
  if (!eventId?.startsWith('sizeqty_')) return null;

  // Formato: sizeqty_{productId}_{size}_{qty}_v{version}
  const withoutPrefix = eventId.slice('sizeqty_'.length);
  const vIdx = withoutPrefix.lastIndexOf('_v');
  const withoutVersion = vIdx >= 0 ? withoutPrefix.slice(0, vIdx) : withoutPrefix;
  const parts = withoutVersion.split('_');

  if (parts.length < 3) return null;

  const productIdStr = parts[0];
  const qty = parseInt(parts[parts.length - 1], 10);
  const size = parts.slice(1, -1).join('_');

  return { productIdStr, size, qty };
}

module.exports = { extractTextFromEvent, extractAudioUrl, extractEventVersion, parseSizeQtyEvent };
