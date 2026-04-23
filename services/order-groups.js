function buildProductGroupsFromCart({ items = [] } = {}) {
  const groups = {};

  for (const item of items) {
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
 * Parseia a caption curta enviada pela cliente ("2g", "3m", "2m 1g", "3M 2GG")
 * em variações {size, quantity}. Regex captura "<num><letras>" em qualquer
 * ordem de espaçamento. Retorna null se a caption não tiver pares decodificáveis.
 */
function parseCaptionVariations(caption) {
  if (!caption) return null;
  const matches = [...String(caption).matchAll(/(\d+)\s*([A-Za-z]{1,4})/g)];
  if (matches.length === 0) return null;
  return matches
    .map((m) => ({
      size: m[2].toUpperCase(),
      quantity: parseInt(m[1], 10),
    }))
    .filter((v) => v.quantity > 0 && v.quantity <= 999);
}

/**
 * Adapta o array `matchedProducts` do fluxo fechar_pedido_pending para o shape
 * que `pdfService.generateOrderPdf` espera. Agrupa por productId, parseia
 * captions em variações (size+qty) e calcula subtotal com preço unitário bruto
 * (o desconto PIX é aplicado pelo próprio generateOrderPdf via pixDiscountPct).
 *
 * Shape de entrada (matched):
 *   { productId, name, price, caption, imageUrl?, confidence, uncertain }
 * Shape de saída (group):
 *   { productId, productName, imageUrl, variations[], subtotal, totalPieces }
 */
function buildProductGroupsFromMatched(matched = []) {
  const groups = {};

  for (const m of matched) {
    const key = m.productId;
    const unitPrice = parseFloat(m.price) || 0;
    if (!groups[key]) {
      groups[key] = {
        productId: m.productId,
        productName: m.name,
        imageUrl: m.imageUrl || null,
        variations: [],
        subtotal: 0,
        totalPieces: 0,
      };
    }

    const parsed = parseCaptionVariations(m.caption);
    if (parsed && parsed.length > 0) {
      for (const v of parsed) {
        groups[key].variations.push({
          size: v.size,
          variant: null,
          quantity: v.quantity,
          unitPrice,
        });
        groups[key].subtotal += unitPrice * v.quantity;
        groups[key].totalPieces += v.quantity;
      }
    } else {
      groups[key].variations.push({
        size: m.caption ? String(m.caption).trim() : '-',
        variant: null,
        quantity: 1,
        unitPrice,
      });
      groups[key].subtotal += unitPrice;
      groups[key].totalPieces += 1;
    }
  }

  return Object.values(groups);
}

module.exports = {
  buildProductGroupsFromCart,
  buildProductGroupsFromMatched,
  parseCaptionVariations,
};
