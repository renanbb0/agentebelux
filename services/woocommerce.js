const axios = require('axios');
const logger = require('./logger');

const WC_BASE_URL = process.env.WC_BASE_URL?.trim();
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY?.trim();
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET?.trim();

const wooApi = axios.create({
  baseURL: WC_BASE_URL,
  auth: {
    username: WC_CONSUMER_KEY,
    password: WC_CONSUMER_SECRET,
  },
  timeout: 30000, // 30s — WordPress pode ser lento sob carga
});

// In-memory cache for category IDs with TTL — avoids repeated lookups on each request
const categoryCache = new Map();
const CATEGORY_CACHE_TTL_MS = 10 * 60 * 1000;
const variationCache = new Map();
const VARIATION_CACHE_TTL_MS = 2 * 60 * 1000;

// Cache de lista de produtos por categoria — evita múltiplas chamadas ao WordPress
// sob concorrência (que pode derrubar o host). TTL de 5 min: produtos raramente mudam
// entre atendimentos. Retornamos shallow copies para não compartilhar mutações entre
// sessões (enrichProductWithStock modifica o objeto in-place).
const productListCache = new Map();
const PRODUCT_LIST_CACHE_TTL_MS = 5 * 60 * 1000;

// Cache de busca por texto — TTL menor (3 min) pois queries são mais variadas
const searchCache = new Map();
const SEARCH_CACHE_TTL_MS = 3 * 60 * 1000;

/**
 * Looks up a WooCommerce category ID by slug, with in-memory caching (TTL 10 min).
 * @param {string} slug - Category slug
 * @returns {Promise<number|null>} Category ID or null
 */
async function getCategoryIdBySlug(slug) {
  const cached = categoryCache.get(slug);
  if (cached && (Date.now() - cached.loadedAt) < CATEGORY_CACHE_TTL_MS) {
    return cached.id;
  }

  const { data: categories } = await wooApi.get('/products/categories', {
    params: { slug, per_page: 1 },
  });

  const id = categories.length > 0 ? categories[0].id : null;
  if (id) categoryCache.set(slug, { id, loadedAt: Date.now() });
  return id;
}

/**
 * Fetches products for a category with pagination.
 * Results are cached in memory for PRODUCT_LIST_CACHE_TTL_MS (5 min) to reduce
 * WordPress load under concurrent usage. Returns shallow copies of cached products
 * so that enrichProductWithStock mutations don't pollute the cache.
 */
async function getProductsByCategory(categorySlug, perPage = 10, page = 1) {
  const cacheKey = `${categorySlug}:${perPage}:${page}`;
  const cached = productListCache.get(cacheKey);
  if (cached && (Date.now() - cached.loadedAt) < PRODUCT_LIST_CACHE_TTL_MS) {
    logger.debug({ cacheKey }, '[WooCommerce] productListCache hit');
    // Retorna cópias rasas dos produtos — evita compartilhar mutações entre sessões
    return { ...cached.result, products: cached.result.products.map((p) => ({ ...p })) };
  }

  const categoryId = await getCategoryIdBySlug(categorySlug);
  if (!categoryId) {
    throw new Error(`Categoria "${categorySlug}" não encontrada no WooCommerce.`);
  }

  const response = await wooApi.get('/products', {
    params: {
      category: categoryId,
      per_page: perPage,
      page,
      status: 'publish',
      stock_status: 'instock',
      orderby: 'popularity',
      order: 'desc',
    },
  });

  // WooCommerce retorna metadados de paginação nos headers
  const total = parseInt(response.headers['x-wp-total'] || '0', 10);
  const totalPages = parseInt(response.headers['x-wp-totalpages'] || '1', 10);

  const products = deduplicateProducts(response.data.map(formatProduct));
  const result = { products, page, totalPages, total, hasMore: page < totalPages };

  productListCache.set(cacheKey, { result, loadedAt: Date.now() });
  logger.debug({ cacheKey, count: products.length }, '[WooCommerce] productListCache miss — stored');

  // Retorna cópias rasas para esta requisição
  return { ...result, products: result.products.map((p) => ({ ...p })) };
}

