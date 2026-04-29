const test = require('node:test');
const assert = require('node:assert/strict');

const {
  searchCatalog,
  splitStock,
} = require('../services/catalog-search');

function product(id, name, stockStatus = 'instock') {
  return {
    id,
    name,
    price: '50',
    regularPrice: '50',
    salePrice: '',
    stockStatus,
    imageUrl: `https://example.test/${id}.jpg`,
    images: [`https://example.test/${id}.jpg`],
    sizes: ['M', 'G'],
    secondaryAttributes: [],
  };
}

test('splitStock separa produtos em estoque e sem estoque', () => {
  const result = splitStock([
    product(1, 'Pijama disponivel', 'instock'),
    product(2, 'Pijama acabou', 'outofstock'),
  ]);

  assert.deepEqual(result.inStock.map((p) => p.id), [1]);
  assert.deepEqual(result.outOfStock.map((p) => p.id), [2]);
});

test('searchCatalog marca match unico em estoque para abrir tamanho', async () => {
  const p = product(101, 'Pijama Homem Aranha');
  const result = await searchCatalog(
    { shouldHandle: true, query: 'homem aranha', intentType: 'theme', theme: 'homem aranha' },
    {
      woocommerce: {
        searchProducts: async () => ({ products: [p] }),
        searchProductsIncludingOutOfStock: async () => ({ products: [p] }),
      },
      imageMatcher: { searchByText: async () => ({ candidates: [] }) },
    }
  );

  assert.equal(result.source, 'woocommerce');
  assert.equal(result.shouldAutoOpen, true);
  assert.deepEqual(result.inStock.map((item) => item.id), [101]);
});

test('searchCatalog nao abre automaticamente busca com multiplos produtos', async () => {
  const result = await searchCatalog(
    { shouldHandle: true, query: 'pijama longo', intentType: 'product' },
    {
      woocommerce: {
        searchProducts: async () => ({ products: [product(1, 'Pijama longo A'), product(2, 'Pijama longo B')] }),
        searchProductsIncludingOutOfStock: async () => ({ products: [] }),
      },
      imageMatcher: { searchByText: async () => ({ candidates: [] }) },
    }
  );

  assert.equal(result.shouldAutoOpen, false);
  assert.deepEqual(result.inStock.map((item) => item.id), [1, 2]);
});

test('searchCatalog usa categoria WooCommerce quando intencao e categoria ampla', async () => {
  const calls = [];
  const result = await searchCatalog(
    { shouldHandle: true, query: 'feminino', intentType: 'category', categorySlug: 'feminino' },
    {
      woocommerce: {
        getProductsByCategory: async (slug) => {
          calls.push(slug);
          return { products: [product(8, 'Conjunto feminino')] };
        },
        searchProducts: async () => {
          calls.push('searchProducts');
          return { products: [] };
        },
        searchProductsIncludingOutOfStock: async () => ({ products: [] }),
      },
      imageMatcher: { searchByText: async () => ({ candidates: [] }) },
    }
  );

  assert.deepEqual(calls, ['feminino']);
  assert.equal(result.source, 'category');
  assert.deepEqual(result.inStock.map((item) => item.id), [8]);
});

test('searchCatalog usa busca incluindo sem estoque para explicar produto indisponivel', async () => {
  const unavailable = product(10, 'Pijama longo ontem', 'outofstock');
  const similar = product(11, 'Pijama longo parecido', 'instock');
  let stockSearchCalls = 0;

  const result = await searchCatalog(
    { shouldHandle: true, query: 'pijama longo', intentType: 'product', isRestockQuestion: true },
    {
      woocommerce: {
        searchProducts: async () => {
          stockSearchCalls++;
          return { products: stockSearchCalls === 1 ? [] : [similar] };
        },
        searchProductsIncludingOutOfStock: async () => ({ products: [unavailable] }),
      },
      imageMatcher: { searchByText: async () => ({ candidates: [] }) },
    }
  );

  assert.deepEqual(result.outOfStock.map((item) => item.id), [10]);
  assert.deepEqual(result.similarInStock.map((item) => item.id), [11]);
});

test('searchCatalog usa fallback semantico quando WooCommerce nao encontra por titulo', async () => {
  const resolved = product(672, 'Pijama Masculino Ref 672S');
  const result = await searchCatalog(
    { shouldHandle: true, query: 'sonic', intentType: 'theme', theme: 'sonic' },
    {
      woocommerce: {
        searchProducts: async () => ({ products: [] }),
        searchProductsIncludingOutOfStock: async () => ({ products: [] }),
      },
      imageMatcher: { searchByText: async () => ({ candidates: [{ product_id: 672, score: 0.82 }] }) },
      resolveProductById: async (productId) => (productId === 672 ? resolved : null),
    }
  );

  assert.equal(result.source, 'semantic');
  assert.equal(result.shouldAutoOpen, true);
  assert.deepEqual(result.inStock.map((item) => item.id), [672]);
});

test('searchCatalog cai para lancamento-da-semana quando data de ontem nao retorna produtos', async () => {
  const launch = product(77, 'Pijama longo lancamento');
  const calls = [];

  const result = await searchCatalog(
    { shouldHandle: true, query: 'pijama longo', intentType: 'product', recency: { type: 'yesterday' } },
    {
      woocommerce: {
        searchProductsByDate: async () => {
          calls.push('date');
          return { products: [] };
        },
        getProductsByCategory: async (slug) => {
          calls.push(slug);
          return { products: [launch] };
        },
        searchProducts: async () => ({ products: [] }),
        searchProductsIncludingOutOfStock: async () => ({ products: [] }),
      },
      imageMatcher: { searchByText: async () => ({ candidates: [] }) },
    }
  );

  assert.deepEqual(calls, ['date', 'lancamento-da-semana']);
  assert.equal(result.source, 'launch_fallback');
  assert.deepEqual(result.inStock.map((item) => item.id), [77]);
});
