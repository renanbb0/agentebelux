const axios = require('axios');

const WC_BASE_URL = process.env.WC_BASE_URL;
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;

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

// In-memory cache for full product lists per category — TTL: 5 minutes
const productCache = {};
const PRODUCT_CACHE_TTL_MS = 5 * 60 * 1000;

const CATEGORY_MAP = {
  feminino: 'feminino',
  masculino: 'masculino',
  infantil: 'infantil',
};

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
 * Fetches ALL published, in-stock products for a category, paginating through
 * the WooCommerce API (max 100/page). Results are cached per category for 5 minutes.
 * Products are ordered by popularity (most sold first).
 * @param {string} categorySlug - Category slug (feminino, masculino, infantil)
 * @returns {Promise<Array>} Full array of simplified product objects
 */
async function getAllProductsByCategory(categorySlug) {
  const cached = productCache[categorySlug];
  if (cached && Date.now() - cached.ts < PRODUCT_CACHE_TTL_MS) {
    return cached.products;
  }

  const categoryId = await getCategoryIdBySlug(categorySlug);
  if (!categoryId) {
    throw new Error(`Categoria "${categorySlug}" não encontrada no WooCommerce.`);
  }

  const allProducts = [];
  let page = 1;

  while (true) {
    const { data: batch } = await wooApi.get('/products', {
      params: {
        category: categoryId,
        per_page: 100,
        page,
        status: 'publish',
        stock_status: 'instock',
        orderby: 'popularity',
        order: 'desc',
      },
    });

    allProducts.push(...batch.map(formatProduct));
    if (batch.length < 100) break;
    page++;
  }

  productCache[categorySlug] = { products: allProducts, ts: Date.now() };
  console.log(`[WooCommerce] Categoria "${categorySlug}": ${allProducts.length} produto(s) carregados.`);
  return allProducts;
}

/**
 * @deprecated Use getAllProductsByCategory instead.
 */
async function getProductsByCategory(categorySlug, perPage = 20) {
  return getAllProductsByCategory(categorySlug);
}

/**
 * Searches products by name or keyword.
 * @param {string} query - Search term
 * @param {number} perPage - Number of results (default: 10)
 * @returns {Promise<Array>} Array of simplified product objects
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

  return products.map(formatProduct);
}

/**
 * Extracts size variations from a product's attributes.
 * Looks for attribute named "Tamanho" or "size" (case-insensitive).
 * @param {object} product - Raw WooCommerce product object
 * @returns {string[]} Array of size labels (e.g., ["P", "M", "G", "GG"])
 */
function extractSizes(product) {
  const sizeAttr = product.attributes.find(
    (attr) => attr.name.toLowerCase() === 'tamanho' || attr.name.toLowerCase() === 'size'
  );

  return sizeAttr ? sizeAttr.options : [];
}

/**
 * Formats a raw WooCommerce product into a simplified object
 * with only the fields needed by the bot.
 * @param {object} product - Raw WooCommerce product
 * @returns {object} Simplified product
 */
function formatProduct(product) {
  const shortDesc = product.short_description
    ? product.short_description.replace(/<[^>]+>/g, '').trim()
    : '';

  return {
    id: product.id,
    name: product.name,
    price: product.price,
    regularPrice: product.regular_price,
    salePrice: product.sale_price,
    imageUrl: product.images.length > 0 ? product.images[0].src : null,
    sizes: extractSizes(product),
    permalink: product.permalink,
    description: shortDesc,
  };
}

/**
 * Formats price in BRL currency.
 * @param {string|number} price
 * @returns {string} Formatted price (e.g., "R$ 49,90")
 */
function formatPrice(price) {
  const num = parseFloat(price);
  if (isNaN(num)) return 'Preço indisponível';
  return `R$ ${num.toFixed(2).replace('.', ',')}`;
}

/**
 * Builds the caption string for a product image message.
 * @param {object} product - Simplified product object from formatProduct
 * @returns {string} Caption text
 */
function buildCaption(product) {
  let caption = `✨ *${product.name}*\n`;

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

module.exports = {
  getAllProductsByCategory,
  getProductsByCategory,
  searchProducts,
  getCategoryIdBySlug,
  extractSizes,
  formatProduct,
  formatPrice,
  buildCaption,
  CATEGORY_MAP,
};
