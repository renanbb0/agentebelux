function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function dedupeProducts(products) {
  const seen = new Set();
  const deduped = [];
  for (const product of products || []) {
    if (!product?.id || seen.has(String(product.id))) continue;
    seen.add(String(product.id));
    deduped.push(product);
  }
  return deduped;
}

function isProductInStock(product) {
  if (!product) return false;
  if (product.stockStatus === 'outofstock') return false;
  if (typeof product.stockQuantity === 'number' && product.stockQuantity <= 0 && product.stockStatus !== 'instock') return false;
  return true;
}

function splitStock(products) {
  const inStock = [];
  const outOfStock = [];

  for (const product of dedupeProducts(products)) {
    if (isProductInStock(product)) {
      inStock.push(product);
    } else {
      outOfStock.push(product);
    }
  }

  return { inStock, outOfStock };
}

function buildDateWindowForRecency(recency, now = new Date()) {
  if (recency?.type !== 'yesterday') return null;

  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 1);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    after: start.toISOString(),
    before: end.toISOString(),
  };
}

function productMatchesQuery(product, query) {
  const cleanQuery = normalize(query)
    .split(/\s+/)
    .filter((token) => token.length > 2);
  if (cleanQuery.length === 0) return true;

  const haystack = normalize(`${product?.name || ''} ${product?.description || ''}`);
  return cleanQuery.every((token) => haystack.includes(token));
}

async function safeCall(logger, label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    logger?.warn?.({ err: err?.message || String(err), label }, '[CatalogSearch] etapa falhou');
    return fallback;
  }
}

async function resolveSemanticProducts(intent, deps, topK) {
  if (!deps.imageMatcher?.searchByText) return [];

  const semantic = await deps.imageMatcher.searchByText(intent.query, topK, 0.55);
  const candidates = semantic?.candidates || [];
  if (candidates.length === 0) return [];

  const resolver = deps.resolveProductById
    || ((productId) => deps.woocommerce?.getProductById?.(productId));
  if (!resolver) return [];

  const resolved = await Promise.all(
    candidates.map((candidate) => resolver(candidate.product_id).catch(() => null))
  );

  return resolved.filter(Boolean);
}

function shouldAutoOpenResult(intent, source, inStock) {
  if (inStock.length !== 1) return false;
  if (intent.reference || intent.theme || intent.isStockQuestion || intent.isRestockQuestion) return true;
  return source === 'semantic' || source === 'date';
}

async function searchCatalog(intent, deps, options = {}) {
  const logger = deps.logger;
  const perPage = options.perPage || 10;
  const empty = {
    handled: false,
    intent,
    source: 'none',
    inStock: [],
    outOfStock: [],
    similarInStock: [],
    shouldAutoOpen: false,
  };

  if (!intent?.shouldHandle || !intent.query) return empty;

  let products = [];
  let source = 'none';
  const dateWindow = buildDateWindowForRecency(intent.recency, options.now || new Date());

  if (dateWindow && deps.woocommerce?.searchProductsByDate) {
    const dateResult = await safeCall(logger, 'searchProductsByDate', () =>
      deps.woocommerce.searchProductsByDate({
        query: intent.query,
        after: dateWindow.after,
        before: dateWindow.before,
        perPage,
        page: 1,
      }), { products: [] });
    products = dateResult.products || [];
    if (products.length > 0) source = 'date';

    if (products.length === 0 && deps.woocommerce?.getProductsByCategory) {
      const launches = await safeCall(logger, 'getProductsByCategory', () =>
        deps.woocommerce.getProductsByCategory('lancamento-da-semana', perPage, 1), { products: [] });
      products = (launches.products || []).filter((product) => productMatchesQuery(product, intent.query));
      if (products.length > 0) source = 'launch_fallback';
    }
  }

  if (products.length === 0 && intent.intentType === 'category' && intent.categorySlug && deps.woocommerce?.getProductsByCategory) {
    const categoryResult = await safeCall(logger, 'getProductsByCategory', () =>
      deps.woocommerce.getProductsByCategory(intent.categorySlug, perPage, 1), { products: [] });
    products = categoryResult.products || [];
    if (products.length > 0) source = 'category';
  }

  if (products.length === 0 && deps.woocommerce?.searchProducts) {
    const wooResult = await safeCall(logger, 'searchProducts', () =>
      deps.woocommerce.searchProducts(intent.query, perPage, 1), { products: [] });
    products = wooResult.products || [];
    if (products.length > 0) source = 'woocommerce';
  }

  if (products.length === 0) {
    const semanticProducts = await safeCall(logger, 'semanticSearch', () =>
      resolveSemanticProducts(intent, deps, Math.min(perPage, 8)), []);
    products = semanticProducts;
    if (products.length > 0) source = 'semantic';
  }

  let { inStock, outOfStock } = splitStock(products);

  if (inStock.length === 0 && deps.woocommerce?.searchProductsIncludingOutOfStock) {
    const allResult = await safeCall(logger, 'searchProductsIncludingOutOfStock', () =>
      deps.woocommerce.searchProductsIncludingOutOfStock(intent.query, perPage, 1), { products: [] });
    const allStock = splitStock(allResult.products || []);
    inStock = allStock.inStock;
    outOfStock = allStock.outOfStock;
    if (inStock.length > 0 || outOfStock.length > 0) source = source === 'none' ? 'woocommerce_all_stock' : source;
  }

  let similarInStock = [];
  if (inStock.length === 0 && outOfStock.length > 0 && deps.woocommerce?.searchProducts) {
    const similarQuery = intent.productType || intent.categorySlug || intent.query;
    const similarResult = await safeCall(logger, 'similarInStock', () =>
      deps.woocommerce.searchProducts(similarQuery, perPage, 1), { products: [] });
    similarInStock = splitStock(similarResult.products || []).inStock
      .filter((product) => !outOfStock.some((oos) => String(oos.id) === String(product.id)));
  }

  return {
    handled: inStock.length > 0 || outOfStock.length > 0 || similarInStock.length > 0,
    intent,
    source,
    inStock,
    outOfStock,
    similarInStock,
    shouldAutoOpen: shouldAutoOpenResult(intent, source, inStock),
  };
}

module.exports = {
  buildDateWindowForRecency,
  searchCatalog,
  splitStock,
};
