const test = require('node:test');
const assert = require('node:assert/strict');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=',
  'base64'
);

test('generateOrderPdf retorna um buffer PDF com resumo do pedido', async () => {
  const pdf = require('../services/pdf');

  const buffer = await pdf.generateOrderPdf(
    {
      customerName: 'Marcia Silveira',
      phone: '5585981244025',
      productGroups: [
        {
          productId: 101,
          productName: 'Pijama Bordado - Ref 620B',
          imageUrl: 'https://example.com/pijama.png',
          variations: [
            { size: 'G', variant: null, quantity: 2, unitPrice: 46.25 },
            { size: 'M', variant: null, quantity: 1, unitPrice: 46.25 },
          ],
          subtotal: 138.75,
          totalPieces: 3,
        },
      ],
      total: 138.75,
      pixDiscountPct: 10,
    },
    {
      axiosClient: {
        get: async () => ({ data: PNG_1X1 }),
      },
      now: new Date('2026-04-21T17:05:54-03:00'),
    }
  );

  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.toString('ascii', 0, 4), '%PDF');
  assert.ok(buffer.length > 1000);
});

test('generateOrderPdf continua gerando PDF quando o download da imagem falha', async () => {
  const pdf = require('../services/pdf');

  const buffer = await pdf.generateOrderPdf(
    {
      customerName: 'Marcia Silveira',
      phone: '5585981244025',
      productGroups: [
        {
          productId: 202,
          productName: 'Pijama Mae e Filha - Ref 604DTF e Ref 704DTF',
          imageUrl: 'https://example.com/quebrada.png',
          variations: [
            { size: 'G', variant: 'Mae', quantity: 1, unitPrice: 26.8 },
            { size: 'G', variant: 'Filha', quantity: 1, unitPrice: 26.8 },
          ],
          subtotal: 53.6,
          totalPieces: 2,
        },
      ],
      total: 53.6,
      pixDiscountPct: 10,
    },
    {
      axiosClient: {
        get: async () => {
          throw new Error('timeout');
        },
      },
      now: new Date('2026-04-21T17:05:54-03:00'),
    }
  );

  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.toString('ascii', 0, 4), '%PDF');
  assert.ok(buffer.length > 1000);
});
