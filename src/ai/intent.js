function isHumanPauseResumeIntent(analysis, text = '') {
  const normalizedText = String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/_/g, ' ');

  return Boolean(
    analysis?.wantsBrowse
    || analysis?.wantsLaunches
    || analysis?.wantsMoreProducts
    || analysis?.wantsProductSelection
    || analysis?.wantsCheckout
    || analysis?.wantsPhotosExplicit
    || analysis?.wantsSize
    || analysis?.wantsQuantity
    || analysis?.wantsProductSearch
    || analysis?.categories?.length > 0
    || /\b(catalogo|lancamentos?|novidades?|pecas?|produtos?|modelos?|vitrine|fechar pedido|fazer pedido|continuar vendo|ver mais)\b/i.test(normalizedText)
  );
}

module.exports = { isHumanPauseResumeIntent };
