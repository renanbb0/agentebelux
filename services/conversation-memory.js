function createDefaultConversationMemory() {
  return {
    stage: 'inicio',
    currentIntent: '',
    preferences: [],
    objections: [],
    discussedTopics: [],
    pendingFollowUp: '',
    summary: '',
    // Resumo cumulativo de turnos que saíram da janela deslizante de contexto
    // (turnos com mais de 20 min). Mantido curto (800 chars) pra não inflar o prompt.
    archivedSummary: '',
    lastUserMessage: '',
    lastAssistantMessage: '',
    lastSystemAction: '',
    turnCount: 0,
    updatedAt: null,
  };
}

const ARCHIVED_SUMMARY_MAX = 800;

/**
 * Comprime turnos antigos (fora da janela deslizante) num resumo textual
 * acumulativo em memory.archivedSummary. Mantém o tamanho limitado
 * descartando o início quando passa de ARCHIVED_SUMMARY_MAX chars.
 *
 * @param {object} session
 * @param {Array<{role, content, ts}>} staleEntries - mensagens a arquivar
 */
function archiveStaleTurns(session, staleEntries) {
  if (!Array.isArray(staleEntries) || staleEntries.length === 0) return;
  const memory = session.conversationMemory || createDefaultConversationMemory();

  const fragments = staleEntries
    .map(entry => {
      const roleTag = entry.role === 'user' ? 'cliente' : entry.role === 'assistant' ? 'bela' : entry.role;
      const snippet = sanitizeSnippet(entry.content, 80);
      return snippet ? `${roleTag}: ${snippet}` : '';
    })
    .filter(Boolean);

  if (fragments.length === 0) return;

  const addition = fragments.join(' | ');
  let next = memory.archivedSummary
    ? `${memory.archivedSummary} | ${addition}`
    : addition;

  // Mantém os chars mais recentes quando ultrapassa o limite
  if (next.length > ARCHIVED_SUMMARY_MAX) {
    next = '...' + next.slice(next.length - ARCHIVED_SUMMARY_MAX + 3);
  }

  memory.archivedSummary = next;
  memory.updatedAt = Date.now();
  session.conversationMemory = memory;
}

