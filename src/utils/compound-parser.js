const { parseGradeText, parseMultiVariantGrade } = require('./variant-text');

const WORD_TO_NUM_COMPOUND = {
  um: 1, uma: 1, dois: 2, duas: 2, três: 3, tres: 3, quatro: 4, cinco: 5, seis: 6,
};

/**
 * Detecta spec de grade composta multi-produto em texto livre, SEM exigir
 * knownSizes (porque no caso composto múltiplos produtos podem ter grades
 * diferentes — o solver determinístico resolve por produto depois).
 *
 * Padrões suportados:
 *   - "6 de cada estampa"   → perVariant=6
 *   - "2 de cada tamanho"   → perSize=2
 *   - combinados: "6 de cada estampa, 2 de cada tamanho"
 *
 * @param {string} text
 * @returns {{ perVariant: number|null, perSize: number|null, perVariantGrade: Array|null } | null}
 */
function parseCompoundSpec(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = text.replace(/[\n\r]/g, ' ');

  const perVariantRegex = /\b(\d+|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis)\s+de\s+cada\s+(estampa|modelo|cor|desenho|padr[ãa]o)\b/i;
  const perSizeRegex    = /\b(\d+|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis)\s+de\s+cada\s+tamanho\b/i;
  const perVariantSizesRegex =
    /\b(\d+|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis)\s+de\s+cada(?:\s+um)?\s+(?:(?:no|na|nos|nas)\s+)?(?:tam(?:anho)?s?|tamanhos)\s+([a-zà-ú0-9\s,;\/e]+?)(?=[.!?]|$)/i;

  // Padrão "<grade> de cada estampa" — onde <grade> é uma especificação de
  // tamanhos completa, ex: "2M de cada estampa", "1P 2M 1G de cada modelo".
  const variantPhraseRegex = /\bde\s+cada\s+(estampa|modelo|cor|desenho|padr[ãa]o)s?\b/i;

  const toNumber = (raw) => {
    const key = String(raw).toLowerCase();
    return WORD_TO_NUM_COMPOUND[key] ?? parseInt(key, 10);
  };

  const vMatch = normalized.match(perVariantRegex);
  const sMatch = normalized.match(perSizeRegex);

  const perVariant = vMatch ? toNumber(vMatch[1]) : null;
  const perSize    = sMatch ? toNumber(sMatch[1]) : null;
  const valid = (n) => Number.isFinite(n) && n > 0 && n <= 999;

  const STD_SIZES = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'XGGG'];
  let perVariantGrade = null;
  const sizeListMatch = normalized.match(perVariantSizesRegex);
  if (sizeListMatch) {
    const qty = toNumber(sizeListMatch[1]);
    const grade = parseGradeText(sizeListMatch[2], STD_SIZES);
    if (valid(qty) && Array.isArray(grade) && grade.length > 0) {
      perVariantGrade = grade.map(({ size }) => ({ size, qty }));
    }
  }

  if (!vMatch) {
    const phraseMatch = normalized.match(variantPhraseRegex);
    if (phraseMatch && phraseMatch.index > 0) {
      const prefix = normalized.slice(0, phraseMatch.index).trim();
      const KNOWN_VARIANTS = ['Mãe', 'Filha', 'Adulto', 'Adulta', 'Infantil', 'Criança', 'Bebê'];
      const multiPairs = parseMultiVariantGrade(prefix, KNOWN_VARIANTS, STD_SIZES);
      if (Array.isArray(multiPairs) && multiPairs.length > 0) {
        perVariantGrade = multiPairs.flatMap(({ variant, grade: g }) =>
          g.map(({ size, qty }) => ({ size, qty, variant }))
        );
      } else {
        const grade = parseGradeText(prefix, STD_SIZES);
        if (Array.isArray(grade) && grade.length > 0) {
          perVariantGrade = grade;
        }
      }
    }
  }

  if (!valid(perVariant) && !valid(perSize) && !perVariantGrade) return null;

  return {
    perVariant: valid(perVariant) ? perVariant : null,
    perSize:    valid(perSize)    ? perSize    : null,
    perVariantGrade,
  };
}

module.exports = { parseCompoundSpec };
