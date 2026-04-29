const test = require('node:test');
const assert = require('node:assert/strict');

function loadWooWithFakeAxios(fakeApi) {
  const axiosPath = require.resolve('axios');
  const wooPath = require.resolve('../services/woocommerce');
  const originalAxios = require.cache[axiosPath];
  delete require.cache[wooPath];
  require.cache[axiosPath] = {
    id: axiosPath,
    filename: axiosPath,
    loaded: true,
    exports: { create: () => fakeApi },
  };

  try {
    return require('../services/woocommerce');
  } finally {
    delete require.cache[wooPath];
    if (originalAxios) {
      require.cache[axiosPath] = originalAxios;
    } else {
      delete require.cache[axiosPath];
    }
  }
}

function rawProduct(overrides = {}) {
  return {
    id: 99,
    name: 'Pijama teste',
    type: 'variable',
    price: '50',
    regular_price: '50',
    sale_price: '',
    stock_status: 'outofstock',
    stock_quantity: 0,
    images: [{ src: 'https://example.test/p.jpg' }],
    attributes: [],
    permalink: 'https://example.test/p',
    short_description: '<p>Descricao</p>',
    date_created: '2026-04-28T10:00:00',
    date_modified: '2026-04-28T11:00:00',
    status: 'publish',
    ...overrides,
  };
}

test('searchProductsIncludingOutOfStock busca publicados sem stock_status e preserva datas', async () => {
  const calls = [];
  const woo = loadWooWithFakeAxios({
    get: async (url, config) => {
      calls.push({ url, params: config.params });
      return {
        headers: { 'x-wp-total': '1', 'x-wp-totalpages': '1' },
        data: [rawProduct()],
      };
    },
  });

  const result = await woo.searchProductsIncludingOutOfStock('pijama longo', 5, 2);

  assert.equal(calls[0].url, '/products');
  assert.equal(calls[0].params.search, 'pijama longo');
  assert.equal(calls[0].params.per_page, 5);
  assert.equal(calls[0].params.page, 2);
  assert.equal(calls[0].params.status, 'publish');
  assert.equal('stock_status' in calls[0].params, false);
  assert.equal(result.products[0].stockStatus, 'outofstock');
  assert.equal(result.products[0].dateCreated, '2026-04-28T10:00:00');
  assert.equal(result.products[0].dateModified, '2026-04-28T11:00:00');
});

test('searchProductsByDate envia janela de datas e filtra estoque por padrao', async () => {
  const calls = [];
  const woo = loadWooWithFakeAxios({
    get: async (url, config) => {
      calls.push({ url, params: config.params });
      return {
        headers: { 'x-wp-total': '0', 'x-wp-totalpages': '1' },
        data: [],
      };
    },
  });

  await woo.searchProductsByDate({
    query: 'pijama longo',
    after: '2026-04-28T00:00:00-03:00',
    before: '2026-04-29T00:00:00-03:00',
    perPage: 12,
    page: 1,
  });

  assert.equal(calls[0].url, '/products');
  assert.equal(calls[0].params.search, 'pijama longo');
  assert.equal(calls[0].params.after, '2026-04-28T00:00:00-03:00');
  assert.equal(calls[0].params.before, '2026-04-29T00:00:00-03:00');
  assert.equal(calls[0].params.stock_status, 'instock');
  assert.equal(calls[0].params.orderby, 'date');
});