function sanitizeSnippet(text, maxLen = 180) {
  if (!text) return '';
  return String(text)
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function pushUnique(list, values, maxItems = 6) {
  const next = Array.isArray(list) ? [...list] : [];
  for (const value of values) {
    if (!value || next.includes(value)) continue;
    next.push(value);
    if (next.length >= maxItems) break;
  }
  return next.slice(0, maxItems);
}

function detectPreferences(text) {
  const src = (text || '').toLowerCase();
  const preferences = [];

  const hints = [
    [/feminin[oa]/, 'linha feminina'],
    [/masculin[oa]/, 'linha masculina'],
    [/(infantil|menina|menino)/, 'linha infantil'],
    [/(lan[cç]amento|novidade)/, 'lancamentos'],
    [/(promo[cç][aã]o|oferta|baratinh|mais em conta)/, 'promocoes'],
    [/(pijama)/, 'pijamas'],
    [/(cueca)/, 'cuecas'],
    [/(calcinha)/, 'calcinhas'],
    [/(suti[aã]|top)/, 'sutias ou tops'],
    [/(conjunto)/, 'conjuntos'],
    [/(plus|plus size|maior)/, 'grade maior'],
    [/(ref\b|refer[êe]ncia)/, 'compra por referencia'],
  ];

  hints.forEach(([regex, label]) => {
    if (regex.test(src)) preferences.push(label);
  });

  const sizes = src.match(/\b(pp|p|m|g|gg|xg|eg|g1|g2|g3|34|36|38|40|42|44|46)\b/gi) || [];
  if (sizes.length > 0) {
    preferences.push(`tamanhos mencionados: ${Array.from(new Set(sizes.map(s => s.toUpperCase()))).join(', ')}`);
  }

  return preferences;
}

function detectObjections(text) {
  const src = (text || '').toLowerCase();
  const objections = [];

  const hints = [
    [/(caro|muito caro|pre[cç]o alto|valor alto)/, 'sensibilidade a preco'],
    [/(frete|envio|entrega|prazo)/, 'duvida sobre entrega ou frete'],
    [/(qualidade|material|tecido|acabamento)/, 'duvida sobre qualidade'],
    [/(n[aã]o gostei|n[aã]o quero|deixa|depois vejo)/, 'resistencia ou perda de interesse'],
    [/(sem estoque|acabou|indispon[ií]vel)/, 'preocupacao com disponibilidade'],
  ];

  hints.forEach(([regex, label]) => {
    if (regex.test(src)) objections.push(label);
  });

  return objections;
}

function detectDiscussedTopics(text) {
  const src = (text || '').toLowerCase();
  const topics = [];

  const hints = [
    [/(foto|imagem|cat[aá]logo|mostra)/, 'catalogo visual'],
    [/(tamanho|grade)/, 'grade e tamanhos'],
    [/(quantidade|kit|d[uú]zia|pacote)/, 'quantidade'],
    [/(pre[cç]o|valor)/, 'preco'],
    [/(carrinho|pedido|fechar|finalizar)/, 'fechamento'],
    [/(atendente|humano|consultor)/, 'atendimento humano'],
  ];

  hints.forEach(([regex, label]) => {
    if (regex.test(src)) topics.push(label);
  });

  return topics;
}

function detectIntent(text) {
  const src = (text || '').toLowerCase().trim();
  if (!src) return '';

  const rules = [
    [/(limpar|esvaziar).*(carrinho)|carrinho.*(limpar|esvaziar)/, 'quer zerar o carrinho'],
    [/(finaliz|fechar pedido|encaminha|pagar|pagamento|checkout)/, 'quer fechar o pedido'],
    [/(remov|tirar).*(carrinho|item)|carrinho.*(remov|tirar)/, 'quer ajustar o carrinho'],
    [/(mais foto|ver foto|outra foto|tem foto|tem mais|mostrar mais)/, 'quer analisar melhor um produto'],
    [/(comprar|separar|quero esse|quero essa|manda esse|leva esse)/, 'quer separar produtos'],
    [/(tamanho|grade)/, 'quer definir tamanho'],
    [/(quantidade|qtd|duas|duzia|pacote|\b\d+\b)/, 'quer definir quantidade'],
    [/(categoria|feminino|masculino|infantil|lan[cç]amento|novidade|catalogo|cat[aá]logo|ver mais)/, 'quer ver mais produtos'],
    [/(pre[cç]o|valor|quanto)/, 'quer avaliar preco'],
  ];

  for (const [regex, label] of rules) {
    if (regex.test(src)) return label;
  }

  return '';
}

function describeAction(action) {
  if (!action?.type) return '';

  const payload = action.payload ? String(action.payload) : '';
  const labels = {
    VER_TODOS: payload ? `mostrando todos os produtos de ${payload}` : 'mostrando todos os produtos',
    VER: payload ? `mostrando categoria ${payload}` : 'mostrando categoria',
    BUSCAR: payload ? `buscando produtos por "${payload}"` : 'buscando produtos',
    PROXIMOS: 'mostrando mais produtos',
    FOTOS: payload ? `abrindo fotos do produto ${payload}` : 'abrindo fotos do produto',
    SELECIONAR: payload ? `iniciando compra do produto ${payload}` : 'iniciando compra',
    TAMANHO: payload ? `registrando tamanho ${payload}` : 'registrando tamanho',
    QUANTIDADE: payload ? `registrando quantidade ${payload}` : 'registrando quantidade',
    CARRINHO: 'mostrando carrinho',
    REMOVER: payload ? `removendo item ${payload}` : 'removendo item',
    HANDOFF: 'encaminhando para fechamento',
    LIMPAR_CARRINHO: 'esvaziando o carrinho',
    COMPRAR_DIRETO: 'montando item direto por texto',
  };

  return labels[action.type] || action.type;
}

function detectStage(session, memory) {
  const pfState = session.purchaseFlow?.state;

  if (pfState === 'awaiting_size') return 'definindo tamanho';
  if (pfState === 'awaiting_quantity') return 'definindo quantidade';
  if (pfState === 'awaiting_more_sizes') return 'decidindo outros tamanhos';
  if (memory.currentIntent === 'quer fechar o pedido') return 'fechamento';
  if (session.items?.length > 0) return 'carrinho ativo';
  if (session.products?.length > 0) return 'explorando catalogo';
  if (memory.turnCount > 0) return 'atendimento em andamento';
  return 'inicio';
}

function buildPendingFollowUp(session, memory) {
  const pf = session.purchaseFlow || {};

  if (pf.state === 'awaiting_size' && pf.productName) {
    return `cliente precisa escolher o tamanho de ${pf.productName}`;
  }

  if (pf.state === 'awaiting_quantity' && pf.productName && pf.selectedSize) {
    return `cliente precisa informar a quantidade de ${pf.productName} no tamanho ${pf.selectedSize}`;
  }

  if (pf.state === 'awaiting_more_sizes' && pf.productName) {
    return `confirmar se cliente quer outro tamanho de ${pf.productName}`;
  }

  if (memory.currentIntent === 'quer zerar o carrinho') {
    return 'confirmar o esvaziamento do carrinho e retomar a venda';
  }

  if (memory.currentIntent === 'quer fechar o pedido') {
    return 'encaminhar para fechamento sem perder o tom comercial';
  }

  if (session.items?.length > 0) {
    return 'estimular proximo passo: continuar comprando, revisar carrinho ou finalizar';
  }

  if (session.products?.length > 0) {
    return 'ajudar cliente a escolher uma das pecas ja mostradas ou abrir outra categoria';
  }

  return 'manter a conversa avancando para selecao de produtos';
}

function buildSummary(memory, session) {
  const parts = [];

  if (memory.stage) parts.push(`Etapa: ${memory.stage}`);
  if (memory.currentIntent) parts.push(`Intencao atual: ${memory.currentIntent}`);
  if (memory.preferences.length > 0) parts.push(`Preferencias: ${memory.preferences.join(', ')}`);
  if (memory.objections.length > 0) parts.push(`Obstaculos: ${memory.objections.join(', ')}`);
  if (session.items?.length > 0) parts.push(`Carrinho com ${session.items.length} item(ns)`);
  if (memory.pendingFollowUp) parts.push(`Pendencia: ${memory.pendingFollowUp}`);

  return sanitizeSnippet(parts.join('. '), 320);
}

function refreshConversationMemory(session, update = {}) {
  const memory = session.conversationMemory || createDefaultConversationMemory();

  if (update.reset) {
    session.conversationMemory = createDefaultConversationMemory();
    return session.conversationMemory;
  }

  if (update.userText) {
    memory.turnCount += 1;
    memory.lastUserMessage = sanitizeSnippet(update.userText);

    const intent = detectIntent(update.userText);
    if (intent) memory.currentIntent = intent;

    memory.preferences = pushUnique(memory.preferences, detectPreferences(update.userText));
    memory.objections = pushUnique(memory.objections, detectObjections(update.userText), 4);
    memory.discussedTopics = pushUnique(memory.discussedTopics, detectDiscussedTopics(update.userText), 6);
  }

  if (update.assistantText) {
    memory.lastAssistantMessage = sanitizeSnippet(update.assistantText);
  }

  if (update.action) {
    const actionLabel = describeAction(update.action);
    if (actionLabel) memory.lastSystemAction = actionLabel;
  }

  memory.stage = detectStage(session, memory);
  memory.pendingFollowUp = buildPendingFollowUp(session, memory);
  memory.summary = buildSummary(memory, session);
  memory.updatedAt = Date.now();

  session.conversationMemory = memory;
  return memory;
}

function buildConversationContext(session) {
  const memory = session.conversationMemory || createDefaultConversationMemory();
  const lines = [
    'MEMORIA DO ATENDIMENTO:',
    `- Etapa atual: ${memory.stage || 'inicio'}`,
    `- Intencao mais recente do cliente: ${memory.currentIntent || 'ainda nao definida'}`,
    `- Pendencia atual: ${memory.pendingFollowUp || 'nenhuma pendencia critica'}`,
  ];

  if (memory.preferences.length > 0) {
    lines.push(`- Preferencias detectadas: ${memory.preferences.join(', ')}`);
  }

  if (memory.objections.length > 0) {
    lines.push(`- Objecoes ou travas: ${memory.objections.join(', ')}`);
  }

  if (memory.discussedTopics.length > 0) {
    lines.push(`- Assuntos ja tratados: ${memory.discussedTopics.join(', ')}`);
  }

  if (session.customerName) {
    lines.push(`- Nome salvo do cliente: ${session.customerName}`);
  }

  if (session.items?.length > 0) {
    const cartList = session.items
      .slice(-3)
      .map(item => `${item.productName} (${item.size}) x${item.quantity}`)
      .join('; ');
    lines.push(`- Carrinho atual: ${session.items.length} item(ns). Ultimos itens: ${cartList}`);
  }

  if (memory.lastUserMessage) {
    lines.push(`- Ultima fala relevante do cliente: ${memory.lastUserMessage}`);
  }

  if (memory.lastSystemAction) {
    lines.push(`- Ultima acao do sistema: ${memory.lastSystemAction}`);
  }

  if (memory.summary) {
    lines.push(`- Resumo vivo: ${memory.summary}`);
  }

  if (memory.archivedSummary) {
    lines.push(`- Historico comprimido (turnos fora da janela de 20min): ${memory.archivedSummary}`);
  }

  lines.push('- Regra de continuidade: trate a conversa como CONTINUA dentro da janela ativa da sessao; nao reinicie o atendimento por causa de uma saudacao curta.');

  return lines.join('\n');
}

module.exports = {
  buildConversationContext,
  createDefaultConversationMemory,
  refreshConversationMemory,
  archiveStaleTurns,
};
