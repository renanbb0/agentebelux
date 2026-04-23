const test = require('node:test');
const assert = require('node:assert/strict');

test('buildProductGroupsFromCart agrupa itens por produto e consolida subtotal e pecas', () => {
  const { buildProductGroupsFromCart } = require('../services/order-groups');

  const groups = buildProductGroupsFromCart({
    items: [
      {
        productId: 101,
        productName: 'Pijama Bordado Ref 620B',
        imageUrl: 'https://example.com/pijama.png',
        size: 'G',
        quantity: 2,
        unitPrice: 46.25,
        price: 92.5,
      },
      {
        productId: 101,
        productName: 'Pijama Bordado Ref 620B',
        imageUrl: 'https://example.com/pijama.png',
        size: 'M',
        quantity: 1,
        unitPrice: 46.25,
        price: 46.25,
      },
      {
        productId: 202,
        productName: 'Pijama Mae e Filha Ref 604DTF',
        imageUrl: null,
        size: 'G',
        variant: 'Mae',
        quantity: 3,
        unitPrice: 26.8,
        price: 80.4,
      },
    ],
  });

  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], {
    productId: 101,
    productName: 'Pijama Bordado Ref 620B',
    imageUrl: 'https://example.com/pijama.png',
    variations: [
      { size: 'G', variant: null, quantity: 2, unitPrice: 46.25 },
      { size: 'M', variant: null, quantity: 1, unitPrice: 46.25 },
    ],
    subtotal: 138.75,
    totalPieces: 3,
  });
  assert.deepEqual(groups[1], {
    productId: 202,
    productName: 'Pijama Mae e Filha Ref 604DTF',
    imageUrl: null,
    variations: [
      { size: 'G', variant: 'Mae', quantity: 3, unitPrice: 26.8 },
    ],
    subtotal: 80.4,
    totalPieces: 3,
  });
});
