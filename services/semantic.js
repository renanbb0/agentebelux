function stripAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeSemanticText(text) {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\bvcs?\b/g, ' voce ')
    .replace(/\bvdd\b/g, ' verdade ')
    .replace(/\bpfv?r?\b/g, ' por favor ')
    .replace(/\bq\b/g, ' que ')
    .replace(/\bkd\b/g, ' cade ')
    .replace(/\bmsg\b/g, ' mensagem ')
    .replace(/\bimg\b/g, ' imagem ')
    .replace(/\bfts?\b/g, ' foto ')
    .replace(/\btam\b/g, ' tamanho ')
    .replace(/\bqtd\b/g, ' quantidade ')
    .replace(/\bpecinha(s)?\b/g, ' peca$1 ')
    .replace(/\bcalcinhas?\b/g, ' calcinha ')
    .replace(/\bcuecas?\b/g, ' cueca ')
    .replace(/\bsutia(s)?\b/g, ' sutia$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function detectCategories(normalized) {
  const categories = [];
  const mentionsGirl = /\bmenina(s)?\b/.test(normalized);
  const mentionsBoy = /\bmenino(s)?\b/.test(normalized);

  if (matchAny(normalized, [/\bfeminin[oa]\b/, /\blingerie\b/, /\bcalcinha\b/, /\bsutia\b/, /\btop\b/])) {
    categories.push('feminino');
  }

  if (matchAny(normalized, [/\bmasculin[oa]\b/, /\bcueca\b/, /\bsamba cancao\b/, /\bboxer\b/])) {
    categories.push('masculino');
  }

  if (matchAny(normalized, [/\binfantil\b/, /\binfanto\b/, /\bcrianca\b/, /\bmenina\b/, /\bmenino\b/, /\bkids?\b/])) {
    if (categories.includes('feminino') || mentionsGirl) {
      return ['femininoinfantil'];
    }
    if (categories.includes('masculino') || mentionsBoy) {
      return ['masculinoinfantil'];
    }
    return ['infantil'];
  }

  return categories;
}

