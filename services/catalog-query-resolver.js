function stripAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeText(value) {
  return stripAccents(value)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\bvcs?\b/g, ' voce ')
    .replace(/\bq\b/g, ' que ')
    .replace(/\btam\b/g, ' tamanho ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CATEGORY_PATTERNS = [
  { slug: 'femininoinfantil', patterns: [/\bfeminino infantil\b/, /\bmenina(s)?\b/, /\binfantil menina\b/] },
  { slug: 'masculinoinfantil', patterns: [/\bmasculino infantil\b/, /\bmenino(s)?\b/, /\binfantil menino\b/] },
  { slug: 'feminino', patterns: [/\bfeminino\b/, /\blingerie\b/, /\bcalcinha\b/, /\bsutia\b/] },
  { slug: 'masculino', patterns: [/\bmasculino\b/, /\bcueca\b/, /\bboxer\b/, /\bsamba cancao\b/] },
  { slug: 'infantil', patterns: [/\binfantil\b/, /\bcrianca(s)?\b/, /\bkids?\b/] },
];

const KNOWN_THEMES = [
  'homem aranha',
  'spider man',
  'sonic',
  'stitch',
  'hello kitty',
  'mickey',
  'minnie',
  'barbie',
  'frozen',
  'elsa',
  'moana',
  'minecraft',
  'batman',
  'pokemon',
  'naruto',
  'snoopy',
  'unicornio',
  'dinossauro',
];

const PRODUCT_PATTERNS = [
  { value: 'pijama longo', patterns: [/\bpijamas?\s+long[oa]s?\b/, /\blong[oa]s?\b/] },
  { value: 'pijama curto', patterns: [/\bpijamas?\s+curt[oa]s?\b/, /\bcurt[oa]s?\b/] },
  { value: 'pijama', patterns: [/\bpijamas?\b/] },
  { value: 'conjunto', patterns: [/\bconjuntos?\b/] },
  { value: 'calcinha', patterns: [/\bcalcinhas?\b/] },
  { value: 'cueca', patterns: [/\bcuecas?\b/, /\bboxer\b/] },
  { value: 'sutia', patterns: [/\bsutias?\b/] },
  { value: 'camisola', patterns: [/\bcamisolas?\b/] },
];

function matchAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function detectCategory(normalizedText) {
  const found = CATEGORY_PATTERNS.find((entry) => matchAny(normalizedText, entry.patterns));
  return found?.slug || null;
}

function detectProductType(normalizedText) {
  const found = PRODUCT_PATTERNS.find((entry) => matchAny(normalizedText, entry.patterns));
  return found?.value || null;
}

function detectReference(normalizedText) {
  const explicit = normalizedText.match(/\b(?:ref|referencia|codigo|cod)\s*[:#-]?\s*([a-z0-9-]{2,})\b/i);
  if (explicit) return explicit[1].toUpperCase();

  const compact = normalizedText.match(/\b\d{2,}[a-z]{1,4}\b/i);
  if (compact) return compact[0].toUpperCase();

  return null;
}

function cleanThemeCandidate(value) {
  return String(value || '')
    .replace(/\b(que|voce|voces|tem|ai|aqui|disponivel|em estoque|estoque|modelo|pijama|camiseta)\b/g, ' ')
    .replace(/[?!.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectTheme(normalizedText) {
  const known = KNOWN_THEMES.find((theme) => normalizedText.includes(theme));
  if (known) return known;

  const stampMatch = normalizedText.match(/\bestampa(?:\s+(?:do|da|de))?\s+([a-z0-9 ]{3,50})/);
  if (stampMatch) {
    const candidate = cleanThemeCandidate(stampMatch[1]);
    if (candidate) return candidate;
  }

  return null;
}

function detectRecency(normalizedText) {
  if (/\b(ontem|de ontem|lancad[oa]s?\s+ontem|chegou\s+ontem|novidade(s)?\s+de\s+ontem)\b/.test(normalizedText)) {
    return { type: 'yesterday', label: 'ontem' };
  }
  return null;
}

function buildQuery({ reference, theme, productType, categorySlug, normalizedText }) {
  if (reference) return reference;
  if (theme) return theme;
  if (productType) return productType;
  if (categorySlug) return categorySlug;

  const cleaned = normalizedText
    .replace(/\b(boa tarde|bom dia|boa noite|oi|ola|por favor|pfv|me|manda|mostra|quero|ver|tem|tera|teria|vai|repor|reposicao|voltar|chegar|de novo|ainda|disponivel|estoque|lancad[oa]s?|novidade(s)?|ontem|de|do|da|os|as|o|a|um|uma|uns|umas|aquele|aquela|essa|esse)\b/g, ' ')
    .replace(/[?!.,]/g, ' ')
    .replace(/\bpijamas\b/g, 'pijama')
    .replace(/\blongos\b/g, 'longo')
    .replace(/\scurtos\b/g, ' curto')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned;
}

function resolveCatalogQuery(text) {
  const rawText = String(text || '');
  const normalizedText = normalizeText(rawText);
  if (!normalizedText) {
    return { shouldHandle: false, rawText, normalizedText, query: '' };
  }

  const reference = detectReference(normalizedText);
  const categorySlug = detectCategory(normalizedText);
  const productType = detectProductType(normalizedText);
  const theme = detectTheme(normalizedText);
  const recency = detectRecency(normalizedText);
  const isRestockQuestion = /\b(repor|reposicao|vai voltar|volta|chegar de novo|vem de novo)\b/.test(normalizedText);
  const isStockQuestion = isRestockQuestion || /\b(tem|tera|teria|disponivel|estoque|ainda tem|chegou)\b/.test(normalizedText);

  const query = buildQuery({ reference, theme, productType, categorySlug, normalizedText });
  const intentType = reference
    ? 'reference'
    : theme
      ? 'theme'
      : productType
        ? 'product'
        : categorySlug
          ? 'category'
          : query
            ? 'product'
            : 'unknown';

  const shouldHandle = Boolean(reference || theme || productType || categorySlug || recency || isRestockQuestion);

  return {
    shouldHandle,
    rawText,
    normalizedText,
    intentType,
    reference,
    theme,
    productType,
    categorySlug,
    recency,
    isRestockQuestion,
    isStockQuestion,
    query,
  };
}

function shouldUseCatalogResolver({ text, session = {}, semanticQuick = {}, env = process.env } = {}) {
  if (String(env.CATALOG_RESOLVER_ENABLED || '').toLowerCase() === 'false') return false;

  const state = session.purchaseFlow?.state || 'idle';
  if (state !== 'idle') return false;

  if (
    semanticQuick.wantsHuman ||
    semanticQuick.wantsClearCart ||
    semanticQuick.wantsCart ||
    semanticQuick.wantsCheckout ||
    semanticQuick.wantsCancelFlow
  ) {
    return false;
  }

  return resolveCatalogQuery(text).shouldHandle;
}

module.exports = {
  normalizeText,
  resolveCatalogQuery,
  shouldUseCatalogResolver,
};
