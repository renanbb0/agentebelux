function normalizeSizeValue(size) {
  return String(size || '').trim().toUpperCase();
}

function normalizeVariantText(str) {
  return String(str || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
}

/**
 * Tries to match user input against a list of variant options.
 * Returns the original option string on match, null otherwise.
 * Supports: exact name, normalized name, or 1-based numeric index.
 */
function matchVariant(text, options) {
  if (!text || !Array.isArray(options)) return null;
  const normInput = normalizeVariantText(text);

  const numMatch = normInput.match(/^(\d+)$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
    return null;
  }

  return options.find((opt) => normalizeVariantText(opt) === normInput) || null;
}

/**
 * Extracts a size+quantity grid from free text.
 * Only call when FSM is active and the focused product has known sizes.
 * @param {string} text
 * @param {string[]} knownSizes - e.g. ['P','M','G','GG']
 * @returns {{ size: string, qty: number }[] | null}
 */
function parseGradeText(text, knownSizes) {
  if (!text || !knownSizes?.length) return null;
  text = text.replace(/[\n\r]/g, ' ');

  // ── Expressões de "N de cada tamanho" (PT-BR naturais) ──────────────────
  {
    const WORD_TO_NUM = { um: 1, uma: 1, dois: 2, duas: 2, três: 3, tres: 3, quatro: 4, cinco: 5 };
    const eachPattern = /\b(?:manda\s+)?(\d+|um|uma|dois|duas|tr[eê]s|quatro|cinco)\s+de\s+cada\s*(?:tamanho)?\b/i;
    const fullGradePattern = /\b(?:toda\s+[ao]\s+grade|uma?\s+grade\s+completa|manda\s+toda\s+[ao]\s+grade)\b/i;
    const eachMatch = text.match(eachPattern);
    const fullGrade = fullGradePattern.test(text);
    if (eachMatch || fullGrade) {
      const rawQty = eachMatch ? eachMatch[1].toLowerCase() : '1';
      const qty = WORD_TO_NUM[rawQty] ?? parseInt(rawQty, 10);
      if (qty > 0 && qty <= 999) {
        return knownSizes.map(s => ({ size: s, qty }));
      }
    }
  }

  // Produto de tamanho único: aceita qualquer número digitado como quantidade
  if (knownSizes.length === 1) {
    const singleMatch = text.trim().match(/^(?:quero\s+)?(\d{1,3})\s*(?:pe[çc]as?|unidades?|pacotes?|pares?|itens?|pc|pcs|un?)?$/i);
    if (singleMatch) {
      const qty = parseInt(singleMatch[1], 10);
      if (qty > 0 && qty <= 999) {
        return [{ size: knownSizes[0], qty }];
      }
    }
  }

  const knownSizesUpper = new Set(knownSizes.map(size => size.toUpperCase()));
  const sizesPattern = knownSizes
    .slice()
    .sort((a, b) => b.length - a.length)
    .join('|');

  const totalsBySize = new Map();
  const orderedSizes = [];

  // Pattern: number before size
  const regexQtyFirst = new RegExp(
    `(\\d+)\\s*(?:do|da|de|dos|das|x|:|tamanho)?\\s*(${sizesPattern})(?=\\s|,|;|\\.|/|!|\\?|e\\b|$)`,
    'gi'
  );

  // Pattern: size before number — "P: 9", "P=9", "P - 9"
  const regexSizeFirst = new RegExp(
    `\\b(${sizesPattern})\\s*[=:\\-]\\s*(\\d+)`,
    'gi'
  );

  function addGradeEntry(rawSize, rawQty) {
    const size = String(rawSize).toUpperCase();
    const qty = parseInt(rawQty, 10);
    if (!knownSizesUpper.has(size) || qty <= 0 || qty > 999) return;

    if (!totalsBySize.has(size)) {
      totalsBySize.set(size, 0);
      orderedSizes.push(size);
    }
    totalsBySize.set(size, totalsBySize.get(size) + qty);
  }

  let match;
  while ((match = regexQtyFirst.exec(text)) !== null) {
    addGradeEntry(match[2], match[1]);
  }
  while ((match = regexSizeFirst.exec(text)) !== null) {
    addGradeEntry(match[1], match[2]);
  }

  // Passe 3: tamanhos sem quantidade → qty implícita = 1
  const regexSizeOnly = new RegExp(`\\b(${sizesPattern})\\b`, 'gi');
  while ((match = regexSizeOnly.exec(text)) !== null) {
    const sizeOnly = String(match[1]).toUpperCase();
    if (knownSizesUpper.has(sizeOnly) && !totalsBySize.has(sizeOnly)) {
      addGradeEntry(sizeOnly, '1');
    }
  }

  const validResults = orderedSizes.map(size => ({ size, qty: totalsBySize.get(size) }));

  // Detecta tamanhos órfãos
  const COMMON_SIZES = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'EXGG', 'EXG', 'XGG', 'EG', 'XXG', 'XXXG'];
  const orphanSizes = [];
  const orphanRegex = /(?:(\d+)\s*(?:do|da|de|dos|das|x|:|tamanho)?\s*([A-Z]{1,4})(?=\s|,|;|\.|$))|(?:\b([A-Z]{1,4})\s*[=:\-]\s*(\d+))/gi;
  let oMatch;
  while ((oMatch = orphanRegex.exec(text)) !== null) {
    const orphanSize = (oMatch[2] || oMatch[3] || '').toUpperCase();
    if (
      orphanSize &&
      !knownSizesUpper.has(orphanSize) &&
      !orphanSizes.includes(orphanSize) &&
      COMMON_SIZES.includes(orphanSize)
    ) {
      orphanSizes.push(orphanSize);
    }
  }

  if (validResults.length === 0 && orphanSizes.length === 0) return null;

  const result = validResults.length > 0 ? validResults : [];
  result._orphanSizes = orphanSizes;
  return result;
}