/**
 * Searches products by name or keyword, with pagination support.
 * Results cached for SEARCH_CACHE_TTL_MS (3 min) — reduz carga no WordPress.
 */
async function searchProducts(query, perPage = 20, page = 1) {
  const cacheKey = `search:${String(query).toLowerCase().trim()}:${perPage}:${page}`;
  const cached = searchCache.get(cacheKey);
  if (cached && (Date.now() - cached.loadedAt) < SEARCH_CACHE_TTL_MS) {
    logger.debug({ cacheKey }, '[WooCommerce] searchCache hit');
    return { ...cached.result, products: cached.result.products.map((p) => ({ ...p })) };
  }

  const response = await wooApi.get('/products', {
    params: {
      search: query,
      per_page: perPage,
      page,
      status: 'publish',
      stock_status: 'instock',
    },
  });

  const total = parseInt(response.headers['x-wp-total'] || '0', 10);
  const totalPages = parseInt(response.headers['x-wp-totalpages'] || '1', 10);
  const products = deduplicateProducts(response.data.map(formatProduct));
  const result = { products, page, totalPages, total, hasMore: page < totalPages };

  searchCache.set(cacheKey, { result, loadedAt: Date.now() });
  return { ...result, products: result.products.map((p) => ({ ...p })) };
}

/**
 * Searches published products without filtering by stock status.
 * Used only by the commercial catalog resolver to explain "exists, but is
 * unavailable now" without changing the legacy in-stock search behavior.
 */
async function searchProductsIncludingOutOfStock(query, perPage = 20, page = 1) {
  const cacheKey = `search-all-stock:${String(query).toLowerCase().trim()}:${perPage}:${page}`;
  const cached = searchCache.get(cacheKey);
  if (cached && (Date.now() - cached.loadedAt) < SEARCH_CACHE_TTL_MS) {
    logger.debug({ cacheKey }, '[WooCommerce] searchCache hit');
    return { ...cached.result, products: cached.result.products.map((p) => ({ ...p })) };
  }

  const response = await wooApi.get('/products', {
    params: {
      search: query,
      per_page: perPage,
      page,
      status: 'publish',
    },
  });

  const total = parseInt(response.headers['x-wp-total'] || '0', 10);
  const totalPages = parseInt(response.headers['x-wp-totalpages'] || '1', 10);
  const products = deduplicateProducts(response.data.map(formatProduct));
  const result = { products, page, totalPages, total, hasMore: page < totalPages };

  searchCache.set(cacheKey, { result, loadedAt: Date.now() });
  return { ...result, products: result.products.map((p) => ({ ...p })) };
}

/**
 * Searches published products within a WooCommerce date window.
 * Defaults to in-stock products, matching the storefront behavior.
 */
async function searchProductsByDate({
  query = '',
  after,
  before,
  perPage = 20,
  page = 1,
  includeOutOfStock = false,
  categorySlug = null,
} = {}) {
  const cacheKey = [
    'search-date',
    String(query).toLowerCase().trim(),
    after || '',
    before || '',
    perPage,
    page,
    includeOutOfStock ? 'all' : 'instock',
    categorySlug || '',
  ].join(':');
  const cached = searchCache.get(cacheKey);
  if (cached && (Date.now() - cached.loadedAt) < SEARCH_CACHE_TTL_MS) {
    logger.debug({ cacheKey }, '[WooCommerce] searchCache hit');
    return { ...cached.result, products: cached.result.products.map((p) => ({ ...p })) };
  }

  const params = {
    per_page: perPage,
    page,
    status: 'publish',
    orderby: 'date',
    order: 'desc',
  };
  if (query) params.search = query;
  if (after) params.after = after;
  if (before) params.before = before;
  if (!includeOutOfStock) params.stock_status = 'instock';
  if (categorySlug) {
    const categoryId = await getCategoryIdBySlug(categorySlug);
    if (categoryId) params.category = categoryId;
  }

  const response = await wooApi.get('/products', { params });

  const total = parseInt(response.headers['x-wp-total'] || '0', 10);
  const totalPages = parseInt(response.headers['x-wp-totalpages'] || '1', 10);
  const products = deduplicateProducts(response.data.map(formatProduct));
  const result = { products, page, totalPages, total, hasMore: page < totalPages };

  searchCache.set(cacheKey, { result, loadedAt: Date.now() });
  return { ...result, products: result.products.map((p) => ({ ...p })) };
}