function analyzeUserMessage(text) {
  const normalized = normalizeSemanticText(text);
  const categories = detectCategories(normalized);

  const wantsLaunches = matchAny(normalized, [
    /\blancamento(s)?\b/,
    /\bnovidade(s)?\b/,
    /\bnovo(s)?\b/,
    /\brecem cheg/,
    /\bo que tem de novo\b/,
    /\bo que chegou\b/,
    /\bultim[ao] cole/,
  ]);

  const wantsBrowse = matchAny(normalized, [
    /\bquero ver\b/,
    /\bme mostra\b/,
    /\bmostra ai\b/,
    /\bmanda ai\b/,
    /\bme manda\b/,
    /\btem ai\b/,
    /\bquais voces tem\b/,
    /\bme passa\b/,
    /\bto procurando\b/,
    /\bprocuro\b/,
  ]);

  const wantsMoreProducts = matchAny(normalized, [
    /\bmais opc/,
    /\bmais modelo/,
    /\bmais peca/,
    /\boutro modelo/,
    /\boutros? modelos?\b/,
    /\bcontinua\b/,
    /\bsegue\b/,
    /\bproximo(s)?\b/,
    /\bquero ver mais\b/,
    /\bmostra mais\b/,
    /\bmanda mais\b/,
  ]);

  const wantsPhotosExplicit = matchAny(normalized, [
    /\bfoto(s)?\b/,
    /\bimagem(ns)?\b/,
    /\bvideo(s)?\b/,
    /\bfotinha(s)?\b/,
    /\bmostra melhor\b/,
    /\bver melhor\b/,
    /\bver direito\b/,
    /\bmais detalhe\b/,
    /\boutro angulo\b/,
    /\bmais de perto\b/,
  ]);

  const wantsHuman = matchAny(normalized, [
    /\batendente\b/,
    /\bhumano\b/,
    /\bconsultor(a)?\b/,
    /\bvendedor(a)?\b/,
    /\bgerente\b/,
    /\bresponsavel\b/,
    /\buma pessoa\b/,
    /\bchama\b.*\bpessoa\b/,
    /\bchama\b.*\balguem\b/,
    /\bfala\b.*\bhumano\b/,
    /\bfalar\b.*\bhumano\b/,
    /\bquero\b.*\bpessoa\b/,
    /\bpreciso\b.*\bpessoa\b/,
    /\bpassa\b.*\batend/,
  ]);

  const wantsCart = matchAny(normalized, [
    /\bcarrinho\b/,
    /\brevisar pedido\b/,
    /\bver pedido\b/,
    /\bmostra meu pedido\b/,
    // Perguntas de valor/total — não devem ser interceptadas pelo FSM de tamanhos
    /\bquanto (deu|ficou|ta|tá|fica|é|foi)\b/,
    /\bdeu quanto\b/,
    /\bqual.*(total|valor)\b/,
    /\b(total|valor).*(pedido|compra|carrinho)\b/,
    /\bme manda.*(paguei|pedido|comprei|separei)\b/,
    /\bo que (eu )?(paguei|separei|comprei|tem)\b/,
  ]);

  const wantsClearCart = matchAny(normalized, [
    /\blimpar\b.*\bcarrinho\b/,
    /\besvaziar\b.*\bcarrinho\b/,
    /\bzerar\b.*\bcarrinho\b/,
    /\btira tudo\b/,
    /\bdesfaz\b.*\b(isso|tudo|pedido|compra)\b/,
    /\berrei tudo\b/,
    /\bapaga tudo\b/,
    /\bcancela\b.*\b(pedido|compra|tudo)\b/,
    /\bremove tudo\b/,
    /\bdeleta tudo\b/,
    /\bnao quero mais nada\b/,
    /\blimpa tudo\b/,
  ]);

  const wantsCheckout = matchAny(normalized, [
    /\bfinaliz/,
    /\bfechar pedido\b/,
    /\bfechar compra\b/,
    /\bencaminha\b/,
    /\bpagamento\b/,
    /\bpagar\b/,
    /\bcheckout\b/,
    // Expressões naturais de "terminei de escolher / pode fechar"
    /\bterminei\b/,
    /\bpront[oa]\b/,
    /\bacabei\b/,
    /\bpode\s+fechar\b/,
    /\bpode\s+mandar\b/,
    /\bfecha\s+(a[iíì]|a\s+compra|o\s+pedido)\b/,
    /\b[ée]\s+isso\b/,
    /\bissso?\s+[ée]\s+tudo\b/,
    /\bquero\s+fechar\b/,
    /\bpode\s+(ir|seguir|manda[r]?)\b/,
    // Variações de "encerrar" e "terminar a compra" (ex: "encerrei", "terminar a compra")
    /\bencerrr?[aeo][iu]?\b/,
    /\bterminar?\s+(a\s+)?compra\b/,
    /\bpode\s+(terminar|encerrar)\b/,
    /\bso\s+isso\s+[ée]\s+tudo\b/,
    /\bta\s*(bom|ok)\s+pode\s+(fechar|terminar|encerrar)\b/,
  ]);

  const wantsPrice = matchAny(normalized, [
    /\bpreco\b/,
    /\bvalor\b/,
    /\bquanto\b/,
    /\bfaixa\b/,
    /\bcusta\b/,
  ]);

  const wantsProductSelection = matchAny(normalized, [
    /\bcomprar\b/,
    /\bseparar\b/,
    /\bquero esse\b/,
    /\bquero essa\b/,
    /\bvou levar\b/,
    /\blevo\b/,
    /\bme ve\b/,
    /\bfecha esse\b/,
    /\bmanda esse\b/,
    /\bmanda essa\b/,
  ]);

  const wantsSize = matchAny(normalized, [
    /\btamanho\b/,
    /\bgrade\b/,
    /\bnumera/,
    /\bmedida\b/,
  ]);

  const wantsQuantity = matchAny(normalized, [
    /\bquantidade\b/,
    /\bqtd\b/,
    /\bduzia\b/,
    /\bkit\b/,
    /\bpacote\b/,
    /\bcaixa\b/,
    /\bpar(es)?\b/,
    /\b\d+\b/,
  ]);

  const wantsProductSearch = matchAny(normalized, [
    /\bref\s*\d/,
    /\breferencia\s*\d/,
    /\btem\b.*\bref\b/,
    /\btem\b.*\bpijama\b/,
    /\btem\b.*\bcalcinha\b/,
    /\btem\b.*\bconjunto\b/,
    /\btem\b.*\bkit\b/,
    /\btem\b.*\bcueca\b/,
    /\bquero\s+outr/,
    /\boutr[oa]\s+pe[çc]a/,
    /\bprocur/,
    /\bbuscar?\b/,
  ]);

  const wantsCancelFlow = matchAny(normalized, [
    /\bdesist/,
    /\bdeixa\b.*\b(isso|esse|essa|pra la)\b/,
    /\bpara\b.*\b(com isso|tudo)\b/,
    /\bnao quero mais\b/,
    /\bvolta\b.*\b(zero|inicio|comeco)\b/,
    /\bvamos\b.*\b(zero|inicio|comeco)\b/,
    /\berrei\b/,
    /\bnao\b.*\bpera\b/,
    /\bnao e isso\b/,
    /\bmuda\b/,
    /\btrocar\b.*\b(produto|categoria|linha)\b/,
    /\bquero outr[oa]\b/,
    /\boutra linha\b/,
    /\boutro produto\b/,
    /\bvamos pra outr/,
  ]);

  const slangOrNoisy = normalized !== String(text || '').toLowerCase().trim()
    || /\b(ai|ta|to|pra|pro|pq|tb|tbm|q)\b/.test(normalized);

  return {
    rawText: String(text || ''),
    normalizedText: normalized,
    categories,
    wantsLaunches,
    wantsBrowse,
    wantsMoreProducts,
    wantsPhotosExplicit,
    wantsHuman,
    wantsCart,
    wantsClearCart,
    wantsCheckout,
    wantsPrice,
    wantsProductSelection,
    wantsSize,
    wantsQuantity,
    wantsProductSearch,
    wantsCancelFlow,
    slangOrNoisy,
  };
}

