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
  timeout: 15000,
});

// In-memory cache for category IDs — avoids repeated lookups on each request
const categoryCache = {};
const variationCache = new Map();
const VARIATION_CACHE_TTL_MS = 2 * 60 * 1000;

/**
 * Looks up a WooCommerce category ID by slug, with in-memory caching.
 * @param {string} slug - Category slug
 * @returns {Promise<number|null>} Category ID or null
 */
async function getCategoryIdBySlug(slug) {
  if (categoryCache[slug]) return categoryCache[slug];

  const { data: categories } = await wooApi.get('/products/categories', {
    params: { slug, per_page: 1 },
  });

  const id = categories.length > 0 ? categories[0].id : null;
  if (id) categoryCache[slug] = id;
  return id;
}

/**
 * Fetches products for a category with pagination.
 * Returns metadata for pagination control.
 */
async function getProductsByCategory(categorySlug, perPage = 10, page = 1) {
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

  return {
    products,
    page,
    totalPages,
    total,
    hasMore: page < totalPages,
  };
}

/**
 * Searches products by name or keyword.
 */
async function searchProducts(query, perPage = 20) {
  const { data: products } = await wooApi.get('/products', {
    params: {
      search: query,
      per_page: perPage,
      status: 'publish',
      stock_status: 'instock',
    },
  });

  return deduplicateProducts(products.map(formatProduct));
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

  return sizeAttr ? sizeAttr.options : [];
}

function normalizeSizeLabel(value) {
  return String(value || '').trim().toUpperCase();
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

function buildSizeDetailsFromVariations(product, variations) {
  const bySize = new Map();

  for (const variation of variations) {
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
      return {
        size,
        stockQuantity: null,
        isAvailable: true,
        stockLabel: 'Disponível',
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

async function enrichProductWithStock(product) {
  if (!product?.id || !Array.isArray(product.sizes) || product.sizes.length === 0) {
    return product;
  }

  const cacheKey = String(product.id);
  const cached = variationCache.get(cacheKey);
  if (cached && (Date.now() - cached.loadedAt) < VARIATION_CACHE_TTL_MS) {
    product.sizeDetails = cached.sizeDetails.map((detail) => ({ ...detail }));
    return product;
  }

  let sizeDetails = buildDefaultSizeDetails(product);

  try {
    const variations = await getProductVariations(product.id);
    if (variations.length > 0) {
      sizeDetails = buildSizeDetailsFromVariations(product, variations);
    }
  } catch (err) {
    logger.warn({ productId: product.id, err: err?.message || String(err) }, '[WooCommerce] Falha ao carregar estoque por tamanho');
  }

  product.sizeDetails = sizeDetails;
  variationCache.set(cacheKey, {
    loadedAt: Date.now(),
    sizeDetails: sizeDetails.map((detail) => ({ ...detail })),
  });

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
    imageUrl: product.images.length > 0 ? product.images[0].src : null,
    images: product.images.map((img) => img.src), // ✅ todas as fotos preservadas
    sizes: extractSizes(product),
    sizeDetails: buildDefaultSizeDetails({ sizes: extractSizes(product) }),
    permalink: product.permalink,
    description: shortDesc,
  };
}

/**
 * Formats price in BRL currency.
 */
function formatPrice(price) {
  const num = parseFloat(price);
  if (isNaN(num)) return 'Preço indisponível';
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

  if (product.sizes.length > 0) {
    caption += `📏 Tamanhos: ${product.sizes.join(' | ')}`;
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

module.exports = {
  enrichProductWithStock,
  getProductsByCategory,
  getProductById,
  searchProducts,
  formatPrice,
  buildCaption,
  buildCatalogContext,
};