/**
 * Fetches a single product by WooCommerce ID.
 */
async function getProductById(productId) {
  if (!productId) return null;

  const { data: product } = await wooApi.get(`/products/${productId}`);
  if (!product || product.status !== 'publish' || product.stock_status !== 'instock') {
    return null;
  }

  return formatProduct(product);
}

/**
 * Extracts size variations from a product's attributes.
 */
function extractSizes(product) {
  const sizeAttr = product.attributes.find(
    (attr) => attr.name.toLowerCase() === 'tamanho' || attr.name.toLowerCase() === 'size'
  );

  if (!sizeAttr) return [];

  const sizes = sizeAttr.options.filter(s => s && String(s).trim());
  if (sizeAttr.options.length > 0 && sizes.length === 0) {
    logger.warn({ productId: product.id, productName: product.name }, '[WooCommerce] Atributo Tamanho existe mas todas as opções estão vazias — tratando como sem variação');
  }
  return sizes;
}

/**
 * Extracts secondary (non-size) variation attributes from a product.
 * Example: [{ name: 'Categoria', options: ['Mãe', 'Filha'] }]
 * Used to detect products that require a second selection step (e.g. Mãe/Filha).
 */
function extractSecondaryAttributes(product) {
  if (!Array.isArray(product.attributes)) return [];
  return product.attributes
    .filter((attr) => {
      const name = String(attr.name || '').toLowerCase();
      return name !== 'tamanho' && name !== 'size' && Array.isArray(attr.options) && attr.options.length > 1;
    })
    .map((attr) => ({ name: attr.name, options: attr.options.filter(Boolean) }));
}

// Sinônimos reconhecidos de "tamanho único" → normaliza para 'ÚNICO'
const UNIQUE_SIZE_SYNONYMS = new Set([
  'U', 'UN', 'UNI', 'UNICO', 'ÚNICO',
  'TU', 'TAMUNICO', 'TAM UNICO', 'TAM ÚNICO',
  'UNIVERSAL',
]);

/**
 * Normalizes a size label to uppercase canonical form.
 * Any synonym for "tamanho único" is collapsed to 'ÚNICO' for comparisons.
 * Display to the user should use the original WooCommerce label.
 */
function normalizeSizeLabel(value) {
  const raw = String(value || '').trim().toUpperCase();
  // "Tam único - pct com 5 unidades" → 'ÚNICO'
  if (
    raw.startsWith('TAM ÚNICO') || raw.startsWith('TAM UNICO') ||
    raw.startsWith('ÚNICO') || raw.startsWith('UNICO')
  ) {
    return 'ÚNICO';
  }
  if (UNIQUE_SIZE_SYNONYMS.has(raw)) return 'ÚNICO';
  return raw;
}

function buildDefaultSizeDetails(product) {
  return (product.sizes || []).map((size) => ({
    size,
    stockQuantity: null,
    isAvailable: true,
    stockLabel: 'Disponível',
  }));
}

function extractVariationSize(variation) {
  const attrs = Array.isArray(variation?.attributes) ? variation.attributes : [];
  const sizeAttr = attrs.find((attr) => {
    const name = String(attr?.name || '').toLowerCase();
    return name === 'tamanho' || name === 'size';
  });

  return sizeAttr?.option || null;
}

