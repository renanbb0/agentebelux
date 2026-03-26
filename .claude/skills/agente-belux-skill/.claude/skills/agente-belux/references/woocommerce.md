# WooCommerce — Referência Completa

> WooCommerce REST API v3 · Catálogo de produtos da Belux Moda Íntima

---

## Sumário

1. [Configuração](#configuração)
2. [Cliente HTTP](#cliente-http)
3. [Categorias](#categorias)
4. [Produtos](#produtos)
5. [Busca Livre](#busca-livre)
6. [Formatação](#formatação)
7. [Funções Exportadas](#funções-exportadas)
8. [Endpoints WooCommerce REST](#endpoints-woocommerce-rest)
9. [Estrutura de Produto](#estrutura-de-produto)

---

## Configuração

### Variáveis de Ambiente

```env
WC_BASE_URL=https://belux.com.br/wp-json/wc/v3
WC_CONSUMER_KEY=ck_xxxxx
WC_CONSUMER_SECRET=cs_xxxxx
```

### Autenticação

A API usa **Basic Auth** com consumer key/secret:

```javascript
const wooApi = axios.create({
  baseURL: WC_BASE_URL,
  auth: {
    username: WC_CONSUMER_KEY,
    password: WC_CONSUMER_SECRET,
  },
  timeout: 15000,
});
```

---

## Categorias

### Cache de IDs

IDs de categoria são cacheados em memória para evitar chamadas redundantes à API:

```javascript
const categoryCache = {};

async function getCategoryIdBySlug(slug) {
  if (categoryCache[slug]) return categoryCache[slug];
  // ... busca na API e armazena no cache
}
```

### Mapa de Categorias

```javascript
const CATEGORY_MAP = {
  feminino: 'feminino',
  masculino: 'masculino',
  infantil: 'infantil',
};
```

**⚠️ Os slugs devem corresponder exatamente às categorias cadastradas no WooCommerce.**

---

## Produtos

### Buscar Produtos por Categoria

```javascript
async function getProductsByCategory(categorySlug, perPage = 10) {
  const categoryId = await getCategoryIdBySlug(categorySlug); // usa cache

  const { data: products } = await wooApi.get('/products', {
    params: {
      category: categoryId,
      per_page: perPage,
      status: 'publish',
      stock_status: 'instock',
      orderby: 'popularity',  // mais vendidos primeiro
      order: 'desc',
    },
  });

  return products.map(formatProduct);
}
```

### Extrair Tamanhos

```javascript
function extractSizes(product) {
  const sizeAttr = product.attributes.find(
    (attr) => attr.name.toLowerCase() === 'tamanho'
           || attr.name.toLowerCase() === 'size'
  );
  return sizeAttr ? sizeAttr.options : [];
}
```

**Retorna:** `["P", "M", "G", "GG"]` ou `[]`

### Formatar Produto (simplificado)

```javascript
function formatProduct(product) {
  return {
    id: product.id,
    name: product.name,
    price: product.price,
    regularPrice: product.regular_price,
    salePrice: product.sale_price,
    imageUrl: product.images.length > 0 ? product.images[0].src : null,
    sizes: extractSizes(product),
    permalink: product.permalink,
    description: product.short_description.replace(/<[^>]+>/g, '').trim(),
  };
}
```

---

## Busca Livre

```javascript
async function searchProducts(query, perPage = 10) {
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
```

Acionado pelo token `[BUSCAR:termo]` quando o cliente descreve um produto específico em vez de navegar por categoria.

---

## Formatação

### Preço em BRL

```javascript
function formatPrice(price) {
  const num = parseFloat(price);
  if (isNaN(num)) return 'Preço indisponível';
  return `R$ ${num.toFixed(2).replace('.', ',')}`;
}
// Exemplo: formatPrice(49.9) → "R$ 49,90"
```

### Caption de Imagem

Inclui nome, preço (com destaque para promoção) e tamanhos. Se o produto tiver `description`, exibe até 80 caracteres:

```javascript
function buildCaption(product) {
  let caption = `✨ *${product.name}*\n`;

  if (product.salePrice && product.salePrice !== product.regularPrice) {
    caption += `~${formatPrice(product.regularPrice)}~\n`;  // Tachado
    caption += `💰 *${formatPrice(product.salePrice)}*\n`;  // Preço promo
  } else {
    caption += `💰 *${formatPrice(product.price)}*\n`;
  }

  if (product.sizes.length > 0) {
    caption += `📏 Tamanhos: ${product.sizes.join(' | ')}`;
  }

  if (product.description) {
    caption += `\n\n_${product.description.substring(0, 80)}..._`;
  }

  return caption;
}
```

---

## Funções Exportadas

| Função | Parâmetros | Retorno | Uso |
|---|---|---|---|
| `getProductsByCategory` | `(slug, perPage=10)` | `Product[]` | Busca produtos por categoria |
| `searchProducts` | `(query, perPage=10)` | `Product[]` | Busca por texto livre |
| `getCategoryIdBySlug` | `(slug)` | `number\|null` | Resolve slug → ID (com cache) |
| `extractSizes` | `(rawProduct)` | `string[]` | Extrai tamanhos do atributo |
| `formatProduct` | `(rawProduct)` | `Product` | Simplifica objeto do WC |
| `formatPrice` | `(price)` | `string` | Formata preço em BRL |
| `buildCaption` | `(product)` | `string` | Monta legenda p/ imagem |
| `CATEGORY_MAP` | — | `object` | Mapa slug → slug |

---

## Endpoints WooCommerce REST (referência expandida)

### Produtos

| Endpoint | Método | Uso |
|---|---|---|
| `/products` | GET | Listar/filtrar/buscar produtos |
| `/products/{id}` | GET | Produto por ID |

**Parâmetros de busca úteis:**

| Param | Tipo | Descrição |
|---|---|---|
| `category` | int | Filtrar por ID de categoria |
| `search` | string | Busca por termo (nome, descrição) |
| `per_page` | int | Produtos por página (max 100) |
| `page` | int | Página atual |
| `status` | string | `publish`, `draft`, `pending` |
| `stock_status` | string | `instock`, `outofstock` |
| `orderby` | string | `date`, `price`, `popularity` |
| `order` | string | `asc`, `desc` |
| `min_price` | string | Preço mínimo |
| `max_price` | string | Preço máximo |

### Categorias

| Endpoint | Método | Uso |
|---|---|---|
| `/products/categories` | GET | Listar categorias |
| `/products/categories/{id}` | GET | Categoria por ID |

---

## Estrutura de Produto (raw WooCommerce)

```json
{
  "id": 123,
  "name": "Calcinha Renda Floral",
  "status": "publish",
  "price": "39.90",
  "regular_price": "49.90",
  "sale_price": "39.90",
  "stock_status": "instock",
  "short_description": "<p>Calcinha delicada em renda...</p>",
  "attributes": [
    { "name": "Tamanho", "options": ["P", "M", "G", "GG"] }
  ],
  "categories": [{ "id": 10, "name": "Feminino", "slug": "feminino" }],
  "images": [{ "src": "https://belux.com.br/wp-content/uploads/foto.jpg" }],
  "permalink": "https://belux.com.br/produto/calcinha-renda-floral/"
}
```

### Estrutura Simplificada (após `formatProduct`)

```json
{
  "id": 123,
  "name": "Calcinha Renda Floral",
  "price": "39.90",
  "regularPrice": "49.90",
  "salePrice": "39.90",
  "imageUrl": "https://belux.com.br/wp-content/uploads/foto.jpg",
  "sizes": ["P", "M", "G", "GG"],
  "permalink": "https://belux.com.br/produto/calcinha-renda-floral/",
  "description": "Calcinha delicada em renda..."
}
```
