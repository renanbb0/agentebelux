/**
 * services/agent-v2/tools.js
 *
 * Declarações de tools (Function Calling) para a Bela V2 — Agentic AI.
 *
 * SUBSTITUI: os 15 colchetes regex de services/gemini.js::parseAction()
 *   [VER_TODOS:x], [TAMANHO:x], [HANDOFF], etc.
 *
 * Cada tool é uma função que a IA pode chamar nativamente. O Gemini SDK
 * recebe esse esquema e devolve `functionCall: { name, args }` quando decide
 * agir, em vez de produzir texto com colchetes que precisam de regex parsing.
 *
 * REGRA: nada aqui executa nada. Isto é apenas o CONTRATO.
 * A execução real fica em services/agent-v2/tool-executor.js.
 */

const TOOLS_SCHEMA = [{
  functionDeclarations: [
    // ───────────────────────────────────────────────────────────────
    // CATÁLOGO E NAVEGAÇÃO
    // ───────────────────────────────────────────────────────────────
    {
      name: 'displayCatalog',
      description:
        'Exibe um catálogo de produtos para o cliente. Use quando o cliente '
        + 'pedir para ver lançamentos, ofertas, ou todos os produtos de uma '
        + 'linha geral. NÃO use para responder dúvidas, comparações de preço, '
        + 'ou perguntas sobre tecido/entrega — para isso responda em texto.',
      parameters: {
        type: 'OBJECT',
        properties: {
          slug: {
            type: 'STRING',
            description:
              'Identificador do catálogo. Exemplos: "lancamento-da-semana", '
              + '"mais-vendidos", "promocao". Default: "lancamento-da-semana".',
          },
        },
      },
    },
    {
      name: 'displayCategory',
      description:
        'Exibe produtos de uma categoria específica. Use apenas quando o '
        + 'cliente pedir explicitamente uma categoria (feminino, masculino, '
        + 'infantil).',
      parameters: {
        type: 'OBJECT',
        properties: {
          category: {
            type: 'STRING',
            enum: ['feminino', 'masculino', 'femininoinfantil', 'masculinoinfantil', 'infantil'],
            description: 'Slug da categoria',
          },
        },
        required: ['category'],
      },
    },
    {
      name: 'searchProduct',
      description:
        'Busca produtos por termo livre. Use quando o cliente menciona um '
        + 'tipo específico (pijama, sutiã, calcinha) ou referência (REF696).',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'Termo de busca' },
        },
        required: ['query'],
      },
    },
    {
      name: 'nextPage',
      description: 'Avança para a próxima página de produtos do catálogo atual.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'showProductPhotos',
      description:
        'Envia fotos adicionais do produto que está sendo visualizado. Use '
        + 'quando cliente pede "mais fotos" ou "fotos detalhadas".',
      parameters: {
        type: 'OBJECT',
        properties: {
          productIndex: {
            type: 'INTEGER',
            description: 'Índice do produto no catálogo atual (1-based)',
          },
        },
        required: ['productIndex'],
      },
    },

    // ───────────────────────────────────────────────────────────────
    // FLUXO DE COMPRA
    // ───────────────────────────────────────────────────────────────
    {
      name: 'selectProduct',
      description:
        'Seleciona um produto do catálogo para iniciar o fluxo de compra. '
        + 'Use quando cliente diz "quero esse", "vou levar o 2", etc.',
      parameters: {
        type: 'OBJECT',
        properties: {
          productIndex: { type: 'INTEGER', description: 'Índice do produto (1-based)' },
        },
        required: ['productIndex'],
      },
    },
    {
      name: 'selectVariant',
      description:
        'Seleciona uma variante (ex: Mãe, Filha) de um produto que tem '
        + 'múltiplas variações. Use APENAS quando o produto exige escolha '
        + 'de variante.',
      parameters: {
        type: 'OBJECT',
        properties: {
          variant: { type: 'STRING', description: 'Nome da variante (ex: "Mãe")' },
        },
        required: ['variant'],
      },
    },
    {
      name: 'selectSize',
      description:
        'Define o tamanho escolhido para o produto em foco. Aceita '
        + 'múltiplos formatos: "M", "G", "GG", "EXG", numéricos (40-60).',
      parameters: {
        type: 'OBJECT',
        properties: {
          size: { type: 'STRING', description: 'Tamanho escolhido' },
        },
        required: ['size'],
      },
    },
    {
      name: 'setQuantity',
      description:
        'Define a quantidade desejada para o tamanho atual em compra.',
      parameters: {
        type: 'OBJECT',
        properties: {
          quantity: { type: 'INTEGER', description: 'Quantidade (≥1)' },
        },
        required: ['quantity'],
      },
    },
    {
      name: 'addToCart',
      description:
        'Adiciona um item completo ao carrinho de uma vez (atalho). Use '
        + 'quando o cliente forneceu produto, tamanho e quantidade na mesma '
        + 'mensagem. Se faltar variante e o produto exigir, peça antes.',
      parameters: {
        type: 'OBJECT',
        properties: {
          productIndex: { type: 'INTEGER', description: 'Índice no catálogo' },
          variant:      { type: 'STRING', description: 'Variante (opcional)' },
          size:         { type: 'STRING', description: 'Tamanho' },
          quantity:     { type: 'INTEGER', description: 'Quantidade' },
        },
        required: ['productIndex', 'size', 'quantity'],
      },
    },
    {
      name: 'skipCurrentProduct',
      description:
        'Pula o produto atual da fila de compra. Use quando cliente diz '
        + '"esse não" ou "pula esse" durante uma sequência de produtos.',
      parameters: { type: 'OBJECT', properties: {} },
    },

    // ───────────────────────────────────────────────────────────────
    // CARRINHO
    // ───────────────────────────────────────────────────────────────
    {
      name: 'viewCart',
      description: 'Mostra os itens atuais do carrinho do cliente.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'removeFromCart',
      description: 'Remove um item específico do carrinho pelo índice.',
      parameters: {
        type: 'OBJECT',
        properties: {
          itemIndex: { type: 'INTEGER', description: 'Índice do item (1-based)' },
        },
        required: ['itemIndex'],
      },
    },
    {
      name: 'clearCart',
      description: 'Esvazia totalmente o carrinho. Use quando cliente '
        + 'pedir explicitamente para começar de novo.',
      parameters: { type: 'OBJECT', properties: {} },
    },

    // ───────────────────────────────────────────────────────────────
    // FINALIZAÇÃO E HANDOFF
    // ───────────────────────────────────────────────────────────────
    {
      name: 'finalizeOrder',
      description:
        'Finaliza o pedido e transfere para a vendedora humana com o '
        + 'resumo do carrinho. Use quando cliente disser "fechar pedido", '
        + '"pode finalizar", "é isso mesmo".',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'requestHumanHandoff',
      description:
        'Transfere a conversa para uma vendedora humana SEM finalizar '
        + 'pedido. Use IMEDIATAMENTE quando cliente pedir falar com '
        + 'pessoa/atendente/vendedora, OU quando você não conseguir '
        + 'resolver e precisar de ajuda humana. NUNCA insista em vender '
        + 'depois que o cliente pediu humano.',
      parameters: {
        type: 'OBJECT',
        properties: {
          reason: {
            type: 'STRING',
            description: 'Motivo da transferência (ex: "cliente_pediu", '
              + '"duvida_logistica", "fora_do_escopo")',
          },
        },
        required: ['reason'],
      },
    },
  ],
}];

// Lista plana dos nomes para validação rápida
const TOOL_NAMES = TOOLS_SCHEMA[0].functionDeclarations.map(t => t.name);

// Mapeamento de tool V2 → ação legacy V1 (para análise comparativa em modo sombra)
const TOOL_TO_LEGACY_ACTION = {
  displayCatalog:      'VER_TODOS',
  displayCategory:     'VER',
  searchProduct:       'BUSCAR',
  nextPage:            'PROXIMOS',
  showProductPhotos:   'FOTOS',
  selectProduct:       'SELECIONAR',
  selectVariant:       'VARIANTE',
  selectSize:          'TAMANHO',
  setQuantity:         'QUANTIDADE',
  addToCart:           'COMPRAR_DIRETO',
  skipCurrentProduct:  'SKIP_MORE',
  viewCart:            'CARRINHO',
  removeFromCart:      'REMOVER',
  clearCart:           'LIMPAR_CARRINHO',
  finalizeOrder:       'HANDOFF',
  requestHumanHandoff: 'HANDOFF',
};

module.exports = {
  TOOLS_SCHEMA,
  TOOL_NAMES,
  TOOL_TO_LEGACY_ACTION,
};
