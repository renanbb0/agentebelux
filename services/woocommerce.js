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

  return {
    products: response.data.map(formatProduct),
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

  return products.map(formatProduct);
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
    price: product.price,
    regularPrice: product.regular_price,
    salePrice: product.sale_price,
    imageUrl: product.images.length > 0 ? product.images[0].src : null,
    images: product.images.map((img) => img.src), // ✅ todas as fotos preservadas
    sizes: extractSizes(product),
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
  getProductsByCategory,
  searchProducts,
  formatPrice,
  buildCaption,
  buildCatalogContext,
};