function buildSemanticContext(text, session = {}) {
  const analysis = analyzeUserMessage(text);
  const hints = [];

  if (!analysis.rawText.trim()) return '';

  hints.push('LEITURA SEMANTICA DA ULTIMA MENSAGEM:');
  hints.push(`- Texto normalizado para interpretacao: ${analysis.normalizedText || 'vazio'}`);
  hints.push('- Regra: priorize o sentido da fala, mesmo com giria, abreviacao, erro de digitacao, frase quebrada ou pedido implicito.');

  if (analysis.categories.length > 0) {
    hints.push(`- Categoria sugerida pelo sentido: ${analysis.categories.join(', ')}`);
  }

  const probableIntents = [];
  if (analysis.wantsLaunches) probableIntents.push('quer ver novidades');
  if (analysis.wantsBrowse) probableIntents.push('quer ver produtos');
  if (analysis.wantsMoreProducts) probableIntents.push('quer continuar navegando');
  if (analysis.wantsPhotosExplicit) probableIntents.push('quer ver melhor algum produto');
  if (analysis.wantsProductSelection) probableIntents.push('quer separar ou comprar um produto');
  if (analysis.wantsCart) probableIntents.push('quer revisar o carrinho');
  if (analysis.wantsCheckout) probableIntents.push('quer fechar o pedido');
  if (analysis.wantsHuman) probableIntents.push('pode querer atendimento humano');
  if (analysis.wantsPrice) probableIntents.push('quer avaliar preco');
  if (analysis.wantsProductSearch) probableIntents.push('quer buscar produto por referência ou descrição');
  if (analysis.wantsCancelFlow) probableIntents.push('quer cancelar ou mudar o fluxo atual');

  if (probableIntents.length > 0) {
    hints.push(`- Intencoes provaveis: ${probableIntents.join('; ')}`);
  }

  if (analysis.slangOrNoisy) {
    hints.push('- Observacao: a mensagem parece informal ou ruidosa; nao exija palavras exatas para entender.');
  }

  if (session.purchaseFlow?.state && session.purchaseFlow.state !== 'idle') {
    hints.push(`- FSM ativa: ${session.purchaseFlow.state}`);
  }

  return hints.join('\n');
}

function inferActionFromSemantics(text, session = {}) {
  const analysis = analyzeUserMessage(text);

  if (!analysis.rawText.trim()) return null;

  if (analysis.wantsClearCart) {
    return { type: 'LIMPAR_CARRINHO', payload: null };
  }

  if (analysis.wantsHuman) {
    return { type: 'FALAR_ATENDENTE', payload: null };
  }

  // Cancel flow: se está no meio de compra e quer cancelar, reseta FSM
  if (analysis.wantsCancelFlow && session.purchaseFlow?.state !== 'idle') {
    return { type: 'CANCELAR_FLUXO', payload: null };
  }

  if (analysis.wantsCheckout && (session.items?.length || 0) > 0) {
    return { type: 'HANDOFF', payload: null };
  }

  if (analysis.wantsCart) {
    return { type: 'CARRINHO', payload: null };
  }

  if (analysis.wantsLaunches) {
    return { type: 'VER_TODOS', payload: 'lancamento-da-semana' };
  }

  if ((analysis.wantsBrowse || analysis.categories.length > 0) && analysis.categories[0]) {
    return { type: 'VER', payload: analysis.categories[0] };
  }

  if (analysis.wantsMoreProducts && session.activeCategory && session.currentPage < session.totalPages) {
    return { type: 'PROXIMOS', payload: null };
  }

  return null;
}

function isLikelyPhotoRequest(text, options = {}) {
  const { hasProductContext = false } = options;
  const normalized = normalizeSemanticText(text);

  const explicit = matchAny(normalized, [
    /\bfoto(s)?\b/,
    /\bimagem(ns)?\b/,
    /\bvideo(s)?\b/,
    /\bfotinha(s)?\b/,
  ]);

  if (explicit) return true;

  if (!hasProductContext) return false;

  return matchAny(normalized, [
    /\bmostra melhor\b/,
    /\bquero ver melhor\b/,
    /\bver direito\b/,
    /\bmais detalhe\b/,
    /\boutro angulo\b/,
    /\bmais de perto\b/,
    /\bmanda mais dela\b/,
    /\bmanda mais desse\b/,
    /\bmanda mais dessa\b/,
    /\btem mais dessa\b/,
    /\btem mais desse\b/,
  ]);
}

module.exports = {
  analyzeUserMessage,
  buildSemanticContext,
  inferActionFromSemantics,
  isLikelyPhotoRequest,
  normalizeSemanticText,
};