/**
 * Tenta extrair pares (variante, grade) de uma mensagem combinada.
 * Ex: "mae 2g filha 1p" → [{ variant:'Mãe', grade:[{size:'G',qty:2}] }, ...]
 * @param {string} text
 * @param {string[]} attrOptions - ex: ['Mãe', 'Filha']
 * @param {string[]} productSizes - ex: ['P','M','G','GG']
 * @returns {{ variant: string, grade: {size: string, qty: number}[] }[] | null}
 */
function parseMultiVariantGrade(text, attrOptions, productSizes) {
  if (!text || !attrOptions?.length || !productSizes?.length) return null;
  text = text.replace(/[\n\r]/g, ' ');

  const escapedOptions = attrOptions.map((opt) =>
    normalizeVariantText(opt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  const variantRx = new RegExp(`\\b(${escapedOptions.join('|')})\\b`, 'gi');

  const normText = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  const hits = [...normText.matchAll(variantRx)].map((m) => ({
    index: m.index,
    length: m[0].length,
    original: attrOptions.find((opt) => normalizeVariantText(opt) === normalizeVariantText(m[0])) || m[0],
  }));

  if (hits.length === 0) return null;

  // Pre-pass: "QTY VARIANT SIZE" — ex: "2 mae gg 3 filha g"
  {
    const sizesPatternLocal = productSizes.slice()
      .sort((a, b) => b.length - a.length)
      .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const qtyVarSizeRx = new RegExp(
      `(\\d+)\\s+(${escapedOptions.join('|')})\\s+(${sizesPatternLocal})(?=\\s|,|;|\\.|$)`,
      'gi'
    );
    const directPairs = [];
    let dm;
    while ((dm = qtyVarSizeRx.exec(normText)) !== null) {
      const qty = parseInt(dm[1], 10);
      const variant = attrOptions.find(opt => normalizeVariantText(opt) === normalizeVariantText(dm[2])) || dm[2];
      const sizeUpper = dm[3].toUpperCase();
      const originalSize = productSizes.find(s => s.toUpperCase() === sizeUpper) || dm[3];
      if (qty > 0 && qty <= 999) {
        directPairs.push({ variant, grade: [{ size: originalSize, qty }] });
      }
    }
    if (directPairs.length === hits.length && directPairs.length > 0) return directPairs;
  }

  // Ordenação 1: grade APÓS a variante ("mãe 2G filha 1M")
  const afterPairs = [];
  for (let i = 0; i < hits.length; i++) {
    const gradeText = text.slice(hits[i].index + hits[i].length, hits[i + 1]?.index ?? text.length).trim();
    if (!gradeText) continue;
    const grade = parseGradeText(gradeText, productSizes);
    if (grade?.length > 0) afterPairs.push({ variant: hits[i].original, grade });
  }

  // Ordenação 2: grade ANTES da variante ("2G mãe 1M filha" / "3g mãe\n2P filha")
  const beforePairs = [];
  for (let i = 0; i < hits.length; i++) {
    const start = i === 0 ? 0 : hits[i - 1].index + hits[i - 1].length;
    const gradeText = text.slice(start, hits[i].index).trim();
    if (!gradeText) continue;
    const grade = parseGradeText(gradeText, productSizes);
    if (grade?.length > 0) beforePairs.push({ variant: hits[i].original, grade });
  }
  // Caso especial: grade após o último hit na ordem 2
  if (hits.length >= 2) {
    const lastHit = hits[hits.length - 1];
    const trailingText = text.slice(lastHit.index + lastHit.length).trim();
    if (trailingText) {
      const grade = parseGradeText(trailingText, productSizes);
      if (grade?.length > 0) beforePairs.push({ variant: lastHit.original, grade });
    }
  }

  if (beforePairs.length > afterPairs.length) return beforePairs;
  if (afterPairs.length > 0) return afterPairs;
  return beforePairs.length > 0 ? beforePairs : null;
}

module.exports = {
  normalizeSizeValue,
  normalizeVariantText,
  matchVariant,
  parseGradeText,
  parseMultiVariantGrade,
};
