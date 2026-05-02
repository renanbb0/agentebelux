const assert = require('assert');
const { extractTextFromEvent, extractAudioUrl, extractEventVersion, parseSizeQtyEvent } = require('../../src/utils/event-extractor');

// ── extractTextFromEvent ─────────────────────────────────────────────────────

// texto simples (object format)
assert.strictEqual(extractTextFromEvent({ text: { message: 'oi' } }), 'oi');

// texto simples (string format)
assert.strictEqual(extractTextFromEvent({ text: 'olá' }), 'olá');

// list response — IDs canônicos mapeados
assert.strictEqual(extractTextFromEvent({ listResponseMessage: { selectedRowId: 'cat_feminina' } }), 'CAT_FEMININO');
assert.strictEqual(extractTextFromEvent({ listResponseMessage: { selectedRowId: 'cat_masculina' } }), 'CAT_MASCULINO');
assert.strictEqual(extractTextFromEvent({ listResponseMessage: { selectedRowId: 'cat_feminino_infantil' } }), 'CAT_FEMININOINFANTIL');
assert.strictEqual(extractTextFromEvent({ listResponseMessage: { selectedRowId: 'cat_masculino_infantil' } }), 'CAT_MASCULINOINFANTIL');
assert.strictEqual(extractTextFromEvent({ listResponseMessage: { selectedRowId: 'cart_view' } }), 'CART_VIEW');
assert.strictEqual(extractTextFromEvent({ listResponseMessage: { selectedRowId: 'cart_finalize' } }), 'CART_FINALIZE');
assert.strictEqual(extractTextFromEvent({ listResponseMessage: { selectedRowId: 'falar_atendente' } }), 'FALAR_ATENDENTE');
assert.strictEqual(extractTextFromEvent({ listResponseMessage: { selectedRowId: 'cart_more_products' } }), 'VER_MAIS_PRODUTOS');
// list response — ID desconhecido passa-através
assert.strictEqual(extractTextFromEvent({ listResponseMessage: { selectedRowId: 'buy_42' } }), 'buy_42');

// buttonsResponseMessage
assert.strictEqual(extractTextFromEvent({ buttonsResponseMessage: { buttonId: 'btn_fechar_pedido' } }), 'BTN_FECHAR_PEDIDO');
assert.strictEqual(extractTextFromEvent({ buttonsResponseMessage: { buttonId: 'cat_feminina' } }), 'CAT_FEMININO');
assert.strictEqual(extractTextFromEvent({ buttonsResponseMessage: { buttonId: 'falar_atendente' } }), 'FALAR_ATENDENTE');
// id já canônico
assert.strictEqual(extractTextFromEvent({ buttonsResponseMessage: { buttonId: 'CAT_MASCULINO' } }), 'CAT_MASCULINO');

// button_reply
assert.strictEqual(extractTextFromEvent({ type: 'button_reply', buttonReply: { id: 'btn_outra_cat' } }), 'OUTRA CATEGORIA');
assert.strictEqual(extractTextFromEvent({ type: 'button_reply', buttonReply: { id: 'cart_view' } }), 'CART_VIEW');
assert.strictEqual(extractTextFromEvent({ type: 'button_reply', buttonReply: { id: 'cat_feminina' } }), 'CAT_FEMININO');
assert.strictEqual(extractTextFromEvent({ type: 'button_reply', buttonReply: { id: 'size_M_v3' } }), 'size_M_v3');

// áudio retorna sentinela
assert.strictEqual(extractTextFromEvent({ audio: { audioUrl: 'http://x' } }), '[Áudio_STT]');

// imagem com legenda
assert.strictEqual(extractTextFromEvent({ image: { caption: '  P M G  ' } }), 'P M G');

// sticker
assert.strictEqual(extractTextFromEvent({ sticker: true }), '[Sticker]');

// null/undefined retorna string vazia
assert.strictEqual(extractTextFromEvent(null), '');
assert.strictEqual(extractTextFromEvent(undefined), '');
assert.strictEqual(extractTextFromEvent({}), '');

// ── extractAudioUrl ──────────────────────────────────────────────────────────

assert.strictEqual(extractAudioUrl({ audio: { audioUrl: 'http://a.mp3' } }), 'http://a.mp3');
assert.strictEqual(extractAudioUrl({ audio: { url: 'http://b.mp3' } }), 'http://b.mp3');
assert.strictEqual(extractAudioUrl({ audioUrl: 'http://c.mp3' }), 'http://c.mp3');
assert.strictEqual(extractAudioUrl({ message: { audioUrl: 'http://d.mp3' } }), 'http://d.mp3');
assert.strictEqual(extractAudioUrl({ message: { audio: { audioUrl: 'http://e.mp3' } } }), 'http://e.mp3');
assert.strictEqual(extractAudioUrl({ message: { audio: { url: 'http://f.mp3' } } }), 'http://f.mp3');
assert.strictEqual(extractAudioUrl({}), null);
assert.strictEqual(extractAudioUrl(null), null);

// ── extractEventVersion ──────────────────────────────────────────────────────

assert.strictEqual(extractEventVersion('size_M_v3'), 3);
assert.strictEqual(extractEventVersion('qty_P_v10'), 10);
assert.strictEqual(extractEventVersion('sizeqty_42_M_2_v1'), 1);
assert.strictEqual(extractEventVersion('size_M'), null);
assert.strictEqual(extractEventVersion('cat_feminina'), null);

// ── parseSizeQtyEvent ────────────────────────────────────────────────────────

assert.deepStrictEqual(parseSizeQtyEvent('sizeqty_42_M_2_v1'), { productIdStr: '42', size: 'M', qty: 2 });
assert.deepStrictEqual(parseSizeQtyEvent('sizeqty_99_GG_3_v2'), { productIdStr: '99', size: 'GG', qty: 3 });
// tamanho multi-char
assert.deepStrictEqual(parseSizeQtyEvent('sizeqty_7_EXG_1'), { productIdStr: '7', size: 'EXG', qty: 1 });
// prefix errado → null
assert.strictEqual(parseSizeQtyEvent('size_M_v3'), null);
assert.strictEqual(parseSizeQtyEvent(null), null);
assert.strictEqual(parseSizeQtyEvent(''), null);
// partes insuficientes
assert.strictEqual(parseSizeQtyEvent('sizeqty_42_M'), null);

console.log('✓ event-extractor');