function parseStockQuantity(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {object} product
 * @param {Array} variations - raw WooCommerce variations
 * @param {{ name: string, value: string } | null} variantFilter - when set, only considers
 *   variations that match this secondary attribute (e.g. { name: 'Categoria', value: 'Mãe' }).
 */
function buildSizeDetailsFromVariations(product, variations, variantFilter = null) {
  const bySize = new Map();

  // Filter variations by secondary attribute when a variant is selected
  const filteredVariations = variantFilter
    ? variations.filter((v) =>
        Array.isArray(v.attributes) && v.attributes.some(
          (a) =>
            String(a.name || '').toLowerCase() === String(variantFilter.name || '').toLowerCase() &&
            String(a.option || '').toLowerCase() === String(variantFilter.value || '').toLowerCase()
        )
      )
    : variations;

  for (const variation of filteredVariations) {
    const size = extractVariationSize(variation);
    if (!size) continue;

    const key = normalizeSizeLabel(size);
    const current = bySize.get(key) || {
      size,
      stockQuantity: 0,
      hasKnownStock: true,
      isAvailable: false,
    };

    const qty = parseStockQuantity(variation.stock_quantity);
    const hasKnownStock = Boolean(variation.manage_stock) && qty !== null;
    const isAvailable = variation.stock_status === 'instock' || (qty !== null && qty > 0);

    current.size = current.size || size;
    current.isAvailable = current.isAvailable || isAvailable;

    if (hasKnownStock) {
      current.stockQuantity += Math.max(qty, 0);
    } else {
      current.hasKnownStock = false;
    }

    bySize.set(key, current);
  }

  return (product.sizes || []).map((size) => {
    const found = bySize.get(normalizeSizeLabel(size));

    if (!found) {
      // Tamanho existe no atributo do produto mas não tem variação publicada — não disponível
      return {
        size,
        stockQuantity: null,
        isAvailable: false,
        stockLabel: 'Indisponível',
      };
    }

    if (!found.isAvailable) {
      return {
        size,
        stockQuantity: found.hasKnownStock ? 0 : null,
        isAvailable: false,
        stockLabel: 'Indisponível',
      };
    }

    if (found.hasKnownStock) {
      return {
        size,
        stockQuantity: found.stockQuantity,
        isAvailable: found.stockQuantity > 0,
        stockLabel: `Disponível: ${found.stockQuantity}`,
      };
    }

    return {
      size,
      stockQuantity: null,
      isAvailable: true,
      stockLabel: 'Disponível',
    };
  });
}

async function getProductVariations(productId) {
  if (!productId) return [];

  const { data: variations } = await wooApi.get(`/products/${productId}/variations`, {
    params: {
      per_page: 100,
      status: 'publish',
    },
  });

  return Array.isArray(variations) ? variations : [];
}

/**
 * Enriches a product with stock data from WooCommerce variations.
 * @param {object} product
 * @param {{ name: string, value: string } | null} variantFilter - when set, only considers
 *   variations matching this secondary attribute (e.g. { name: 'Categoria', value: 'Mãe' }).
 *   Raw variations are cached per productId; the filter is applied at computation time.
 */
async function enrichProductWithStock(product, variantFilter = null) {
  if (!product?.id || !Array.isArray(product.sizes) || product.sizes.length === 0) {
    return product;
  }

  const cacheKey = String(product.id);
  const cached = variationCache.get(cacheKey);

  let rawVariations;
  if (cached && (Date.now() - cached.loadedAt) < VARIATION_CACHE_TTL_MS) {
    rawVariations = cached.rawVariations;
  } else {
    rawVariations = [];
    try {
      rawVariations = await getProductVariations(product.id);
    } catch (err) {
      logger.warn({ productId: product.id, err: err?.message || String(err) }, '[WooCommerce] Falha ao carregar estoque por tamanho');
    }
    variationCache.set(cacheKey, { loadedAt: Date.now(), rawVariations });
  }

  const sizeDetails = rawVariations.length > 0
    ? buildSizeDetailsFromVariations(product, rawVariations, variantFilter)
    : buildDefaultSizeDetails(product);

  product.sizeDetails = sizeDetails;

  // Compute per-variant sizes (ex: { Mãe: ['M','EXGG'], Filha: ['M','G','GG'] })
  // Only when raw variations are available and product has secondary attributes
  if (rawVariations.length > 0 && product.secondaryAttributes?.length > 0) {
    const secAttr = product.secondaryAttributes[0];
    const variantSizes       = {};
    const variantPrices      = {};
    const variantSizeDetails = {};
    for (const opt of secAttr.options) {
      const filtered = rawVariations.filter((v) =>
        Array.isArray(v.attributes) && v.attributes.some(
          (a) =>
            String(a.name || '').toLowerCase() === String(secAttr.name || '').toLowerCase() &&
            String(a.option || '').toLowerCase() === String(opt || '').toLowerCase()
        )
      );
      const sizes = [...new Set(
        filtered
          .filter((v) => {
            const qty = parseStockQuantity(v.stock_quantity);
            return v.stock_status === 'instock' || (qty !== null && qty > 0);
          })
          .map(extractVariationSize)
          .filter(Boolean)
      )];
      if (sizes.length > 0) variantSizes[opt] = sizes;

      // Preço da variante: usa o primeiro resultado com preço definido
      const withPrice = filtered.find(v => v.regular_price || v.price);
      if (withPrice) {
        const regular = parseFloat(withPrice.regular_price || withPrice.price || '0');
        const sale    = parseFloat(withPrice.sale_price || withPrice.regular_price || withPrice.price || '0');
        variantPrices[opt] = { price: regular, salePrice: sale > 0 ? sale : regular };
      }

      // Estoque por tamanho dentro desta variante (para exibição no card)
      const bySize = new Map();
      for (const v of filtered) {
        const size = extractVariationSize(v);
        if (!size) continue;
        const qty = parseStockQuantity(v.stock_quantity);
        const hasKnownStock = Boolean(v.manage_stock) && qty !== null;
        const isAvail = v.stock_status === 'instock' || (qty !== null && qty > 0);
        const existing = bySize.get(size);
        const cur = existing || { size, stockQuantity: 0, hasKnownStock: true, isAvailable: false };
        cur.isAvailable = cur.isAvailable || isAvail;
        if (existing) {
          // Segunda variação para o mesmo (variante, tamanho): soma pode ser irreal (ex: cores diferentes).
          // Invalida a exibição de quantidade para evitar estoque falso.
          cur.hasKnownStock = false;
        } else if (hasKnownStock) {
          cur.stockQuantity = Math.max(qty, 0);
        } else {
          cur.hasKnownStock = false;
        }
        bySize.set(size, cur);
      }
      const details = [...bySize.values()]
        .filter((d) => d.isAvailable)
        .map((d) => ({ size: d.size, stockQuantity: d.hasKnownStock ? d.stockQuantity : null }));
      if (details.length > 0) variantSizeDetails[opt] = details;
    }
    if (Object.keys(variantSizes).length       > 0) product.variantSizes       = variantSizes;
    if (Object.keys(variantPrices).length      > 0) product.variantPrices      = variantPrices;
    if (Object.keys(variantSizeDetails).length > 0) product.variantSizeDetails = variantSizeDetails;
  }

  return product;
}

/**
 * Deduplicates products by ID only.
 * Produtos com nomes idênticos mas IDs diferentes são variações distintas e devem ser preservados.
 */
function deduplicateProducts(products) {
  const seen = new Set();
  return products.filter((product) => {
    if (!product.id || seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  });
}

/**
 * Formats a raw WooCommerce product into a simplified object.
 */
function formatProduct(product) {
  const shortDesc = product.short_description
    ? product.short_description.replace(/<[^>]+>/g, '').trim()
    : '';

  return {
    id: product.id,
    name: product.name,
    type: product.type,
    price: product.price,
    regularPrice: product.regular_price,
    salePrice: product.sale_price,
    stockStatus: product.stock_status,
    stockQuantity: parseStockQuantity(product.stock_quantity),
    dateCreated: product.date_created || product.date_created_gmt || null,
    dateModified: product.date_modified || product.date_modified_gmt || null,
    imageUrl: product.images.length > 0 ? product.images[0].src : null,
    images: product.images.map((img) => img.src), // ✅ todas as fotos preservadas
    sizes: extractSizes(product),
    sizeDetails: buildDefaultSizeDetails({ sizes: extractSizes(product) }),
    secondaryAttributes: extractSecondaryAttributes(product),
    permalink: product.permalink,
    description: shortDesc,
  };
}

/**
 * Formats price in BRL currency.
 */
function formatPrice(price) {
  const num = parseFloat(price);
  if (isNaN(num)) {
    logger.warn({ price }, '[WooCommerce] formatPrice recebeu valor não-numérico');
    return 'Preço indisponível';
  }
  return `R$ ${num.toFixed(2).replace('.', ',')}`;
}

/**
 * Builds the caption string for a product image message.
 */
function buildCaption(product, productNumber = null) {
  let caption = productNumber
    ? `✨ *${productNumber}. ${product.name}*\n`
    : `✨ *${product.name}*\n`;

  if (product.salePrice && product.salePrice !== product.regularPrice) {
    caption += `~${formatPrice(product.regularPrice)}~\n`;
    caption += `💰 *${formatPrice(product.salePrice)}*\n`;
  } else {
    caption += `💰 *${formatPrice(product.price)}*\n`;
  }

  if (product.variantSizes && Object.keys(product.variantSizes).length > 0) {
    const lines = Object.entries(product.variantSizes)
      .filter(([, sizes]) => sizes.length > 0)
      .map(([variant, sizes]) => `📏 ${variant}: ${sizes.join(' | ')}`);
    caption += lines.join('\n');
  } else if (product.secondaryAttributes?.length > 0) {
    const opts = product.secondaryAttributes[0].options.join(' | ');
    caption += `📏 *${opts}*`;
  } else if (Array.isArray(product.sizeDetails) && product.sizeDetails.some((detail) => detail.isAvailable)) {
    const availableSizes = product.sizeDetails
      .filter((detail) => detail.isAvailable)
      .map((detail) => detail.size);
    if (availableSizes.length > 0) {
      caption += `📏 Disponível: ${availableSizes.join(' | ')}`;
    }
  } else if (product.sizes.length > 0) {
    caption += `📏 Disponível: ${product.sizes.join(' | ')}`;
  }

  if (product.description) {
    const desc = product.description.substring(0, 80);
    caption += `\n\n_${desc}${product.description.length > 80 ? '...' : ''}_`;
  }

  return caption;
}

/**
 * Builds the catalog context for the AI, including photo counts and pagination.
 */
function buildCatalogContext(session) {
  if (!session.products || session.products.length === 0) return null;

  let ctx = `CATEGORIA ATIVA: ${session.activeCategory || session.currentCategory || 'não definida'}\n`;
  ctx += `PÁGINA: ${session.currentPage || 1} de ${session.totalPages || 1}\n\n`;

  session.products.forEach((p, i) => {
    const photoCount = p.images ? p.images.length : (p.imageUrl ? 1 : 0);
    const priceDisplay = p.salePrice && p.salePrice !== p.regularPrice
      ? `R$ ${p.salePrice} (era R$ ${p.regularPrice})`
      : `R$ ${p.price}`;
    ctx += `${i + 1}. ${p.name} — ${priceDisplay} — Tamanhos: ${p.sizes.join(', ')} — Fotos disponíveis: ${photoCount}\n`;
  });

  if (session.currentPage < session.totalPages) {
    const remaining = (session.totalPages - session.currentPage) * 10;
    ctx += `\n⚠️ Há mais ~${remaining} produtos não mostrados. Use [PROXIMOS] para avançar.\n`;
  } else {
    ctx += `\n✅ Todos os produtos desta categoria já foram mostrados.\n`;
  }

  return ctx;
}

/**
 * Pré-aquece o cache de produtos para as categorias principais.
 * Deve ser chamado no startup do servidor (fire-and-forget).
 * Se WooCommerce estiver lento/offline, apenas loga um aviso — não bloqueia o startup.
 */
async function warmupCache() {
  const CATS = [
    'lancamento-da-semana',
    'feminino',
    'femininoinfantil',
    'masculino',
    'masculinoinfantil',
  ];

  logger.info('[WooCommerce] Iniciando warmup de cache de produtos...');

  for (const slug of CATS) {
    try {
      await getProductsByCategory(slug, 100, 1);
      logger.info({ slug }, '[WooCommerce] warmup OK');
    } catch (err) {
      logger.warn({ slug, err: err.message }, '[WooCommerce] warmup falhou para categoria — será tentado na primeira requisição');
    }
    // Pausa entre categorias para não sobrecarregar WordPress
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  logger.info('[WooCommerce] Warmup de cache concluído.');
}

module.exports = {
  enrichProductWithStock,
  getProductsByCategory,
  getProductById,
  searchProducts,
  searchProductsIncludingOutOfStock,
  searchProductsByDate,
  formatPrice,
  buildCaption,
  buildCatalogContext,
  warmupCache,
};
