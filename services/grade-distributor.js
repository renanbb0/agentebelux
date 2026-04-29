const logger = require('./logger');

/**
 * Distributes a compound grade specification across N matched products.
 *
 * Input example:
 *   matchedProducts = [
 *     { productId: 101, name: 'Pijama Onça', sizes: ['P','M','G'] },
 *     { productId: 102, name: 'Pijama Coração', sizes: ['P','M','G'] },
 *     { productId: 103, name: 'Pijama Floral', sizes: ['P','M','G'] },
 *   ]
 *   spec = { perVariant: 6, perSize: 2 }   // "6 de cada estampa, 2 de cada tamanho"
 *
 * Output:
 *   { plan: [{productId,name,grade:[{size,qty},...]}, ...], totalPieces, inconsistencies }
 */
function distributeCompoundGrade(matchedProducts, spec) {
  const inconsistencies = [];

  if (!Array.isArray(matchedProducts) || matchedProducts.length === 0) {
    return { plan: [], totalPieces: 0, inconsistencies: ['sem_produtos_identificados'] };
  }
  const hasPerVariantGrade = Array.isArray(spec?.perVariantGrade) && spec.perVariantGrade.length > 0;
  if (!spec || (spec.perVariant == null && spec.perSize == null && !hasPerVariantGrade)) {
    return { plan: [], totalPieces: 0, inconsistencies: ['spec_vazio'] };
  }

  const perVariant = Number.isFinite(spec.perVariant) ? spec.perVariant : null;
  const perSize = Number.isFinite(spec.perSize) ? spec.perSize : null;

  const plan = [];
  let totalPieces = 0;

  for (const product of matchedProducts) {
    const sizes = Array.isArray(product.sizes) ? product.sizes.filter(Boolean) : [];
    if (sizes.length === 0) {
      inconsistencies.push(`produto_sem_tamanhos:${product.productId}`);
      continue;
    }

    let grade;

    if (hasPerVariantGrade) {
      // Grade explícita por variante (ex: "2M de cada estampa", "1P 2M 1G de cada modelo").
      // Suporta entrada com variant ("2G mae de cada estampa" → {size:'G',qty:2,variant:'Mãe'}).
      const sizesUpper = sizes.map((s) => String(s).toUpperCase());
      const hasVariantInfo = spec.perVariantGrade.some((e) => e.variant != null);

      if (hasVariantInfo && Array.isArray(product.attrOptions) && product.attrOptions.length > 0) {
        // Variant-aware: combina por variante (normalizado) + tamanho
        const normalizeStr = (s) =>
          String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
        const accepted = [];
        for (const { size, qty, variant } of spec.perVariantGrade) {
          if (variant == null) continue;
          const sUp = String(size).toUpperCase();
          if (!sizesUpper.includes(sUp)) {
            inconsistencies.push(
              `tamanho_indisponivel:produto=${product.productId}:tamanho=${size}:variante=${variant}`
            );
            continue;
          }
          const normVariant = normalizeStr(variant);
          const matchedVariant = product.attrOptions.find(
            (opt) => normalizeStr(opt) === normVariant
          );
          if (!matchedVariant) {
            inconsistencies.push(
              `variante_indisponivel:produto=${product.productId}:variante=${variant}`
            );
            continue;
          }
          accepted.push({ size: sizes[sizesUpper.indexOf(sUp)], qty, variant: matchedVariant });
        }
        if (accepted.length === 0) continue;
        grade = accepted;
      } else {
        // Size-only (sem informação de variante)
        const accepted = [];
        for (const { size, qty } of spec.perVariantGrade) {
          const sUp = String(size).toUpperCase();
          if (sizesUpper.includes(sUp)) {
            accepted.push({ size: sizes[sizesUpper.indexOf(sUp)], qty });
          } else {
            inconsistencies.push(
              `tamanho_indisponivel:produto=${product.productId}:tamanho=${size}`
            );
          }
        }
        if (accepted.length === 0) continue;
        grade = accepted;
      }
    } else if (perSize != null) {
      // perSize é fonte de verdade quando presente
      grade = sizes.map(size => ({ size, qty: perSize }));
      const expectedPerVariant = perSize * sizes.length;
      if (perVariant != null && perVariant !== expectedPerVariant) {
        inconsistencies.push(
          `divergencia_estampa_vs_tamanho:produto=${product.productId}:esperado=${expectedPerVariant}:informado=${perVariant}`
        );
      }
    } else if (perVariant != null) {
      // Só perVariant — distribui igualmente entre tamanhos
      const qtyPerSize = Math.floor(perVariant / sizes.length);
      const remainder = perVariant - (qtyPerSize * sizes.length);
      if (qtyPerSize === 0) {
        inconsistencies.push(
          `per_variant_menor_que_tamanhos:produto=${product.productId}:variant=${perVariant}:tamanhos=${sizes.length}`
        );
        continue;
      }
      grade = sizes.map(size => ({ size, qty: qtyPerSize }));
      if (remainder > 0) {
        inconsistencies.push(
          `resto_na_divisao:produto=${product.productId}:resto=${remainder}`
        );
      }
    } else {
      continue;
    }

    const productTotal = grade.reduce((acc, g) => acc + g.qty, 0);
    totalPieces += productTotal;

    plan.push({
      productId: product.productId,
      name: product.name,
      grade,
    });
  }

  logger.info(
    {
      matchedCount: matchedProducts.length,
      spec,
      planSize: plan.length,
      totalPieces,
      inconsistencies,
    },
    '[GRADE-DISTRIBUTOR] compound plan computed'
  );

  return { plan, totalPieces, inconsistencies };
}

/**
 * Verifica se um plano recebido do LLM bate com a soma determinística.
 * Usado como cross-check antes de executar pushCartItem.
 * @returns {boolean} true se total bate; false se divergiu.
 */
function validatePlanTotals(plan, declaredTotal) {
  const computed = plan.reduce((acc, item) => {
    return acc + item.grade.reduce((a, g) => a + (Number(g.qty) || 0), 0);
  }, 0);
  return computed === declaredTotal;
}

module.exports = { distributeCompoundGrade, validatePlanTotals };