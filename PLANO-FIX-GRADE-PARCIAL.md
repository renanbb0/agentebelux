# Plano de Implementação — Bugs Identificados (Abril 2026)

## Diagnóstico

### O Bug
Quando o cliente digita uma grade com múltiplos tamanhos (ex: `3p 2M 1p`), o bot adiciona apenas **parte** dos tamanhos ao carrinho, sem nenhum aviso sobre os ignorados.

**Evidência:**
- Produto 1 (Pijama bordado - Ref 503L): cliente digitou `3p 2M 1p` → bot adicionou apenas **(M) x2** — ignorou 4P
- Produto 2 (Conjunto Basico Chocolate - Ref 422): cliente digitou `2p 1M` → bot adicionou apenas **(P) x2** — ignorou 1M

### Causa Raiz

**Arquivo:** `index.js`, linhas 616-618

```javascript
const focusedSizes = getAvailableSizesForSession(session, focusedProduct);
const grade = parseGradeText(text, focusedSizes);
```

`getAvailableSizesForSession` filtra tamanhos marcados como **indisponíveis** no estoque do WooCommerce (`isAvailable === false`). O array `focusedSizes` resultante é passado como `knownSizes` para `parseGradeText`.

Dentro de `parseGradeText` (linha 33), os `knownSizes` são usados para:
1. Construir o **regex pattern** (`sizesPattern`) — tamanhos ausentes sequer são procurados
2. Validar no `addGradeEntry` via `knownSizesUpper.has(size)`

**Consequência:** se P está fora de estoque, o regex é montado como `(M|G|GG)`. O texto `3p` nunca casa com nada. O parser retorna `[{size: "M", qty: 2}]` e o bot confirma "Grade separada!" como se tudo estivesse OK.

### Por Que É Grave
- O cliente **não recebe feedback** sobre tamanhos ignorados
- A mensagem "✅ Grade separada!" transmite **falsa confiança** de que o pedido está completo
- Em contexto B2B (lojistas), uma grade errada = prejuízo real

---

## Plano de Implementação

### Passo 1 — Separar parsing de validação de estoque

**Onde:** `index.js`, bloco do grade parser (linhas ~614-670)

**Mudança conceitual:** usar TODOS os tamanhos do produto (incluindo indisponíveis) para o parsing, e só depois checar estoque.

```javascript
// ANTES (bugado):
const focusedSizes = getAvailableSizesForSession(session, focusedProduct);
const grade = parseGradeText(text, focusedSizes);

// DEPOIS (correto):
const allSizes = focusedProduct.sizes || [];  // TODOS os tamanhos, sem filtro de estoque
const availableSizes = getAvailableSizesForSession(session, focusedProduct);
const grade = parseGradeText(text, allSizes);
```

Isso garante que `parseGradeText` reconhece **todos** os tamanhos que o produto possui, independente do estoque.

### Passo 2 — Classificar os itens da grade em 3 categorias

Após o parsing, cada item da grade deve ser classificado:

```javascript
if (grade) {
  const addable = [];       // tamanho disponível, estoque OK
  const unavailable = [];   // tamanho existe mas está indisponível (estoque 0)
  const unknown = [];       // tamanho não existe no produto (ex: digitou "XG" num produto que só tem P/M/G)

  for (const { size, qty } of grade) {
    const upperSize = size.toUpperCase();
    const matchedSize = allSizes.find(s => s.toUpperCase() === upperSize);

    if (!matchedSize) {
      unknown.push({ size, qty });
      continue;
    }

    const availability = getSizeAvailability(session, focusedProduct, matchedSize);

    if (availability?.isAvailable === false) {
      unavailable.push({ size: matchedSize, qty, available: availability.availableQuantity || 0 });
      continue;
    }

    // Checar se qty excede estoque (quando estoque é gerenciado)
    if (availability && typeof availability.availableQuantity === 'number' && qty > availability.availableQuantity) {
      unavailable.push({ size: matchedSize, qty, available: availability.availableQuantity });
      continue;
    }

    addable.push({ size: matchedSize, qty });
  }
}
```

### Passo 3 — Adicionar os itens viáveis e avisar sobre os problemáticos

Substituir o bloco atual (linhas ~625-666) pela lógica de 3 vias:

```javascript
// 1. Adicionar ao carrinho os tamanhos viáveis
const addedItems = [];
for (const { size, qty } of addable) {
  pushCartItem(session, focusedProduct.id, focusedProduct.name, size, qty, unitPrice, focusedProduct.imageUrl || null);
  addedItems.push({ size, qty });
}

// 2. Montar mensagem de confirmação
const parts = [];

if (addedItems.length > 0) {
  const gradeLines = addedItems.map(({ size, qty }) =>
    `• ${focusedProduct.name} (${size}) x${qty}`
  ).join('\n');
  const cartTotal = session.items.reduce((acc, it) => acc + parseFloat(it.price || 0), 0);
  const { lineItems, totalPieces } = getCartStats(session);
  parts.push(`✅ Grade separada!\n${gradeLines}\n\n🛒 Carrinho: ${totalPieces} ${totalPieces === 1 ? 'peça' : 'peças'} em ${lineItems} ${lineItems === 1 ? 'item' : 'itens'} — *${woocommerce.formatPrice(cartTotal)}*`);
}

// 3. Avisar sobre tamanhos indisponíveis
if (unavailable.length > 0) {
  const unavailLines = unavailable.map(({ size, qty, available }) =>
    available > 0
      ? `• ${size}: pediu ${qty}, só tem ${available} disponível`
      : `• ${size}: indisponível no momento`
  ).join('\n');
  parts.push(`⚠️ Não consegui incluir:\n${unavailLines}`);
}

// 4. Avisar sobre tamanhos desconhecidos
if (unknown.length > 0) {
  const unknownList = unknown.map(u => u.size).join(', ');
  const validList = allSizes.join(', ');
  parts.push(`❓ Tamanho(s) *${unknownList}* não existe(m) neste produto. Disponíveis: *${validList}*`);
}

// 5. Se NADA foi adicionado, orientar o cliente
if (addedItems.length === 0) {
  parts.push(`Me manda as quantidades ajustadas ou escolhe pela lista abaixo 😊`);
}

const confirmMsg = parts.join('\n\n');
```

### Passo 4 — Ajustar o estado da FSM pós-grade

A lógica de estado após o processamento deve considerar se algo foi adicionado ou não:

```javascript
if (addedItems.length > 0) {
  // Fluxo normal: grade (parcial ou total) adicionada
  pfGrade.state = 'awaiting_more_sizes';
  pfGrade.selectedSize = null;
  if (!Array.isArray(pfGrade.addedSizes)) pfGrade.addedSizes = [];
  session.currentProduct = focusedProduct;
  const remainingSizes = getAvailableSizesForSession(session, focusedProduct, pfGrade.addedSizes || []);
  await sendPostAddMenu(from, session, remainingSizes, confirmMsg);
} else {
  // Nada adicionado — manter em awaiting_size e reenviar lista
  pfGrade.state = 'awaiting_size';
  pfGrade.interactiveVersion = Date.now();
  session.currentProduct = focusedProduct;
  await zapi.sendText(from, confirmMsg);
  await sendStockAwareSizeList(from, session, focusedProduct, pfGrade.interactiveVersion, pfGrade.addedSizes || []);
}
```

### Passo 5 — Aplicar a mesma correção no grade parser de "produto citado" (idle)

**Onde:** `index.js`, linhas ~993-1030 (bloco `gradeFromQuote`)

O mesmo bug existe neste trecho:
```javascript
const gradeFromQuote = parseGradeText(text, quotedSizes);
```

`quotedSizes` provavelmente também vem filtrado. Aplicar a mesma lógica de 3 vias.

### Passo 6 — Remover `getGradeStockIssues` (obsoleta)

A função `getGradeStockIssues` (linha 1608) e `sendGradeStockWarning` (linha 1631) tornam-se obsoletas, pois a validação de estoque agora é feita inline no Passo 2. Remover ambas para evitar código morto.

### Passo 7 — Adicionar logging diagnóstico

No grade parser, adicionar log que mostra a comparação entre o que foi pedido e o que foi adicionado:

```javascript
logger.info({
  from,
  product: pfGrade.productName,
  allSizes,
  availableSizes,
  gradeRequested: grade,
  addable,
  unavailable,
  unknown,
}, '[Grade] Resultado do parsing com validação de estoque');
```

### Passo 8 — Verificação e Teste

1. Testar com produto que tem tamanhos P, M, G onde P está fora de estoque:
   - Input: `3p 2M 1G` → Esperado: M x2 + G x1 adicionados + aviso "P: indisponível"
2. Testar grade completa com tudo disponível:
   - Input: `3p 2M` → Esperado: P x3 + M x2 adicionados, sem avisos
3. Testar grade com tamanho inexistente:
   - Input: `3XG 2M` → Esperado: M x2 adicionado + aviso "XG não existe neste produto"
4. Testar grade onde TUDO está indisponível:
   - Esperado: nada adicionado + aviso completo + reenvia lista de tamanhos

---

## Resumo das Mudanças

| Arquivo | Linhas | Mudança |
|---------|--------|---------|
| `index.js` | ~614-670 | Refatorar grade parser principal (Passos 1-4) |
| `index.js` | ~993-1030 | Refatorar grade parser de citação (Passo 5) |
| `index.js` | ~1608-1648 | Remover `getGradeStockIssues` + `sendGradeStockWarning` (Passo 6) |
| `index.js` | (novo log) | Adicionar logging diagnóstico (Passo 7) |

## Arquivos do Obsidian a Atualizar (Bug 1)

| Arquivo | Atualização |
|---------|-------------|
| `07 - Histórico e Migrações.md` | ADR: "Grade parser agora usa todos os tamanhos do produto e avisa sobre indisponíveis" |
| `01 - Fluxo de Vendas.md` | Atualizar seção de grade com o novo comportamento de feedback |
| `08 - Tarefas e Bugs Pendentes.md` | Marcar como resolvido |

---

# Bug 2 — Vitrine de Categoria: Listagem Redundante, Slug Cru, TTS Offline

## Diagnóstico

### Problemas Identificados (3 screenshots da categoria MASCULINOINFANTIL)

1. **Mensagem de loading com slug cru:** `"🔍 Buscando produtos MASCULINOINFANTIL..."` — slug técnico aparecendo direto pro cliente. Deveria ser "Masculino Infantil" em linguagem natural.
2. **Lista numerada de texto redundante:** Tanto `sendProductPage` (linha 2643) quanto `showAllCategory` (linha 2528) enviam uma mensagem de texto com todos os produtos listados ANTES dos cards com foto. Essa lista é desnecessária — os cards já mostram nome, preço e botão "Comprar".
3. **TTS não está funcionando:** `TTS_ENABLED=true` no `.env`, API key e voice ID configurados, mas o áudio não está sendo enviado. O `sendLoadingMessage` (linha 1548) tenta TTS, falha silenciosamente, e cai no fallback texto. Causa provável: API key expirada, créditos ElevenLabs zerados, ou erro na chamada.
4. **Produtos adultos em categoria infantil:** "Pijama Masculino Adulto- Ref 672s" aparece em MASCULINOINFANTIL — isso é problema de cadastro no WooCommerce, não de código.
5. **Produtos duplicados:** itens 1 e 2 idênticos na lista — a deduplicação (`deduplicateProducts` em `woocommerce.js`) deveria filtrar, mas pode não estar sendo chamada neste fluxo.

---

## Plano de Implementação

### Passo 1 — Criar mapa de nomes amigáveis para categorias

**Onde:** `index.js`, próximo ao `SLUG_MAP` existente (linha ~87)

```javascript
const CATEGORY_DISPLAY_NAMES = {
  'feminino':              'Feminino',
  'femininoinfantil':      'Feminino Infantil',
  'masculino':             'Masculino',
  'masculinoinfantil':     'Masculino Infantil',
  'lancamento-da-semana':  'Lançamentos da Semana',
};

function getCategoryDisplayName(slug) {
  return CATEGORY_DISPLAY_NAMES[slug] || slug;
}
```

### Passo 2 — Substituir slugs crus nas mensagens

**Onde:** Todas as funções que exibem o slug para o cliente.

**`showCategory` (linha 2464):**
```javascript
// ANTES:
`🔍 Buscando produtos *${slug.toUpperCase()}*...`

// DEPOIS:
`🔍 Buscando os melhores modelos de *${getCategoryDisplayName(slug)}* pra você...`
```

**`showAllCategory` (linha 2496):**
```javascript
// ANTES:
`✨ *${slug.toUpperCase()}* ✨\n\n`

// DEPOIS — esta mensagem será REMOVIDA no Passo 3
```

**`sendProductPage` (linha 2643):**
```javascript
// ANTES:
`📦 *${session.currentCategory.toUpperCase()}* — Produtos ${startIdx + 1}–...`

// DEPOIS — esta mensagem será REMOVIDA no Passo 3
```

**Qualquer outra mensagem que exibe `slug.toUpperCase()` direto** — buscar com grep e substituir.

### Passo 3 — Remover listagem de texto redundante

**Onde:** `sendProductPage` (linhas 2643-2651) e `showAllCategory` (linhas 2528-2535)

O objetivo é **não enviar mais a lista numerada de texto** antes dos cards. Os cards com foto + nome + preço + botão "Comprar" são suficientes.

**`sendProductPage`** — remover o bloco:
```javascript
// REMOVER estas linhas:
let msg = `📦 *${session.currentCategory.toUpperCase()}* — Produtos ${startIdx + 1}–${session.products.length} de ${result.total}:\n`;
result.products.forEach((p, i) => {
  const price = woocommerce.formatPrice(p.salePrice || p.price);
  msg += `${startIdx + i + 1}. *${p.name}* — ${price}\n`;
});
await zapi.sendText(phone, msg);
```

**`showAllCategory`** — remover o bloco análogo (linhas 2528-2535):
```javascript
// REMOVER:
let msg = `✨ *${slug.toUpperCase()}* ✨\n\n`;
allProducts.forEach((p, i) => {
  const price = woocommerce.formatPrice(p.salePrice || p.price);
  msg += `${i + 1}. *${p.name}* — ${price}\n`;
});
await zapi.sendText(phone, msg);
```

### Passo 4 — Melhorar mensagem de loading + garantir TTS

**`showCategory` (linha 2468):**
```javascript
await sendLoadingMessage(
  phone,
  `Um momento, amor! Já estou separando os melhores modelos de ${getCategoryDisplayName(slug)} pra você! 😊`,
  `Um momento, amor! Já estou separando os melhores modelos de ${getCategoryDisplayName(slug)} pra você!`
);
```

**`showAllCategory` (linha 2499):**
```javascript
await sendLoadingMessage(
  phone,
  `Um momento, amor! Estou separando todos os modelos de ${getCategoryDisplayName(slug)} pra você! 😊`,
  `Um momento, amor! Estou separando todos os modelos de ${getCategoryDisplayName(slug)} pra você!`
);
```

### Passo 5 — Diagnosticar e corrigir TTS (ElevenLabs)

O TTS está configurado mas falhando silenciosamente. Passos:

1. **Adicionar log detalhado no catch do `sendLoadingMessage`:**
```javascript
if (TTS_ENABLED) {
  try {
    const { buffer, mimeType } = await tts.textToSpeech(ttsPhrase);
    await zapi.sendAudio(phone, buffer, mimeType);
    return;
  } catch (err) {
    logger.error({
      err: err?.message || String(err),
      stack: err?.stack,
      ttsPhrase: ttsPhrase.slice(0, 80),
    }, '[TTS] Fallback to text — INVESTIGAR CAUSA');
  }
}
```

2. **Testar a API do ElevenLabs isoladamente:**
```bash
# Teste manual via curl
curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/ORgG8rwdAiMYRug8RJwR" \
  -H "xi-api-key: sk_29e0564..." \
  -H "Content-Type: application/json" \
  -d '{"text":"teste","model_id":"eleven_multilingual_v2"}' \
  --output test.mp3
```

3. **Verificar saldo/plano do ElevenLabs** no painel: https://elevenlabs.io/app/subscription

4. **Verificar se `sendAudio` da Z-API aceita o formato retornado.** Pode ser que o buffer mp3 do ElevenLabs não esteja compatível com o que `zapi.sendAudio` espera (base64 vs buffer).

### Passo 6 — Garantir deduplicação na vitrine

**Onde:** `showCategory` e `showAllCategory`

Verificar se `deduplicateProducts` (em `woocommerce.js`) está sendo aplicado após buscar os produtos. Se não está, adicionar:

```javascript
// Em showAllCategory, após agregar todas as páginas:
allProducts = deduplicateProducts(allProducts);

// Em showCategory / sendProductPage:
result.products = deduplicateProducts(result.products);
```

**Nota:** a deduplicação resolve duplicatas por ID. Produtos adultos em categoria infantil é problema de **cadastro no WooCommerce** — avisar Renan para corrigir manualmente no painel.

### Passo 7 — Verificação

1. Testar `showCategory` com uma categoria — confirmar que:
   - Mensagem de loading mostra nome amigável (não slug)
   - Lista numerada NÃO é enviada
   - Cards com foto são enviados normalmente
   - Áudio TTS é enviado (se ElevenLabs estiver funcionando)
2. Testar `showAllCategory` — mesmas verificações
3. Verificar que não há duplicatas nos cards
4. Confirmar que o follow-up da IA ainda funciona após remoção da lista

---

## Resumo das Mudanças (Bug 2)

| Arquivo | Mudança |
|---------|---------|
| `index.js` ~87 | Criar `CATEGORY_DISPLAY_NAMES` + `getCategoryDisplayName()` |
| `index.js` `showCategory` | Substituir slug cru por nome amigável na mensagem de loading |
| `index.js` `showAllCategory` | Remover listagem de texto, melhorar loading |
| `index.js` `sendProductPage` | Remover listagem de texto redundante |
| `index.js` `sendLoadingMessage` | Melhorar logging de erro do TTS |
| `services/tts.js` ou `.env` | Diagnosticar/corrigir falha do ElevenLabs |
| `services/woocommerce.js` | Garantir deduplicação nos fluxos de vitrine |

## Nota sobre Cadastro WooCommerce

⚠️ Os seguintes problemas são de **dados, não de código** — corrigir no painel WooCommerce:
- "Pijama Masculino Adulto- Ref 672s" está cadastrado na categoria MASCULINOINFANTIL (deveria estar em MASCULINO)
- Produto duplicado na mesma categoria (verificar se há dois cadastros com mesmo nome)

## Arquivos do Obsidian a Atualizar (Bug 2)

| Arquivo | Atualização |
|---------|-------------|
| `07 - Histórico e Migrações.md` | ADR: "Vitrine sem listagem de texto, nomes amigáveis de categoria, TTS investigado" |
| `04 - Serviço Z-API.md` | Atualizar se houver mudança no sendAudio |
| `14 - Serviço TTS.md` | Documentar diagnóstico e correção do ElevenLabs |

---

# Bug 3 — Seleção de Categoria Roteada para Categoria Errada (CRÍTICO)

## Diagnóstico

### O Bug
Usuário seleciona **"Feminino Infantil"** no menu de lista → bot responde com texto correto ("A linha feminino infantil é uma fofura...") → mas a vitrine mostra produtos de **LANCAMENTO-DA-SEMANA** (categoria completamente errada).

### Causa Raiz

**Arquivo:** `index.js`, `extractTextFromEvent`, linhas 352-359

Quando a cliente clica em `cat_feminino_infantil` na lista, o código converte para texto natural:

```javascript
if (listId === 'cat_feminino_infantil') return 'quero ver a linha feminino infantil';
```

Esse texto vai para o fluxo completo da IA (linha 1239), onde o Gemini interpreta a frase e decide qual action token gerar. **A IA está gerando `[VER_TODOS:lancamento-da-semana]` em vez de `[VER_TODOS:femininoinfantil]`** — roteamento errado.

### Por Que Acontece

A arquitetura é frágil: seleções determinísticas de menu são convertidas em linguagem natural e dependem da IA para re-interpretar. Qualquer ambiguidade no prompt ou no contexto pode fazer a IA escolher a categoria errada. Isso nunca deveria passar pela IA — é uma ação determinística.

### Evidência Adicional

O screenshot mostra que o texto da Bela ("A linha feminino infantil é uma fofura...") está correto — a IA entendeu a intenção. Mas o **action token** gerado foi para a categoria errada, mostrando que o mapeamento texto→slug está falhando no nível do token, não no nível da conversa.

---

## Plano de Implementação

### Passo 1 — Roteamento determinístico de categorias (NÃO passar pela IA)

**Onde:** `index.js`, `extractTextFromEvent` (linhas 352-359) + novo interceptor no webhook

**Conceito:** em vez de converter `cat_*` para texto e deixar a IA decidir, usar sentinelas determinísticos como já é feito com `CART_VIEW`, `FALAR_ATENDENTE`, etc.

**Mudança em `extractTextFromEvent`:**
```javascript
// ANTES (frágil — depende da IA):
if (listId === 'cat_feminina') return 'quero ver a linha feminina';
if (listId === 'cat_feminino_infantil') return 'quero ver a linha feminino infantil';
if (listId === 'cat_masculina') return 'quero ver a linha masculina';
if (listId === 'cat_masculino_infantil') return 'quero ver a linha masculino infantil';
if (listId === 'cat_lancamentos') return 'quero ver os lançamentos';

// DEPOIS (determinístico):
if (listId === 'cat_feminina') return 'CAT_FEMININO';
if (listId === 'cat_feminino_infantil') return 'CAT_FEMININOINFANTIL';
if (listId === 'cat_masculina') return 'CAT_MASCULINO';
if (listId === 'cat_masculino_infantil') return 'CAT_MASCULINOINFANTIL';
if (listId === 'cat_lancamentos') return 'CAT_LANCAMENTOS';
```

### Passo 2 — Interceptar sentinelas de categoria no webhook

**Onde:** `index.js`, no bloco de interceptores determinísticos (após linha ~530, junto com `CART_VIEW`, `VER_OUTRA_CATEGORIA`, etc.)

```javascript
// ── Roteamento determinístico de categorias ────────────────────────────
const CAT_SENTINELS = {
  'CAT_FEMININO':          'feminino',
  'CAT_FEMININOINFANTIL':  'femininoinfantil',
  'CAT_MASCULINO':         'masculino',
  'CAT_MASCULINOINFANTIL': 'masculinoinfantil',
  'CAT_LANCAMENTOS':       'lancamento-da-semana',
};

if (CAT_SENTINELS[text]) {
  const slug = CAT_SENTINELS[text];
  logger.info({ phone: from, slug }, '[Intercept] Seleção de categoria determinística');
  // Adiciona ao histórico da IA para manter contexto
  appendHistory(session, 'user', `quero ver a linha ${getCategoryDisplayName(slug)}`);
  conversationMemory.refreshConversationMemory(session, { userText: text });
  await showAllCategory(from, slug, session);
  persistSession(from);
  return;
}
```

**Vantagens:**
- Garante que a categoria correta é sempre chamada (zero dependência da IA)
- Mantém o histórico da IA atualizado para contexto futuro
- Mesmo padrão usado pelos outros interceptores (`CART_VIEW`, etc.)

### Passo 3 — Manter o texto natural para linguagem livre

A IA ainda precisa rotear categorias quando o **cliente digita em texto livre** (ex: "me mostra moda feminina", "quero ver coisa de menino"). Isso continua passando pela IA normalmente. Apenas as **seleções de menu** são determinísticas.

### Passo 4 — Verificação

1. Selecionar cada categoria no menu de lista → confirmar que a vitrine mostra a categoria correta:
   - Feminino → feminino
   - Feminino Infantil → femininoinfantil
   - Masculino → masculino
   - Masculino Infantil → masculinoinfantil
   - Lançamentos → lancamento-da-semana
2. Digitar em texto livre "quero ver feminino infantil" → confirmar que a IA ainda roteia corretamente
3. Confirmar que o histórico da IA mantém o contexto após seleção determinística

---

## Sobre as Duplicatas na Vitrine

Os "Pijama bordado - Ref 503L" repetidos 5x e "Pijama manga longa adulto - Ref 615S" 10x **não são duplicatas por ID** — são produtos WooCommerce distintos (IDs diferentes) com o mesmo nome. Provavelmente cada cor/estampa foi cadastrada como produto separado em vez de variação.

**Opções:**
- **WooCommerce (recomendado):** reestruturar para usar variações (1 produto com múltiplas opções de cor)
- **Código (paliativo):** adicionar deduplicação por nome além de por ID — mas isso esconderia produtos legítimos

---

## Resumo Geral — Todos os Bugs

| # | Bug | Gravidade | Causa | Fix |
|---|-----|-----------|-------|-----|
| 1 | Grade silenciosamente parcial | 🔴 Alta | `parseGradeText` usa apenas tamanhos em estoque | Parsear com TODOS os tamanhos, avisar sobre indisponíveis |
| 2 | Listagem de texto redundante + slug cru + TTS offline | 🟡 Média | `sendProductPage`/`showAllCategory` enviam lista de texto; slug sem humanização; ElevenLabs falhando | Remover lista, criar mapa de nomes, diagnosticar TTS |
| 3 | Categoria errada na seleção de menu | 🔴 Crítica | Seleção determinística convertida em texto para IA interpretar | Roteamento determinístico com sentinelas |
| — | Produtos adultos em categoria infantil | ⚪ Dados | Cadastro errado no WooCommerce | Corrigir no painel WooCommerce |
| — | Produtos com mesmo nome repetidos | ⚪ Dados | Cada cor/estampa é produto separado (não variação) | Reestruturar no WooCommerce |

## Arquivos do Obsidian a Atualizar (Bug 3)

| Arquivo | Atualização |
|---------|-------------|
| `07 - Histórico e Migrações.md` | ADR: "Seleções de categoria via menu agora são determinísticas — não passam pela IA" |
| `02 - Webhook e Roteamento.md` | Documentar os sentinelas CAT_* e o fluxo determinístico |
| `01 - Fluxo de Vendas.md` | Atualizar diagrama de roteamento de categorias |

---

# Bug 4 — FSM Bloqueia a IA: Bot Fica "Burro" em `awaiting_size` (CRÍTICO)

## Diagnóstico

### O Bug
Quando o bot está esperando a seleção de tamanho (`awaiting_size`), ele se torna completamente surdo a qualquer mensagem que não seja literalmente um tamanho. O bot reenvia roboticamente "Escolhe o tamanho pelo botão abaixo!" para TUDO:

- **Áudio** → transcrição não menciona tamanho → reenvia menu
- **"Tem a ref 621s?"** → busca por outro produto, ignorada → reenvia menu
- **"Tem a ref 602s?"** → idem, ignorada → reenvia menu

O cliente fica frustrado porque o bot não entende nada além de tamanhos.

### Causa Raiz

**Arquivo:** `index.js`, linhas 827-832

```javascript
} else {
  logger.info({ from, state: pfCheck.state }, '[FSM] Texto ambíguo em awaiting_size — re-enviando menu');
  await zapi.sendText(from, `😊 Escolhe o tamanho de *${pfCheck.productName}* pelo botão abaixo!`);
  await sendStockAwareSizeList(from, session, product, pfCheck.interactiveVersion);
  persistSession(from);
  return;  // ← BLOQUEIA TUDO que não é tamanho
}
```

O catch-all trata como "ambíguo" qualquer texto que:
1. Não é diretamente um nome de tamanho
2. Não menciona um tamanho como palavra isolada
3. Não é pedido de foto

**Por que "Tem a ref 621s?" não escapa:**
O `fsmEscaping` (linhas 770-778) checa `semanticQuick.wantsBrowse`, mas os patterns de `wantsBrowse` em `semantic.js` são:
```javascript
/\btem ai\b/, /\bquero ver\b/, /\bme mostra\b/, ...
```
"Tem a ref 621s?" não casa com nenhum. Não há pattern para buscas por referência (`/\bref\s*\d/`, `/\btem.*ref\b/`).

### O Mesmo Problema em `awaiting_more_sizes` (linha 853)

```javascript
} else {
  logger.info({ from, state: pfCheck.state }, '[FSM] Texto ambíguo em awaiting_more_sizes — re-enviando menu');
  await sendPostAddMenu(from, session, remainingSizes);
  persistSession(from);
  return;
}
```

---

## Plano de Implementação

### Filosofia da Correção

A Bela precisa ser **desenrolada**: quando está esperando um tamanho mas o cliente muda de assunto, ela deve entender e reagir. O princípio é: **a FSM só intercepta o que ela SABE resolver deterministicamente. O resto vai pra IA.**

### Passo 1 — Adicionar detecção de busca por referência no `semantic.js`

**Onde:** `services/semantic.js`, adicionar novo detector

```javascript
const wantsProductSearch = matchAny(normalized, [
  /\bref\s*\d/,             // "ref 621s", "ref 503L"
  /\breferencia\s*\d/,      // "referencia 621"
  /\btem\b.*\bref\b/,       // "tem a ref 621s?"
  /\btem\b.*\bpijama\b/,    // "tem pijama de..."
  /\btem\b.*\bcalcinha\b/,  // "tem calcinha..."
  /\btem\b.*\bconjunto\b/,  // "tem conjunto..."
  /\btem\b.*\bkit\b/,       // "tem kit..."
  /\bquero\s+outr/,         // "quero outro produto"
  /\boutr[oa]\s+pe[çc]a/,   // "outra peça"
  /\bprocur/,               // "procuro", "procurando"
  /\bbuscar?\b/,            // "busca", "buscar"
]);
```

Exportar no retorno de `analyzeUserMessage`:
```javascript
return { ..., wantsProductSearch };
```

### Passo 2 — Adicionar `wantsProductSearch` ao `fsmEscaping`

**Onde:** `index.js`, linha ~770

```javascript
const fsmEscaping = (
  semanticQuick.wantsClearCart
  || semanticQuick.wantsHuman
  || semanticQuick.wantsCancelFlow
  || semanticQuick.wantsCart
  || semanticQuick.wantsCheckout
  || semanticQuick.wantsBrowse
  || semanticQuick.wantsLaunches
  || semanticQuick.wantsMoreProducts
  || semanticQuick.wantsProductSearch   // ← NOVO
  || semanticQuick.categories.length > 0
);
```

### Passo 3 — Inverter a lógica do catch-all: IA como default, não bloqueio

**Onde:** `index.js`, linhas 827-832 e 853-856

A mudança conceitual é: em vez de bloquear tudo que não é tamanho, **deixar a IA responder** quando o texto parece ter intenção real (mais que 2-3 palavras). A FSM só bloqueia mensagens realmente curtas/ambíguas (tipo "ok", "sim", "hm").

```javascript
// ANTES (catch-all agressivo):
} else {
  await zapi.sendText(from, `😊 Escolhe o tamanho de *${pfCheck.productName}* pelo botão abaixo!`);
  await sendStockAwareSizeList(from, session, product, pfCheck.interactiveVersion);
  persistSession(from);
  return;
}

// DEPOIS (inteligente):
} else {
  // Mensagens curtas sem intenção clara → re-prompt educado
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount <= 2) {
    logger.info({ from, text, state: pfCheck.state }, '[FSM] Texto curto ambíguo em awaiting_size — re-enviando menu');
    await zapi.sendText(from, `😊 Escolhe o tamanho de *${pfCheck.productName}* pelo botão abaixo!`);
    await sendStockAwareSizeList(from, session, product, pfCheck.interactiveVersion);
    persistSession(from);
    return;
  }

  // Mensagens com 3+ palavras → provavelmente têm intenção real
  // Resetar FSM para idle e deixar a IA processar com contexto completo
  logger.info({ from, text, state: pfCheck.state }, '[FSM] Texto com intenção em awaiting_size — passando para IA');
  // Falls through to AI processing below
}
```

### Passo 4 — Melhorar o handling de áudio durante FSM ativa

**Onde:** `index.js`, bloco de STT (linhas ~438-448)

Quando um áudio é transcrito durante `awaiting_size`, o texto transcrito deveria seguir o mesmo fluxo inteligente. Verificar se a transcrição passa pelo grade parser e pelo escape hatch antes de cair no catch-all.

Adicionar log para debugging:
```javascript
if (session.purchaseFlow?.state !== 'idle') {
  logger.info({
    from,
    transcription: text.slice(0, 80),
    fsmState: session.purchaseFlow.state,
  }, '[STT] Áudio transcrito durante FSM ativa');
}
```

### Passo 5 — Garantir que o reset para idle preserva contexto

Quando o texto passa pelo escape hatch (Passo 3, mensagem com 3+ palavras), o estado muda para idle, mas o `buildFsmContext` retorna null. A IA precisa saber que havia um produto em foco. Confirmar que `buildAiContext` / `conversationMemory` mantém esse contexto.

### Passo 6 — Aplicar mesma lógica em `awaiting_more_sizes` (linha 853)

O catch-all em `awaiting_more_sizes` tem o mesmo problema. Aplicar a mesma inversão de lógica: mensagens curtas → re-prompt; mensagens com intenção → passa para IA.

### Passo 7 — Verificação

Cenários de teste:
1. Em `awaiting_size`, digitar "Tem a ref 621s?" → bot deve processar a busca (IA ou busca direta)
2. Em `awaiting_size`, digitar "P" → bot deve processar como tamanho P (comportamento atual preservado)
3. Em `awaiting_size`, digitar "ok" → bot deve re-enviar menu (mensagem curta ambígua)
4. Em `awaiting_size`, enviar áudio "quero ver os lançamentos" → bot deve entender e navegar
5. Em `awaiting_size`, digitar "3P 2M" → grade parser deve interceptar (comportamento atual preservado)
6. Em `awaiting_more_sizes`, digitar "me mostra outra coisa" → bot deve sair do fluxo

---

## Resumo das Mudanças (Bug 4)

| Arquivo | Mudança |
|---------|---------|
| `services/semantic.js` | Adicionar `wantsProductSearch` com patterns de ref/busca |
| `index.js` ~770 | Adicionar `wantsProductSearch` ao `fsmEscaping` |
| `index.js` ~827-832 | Inverter catch-all: mensagens curtas → re-prompt; longas → IA |
| `index.js` ~853-856 | Mesma inversão em `awaiting_more_sizes` |
| `index.js` ~438 | Adicionar logging de áudio durante FSM ativa |

---

---

# Bug 5 — Seleção de Categoria Envia TODAS as Fotos de Uma Vez

## Diagnóstico

O roteamento determinístico de categorias (Bug 3) foi implementado chamando `showAllCategory` (linha 588). Essa função despeja TODOS os produtos da categoria de uma vez — pode ser 20, 30, 50+ fotos seguidas. O correto é usar `showCategory` que pagina de 10 em 10.

### Causa Raiz

**Arquivo:** `index.js`, linha 588

```javascript
if (CAT_SENTINELS[text]) {
  const slug = CAT_SENTINELS[text];
  await showAllCategory(from, slug, session);  // ← ERRADO: despeja tudo
}
```

## Fix

### Passo 1 — Trocar `showAllCategory` por `showCategory` no roteamento determinístico

**Onde:** `index.js`, linha 588

```javascript
// ANTES:
await showAllCategory(from, slug, session);

// DEPOIS:
await showCategory(from, slug, session);
```

`showCategory` já faz paginação (10 por vez via `getProductsByCategory(slug, 10, 1)`), envia cards com foto, e gera follow-up com opção de ver mais.

### Passo 2 — Garantir que `showCategory` tem botão "Ver Todos"

Verificar que o `sendProductPage` ou o follow-up da IA apresenta um botão ou opção para o cliente ver todos os produtos da categoria se quiser. Isso pode ser:

- Um botão `btn_ver_todos` na option list pós-vitrine (já existe no `sendCatalogBrowseOptions`?)
- Ou detectar quando o cliente diz "quero ver todos" e chamar `showAllCategory`

**Verificar** se `sendCatalogBrowseOptions` já inclui essa opção. Se não, adicionar:
```javascript
{ id: 'btn_ver_todos', title: 'Ver Todos', description: `Mostrar tudo de ${getCategoryDisplayName(slug)}` }
```

### Passo 3 — Remover a listagem de texto de `showAllCategory` também

Mesmo quando o cliente PEDE para ver todos (via botão), a lista numerada de texto continua redundante. Remover as linhas 2528-2535 de `showAllCategory` conforme já planejado no Bug 2.

---

# Bug 6 — Busca por Referência Dá Erro e Bot Morre

## Diagnóstico

### O Bug
Usuário digita "Queria ver a ref 602s" → busca funciona, mostra 10 resultados com cards → mas depois aparece "⚠️ Erro ao buscar produtos." e o bot para de responder. O cliente tem que usar a lista de novo pra continuar.

### Causa Raiz

**Arquivo:** `index.js`, `searchAndShowProducts`, linhas 2457-2519

O try/catch engloba TODO o fluxo: busca + exibição + chamada da IA. Se a chamada `ai.chat` (linha 2509) falha, o catch (linha 2516) mostra "Erro ao buscar produtos" — mensagem enganosa, porque os produtos JÁ foram buscados e exibidos com sucesso.

```javascript
try {
  const products = await woocommerce.searchProducts(query, 10);  // ✅ funcionou
  // ... mostra lista e cards ...                                  // ✅ funcionou
  const aiRaw = await ai.chat(session.history, buildAiContext(session)); // ❌ FALHOU AQUI
  // ...
} catch (err) {
  await zapi.sendText(phone, '⚠️ Erro ao buscar produtos.');     // ← mensagem errada
}
```

### Problema secundário: listagem de texto nos resultados de busca

`searchAndShowProducts` também envia uma lista numerada redundante (linhas 2480-2484) antes dos cards — mesmo padrão dos Bugs 2/5.

## Fix

### Passo 1 — Separar try/catch da busca e da IA

```javascript
async function searchAndShowProducts(phone, query, session) {
  clearSupportMode(session, 'search_products');
  await sendLoadingMessage(
    phone,
    `🔍 Buscando por *${query}*...`,
    `Só um instante, amor! Vou procurar o que temos de ${query} pra você!`
  );

  let products;
  try {
    products = await woocommerce.searchProducts(query, 10);
  } catch (err) {
    logger.error({ query, err: err.message }, '[searchAndShowProducts] Erro na busca');
    await zapi.sendText(phone, `⚠️ Não consegui buscar "${query}" agora. Tenta de novo em instantes? 😊`);
    return;
  }

  if (!products || products.length === 0) {
    await zapi.sendText(phone, `😕 Poxa, não encontrei nada buscando por "${query}".`);
    return;
  }

  // Salvar na sessão
  session.products = products;
  session.currentCategory = null;
  session.activeCategory = null;
  session.currentPage = 1;
  session.totalPages = 1;
  session.totalProducts = products.length;

  // Enviar cards (SEM lista de texto)
  session.purchaseFlow.interactiveVersion = Date.now();
  for (const [i, product] of products.entries()) {
    if (product.imageUrl) {
      try {
        const scRes = await zapi.sendProductShowcase(phone, product, session.purchaseFlow.interactiveVersion);
        registerMessageProduct(session, scRes?.data?.zaapId, scRes?.data?.messageId, product);
      } catch {
        try {
          const imgRes = await zapi.sendImage(phone, product.imageUrl, woocommerce.buildCaption(product, i + 1));
          registerMessageProduct(session, imgRes?.data?.zaapId, imgRes?.data?.messageId, product);
        } catch (imgErr) {
          logger.warn({ productId: product.id, err: imgErr?.message }, '[searchAndShowProducts] Falha ao enviar imagem');
        }
      }
      await zapi.delay(400);
    }
  }

  if (products.length > 0) {
    session.lastViewedProduct = products[products.length - 1];
    session.lastViewedProductIndex = products.length;
  }

  // Follow-up da IA — em try/catch SEPARADO (não mata o fluxo se falhar)
  try {
    const nudge = '[SISTEMA: Você mostrou os resultados da busca. Pergunte se a cliente gostou de alguma peça ou se quer pesquisar outra coisa.]';
    appendHistory(session, 'system', nudge);
    conversationMemory.refreshConversationMemory(session, { action: { type: 'BUSCAR', payload: query } });

    const aiRaw = await ai.chat(session.history, buildAiContext(session));
    const { cleanText } = ai.parseAction(aiRaw);
    if (cleanText) {
      appendHistory(session, 'assistant', cleanText);
      conversationMemory.refreshConversationMemory(session, { assistantText: cleanText });
      await zapi.sendText(phone, cleanText);
    }
  } catch (aiErr) {
    logger.error({ query, err: aiErr.message }, '[searchAndShowProducts] Erro na IA — busca já exibida');
    // Não mostra erro pro cliente — os produtos já foram exibidos com sucesso
  }
}
```

### Passo 2 — Remover listagem de texto dos resultados de busca

Remover o bloco de linhas 2480-2484 (mesma correção dos Bugs 2/5):
```javascript
// REMOVER:
let msg = `✨ *Resultados para: ${query}* ✨\n\n`;
products.forEach((p, i) => {
  msg += `${i + 1}. *${p.name}* — ${woocommerce.formatPrice(p.salePrice || p.price)}\n`;
});
await zapi.sendText(phone, msg);
```

---

## Resumo Geral Consolidado — Todos os Bugs

| # | Bug | Gravidade | Causa | Fix |
|---|-----|-----------|-------|-----|
| 1 | Grade silenciosamente parcial | 🔴 Alta | `parseGradeText` usa apenas tamanhos em estoque | Parsear com TODOS os tamanhos, avisar sobre indisponíveis |
| 2 | Listagem de texto redundante + slug cru + TTS offline | 🟡 Média | `sendProductPage`/`showAllCategory` enviam lista; slug sem humanização; ElevenLabs falhando | Remover lista, criar mapa de nomes, diagnosticar TTS |
| 3 | Categoria errada na seleção de menu | 🔴 Crítica | Seleção determinística convertida em texto para IA | Roteamento determinístico com sentinelas CAT_* |
| 4 | Bot "burro" em awaiting_size — bloqueia tudo | 🔴 Crítica | catch-all agressivo bloqueia IA para mensagens legítimas | Detectar intenção real, deixar IA processar; apenas re-prompt para msgs curtas |
| 5 | Categoria envia TODAS as fotos de uma vez | 🟡 Média | Sentinela CAT_* chama `showAllCategory` em vez de `showCategory` | Trocar para `showCategory` (paginado, 10 por vez) |
| 6 | Busca por ref dá erro e bot morre | 🔴 Alta | try/catch único engloba busca + IA; IA falha = "erro ao buscar" | Separar try/catch; lista de texto removida |
| — | Produtos adultos em categoria infantil | ⚪ Dados | Cadastro errado no WooCommerce | Corrigir no painel WooCommerce |
| — | Produtos com mesmo nome repetidos | ⚪ Dados | Cada cor/estampa como produto separado | Reestruturar no WooCommerce |

## Arquivos do Obsidian a Atualizar (Bugs 4/5/6)

| Arquivo | Atualização |
|---------|-------------|
| `07 - Histórico e Migrações.md` | ADRs: FSM catch-all invertido; sentinelas usam showCategory; search resiliente |
| `17 - Inteligência Híbrida (FSM + IA).md` | Atualizar diagrama de interceptação e novo fluxo de escape |
| `09 - Humanização e Eventos WhatsApp.md` | Documentar melhoria de comportamento durante FSM ativa |
| `03 - Serviço WooCommerce.md` | Atualizar seção de busca com novo fluxo de erro |

---

# 🔁 REFORÇO CRÍTICO — Correções do Plano que AINDA NÃO foram aplicadas

> Renan reportou (print do dia 10/04) que dois fixes documentados acima **continuam aparecendo em produção**. Isto é um lembrete explícito para o Claude Code: **implementar AGORA, não apenas documentar**.

### ⚠️ Pendência 1 — Remover listagem textual antes dos cards

**Arquivo:** `index.js`
**Função: `sendProductPage`** (~linha 2643)
**Função: `searchAndShowProducts`** (~linha 2480)
**Função: `showAllCategory`** (~linha 2496)

Em **todas as três**, existe um bloco que monta `msg` concatenando `1. Nome — R$ preço` e chama `zapi.sendText(phone, msg)` **antes** do loop de `sendImage`. Esse bloco precisa ser **removido por completo** — os cards (imagem + caption numerada) já cumprem o papel de listagem, o texto duplicado polui a conversa.

```javascript
// ❌ APAGAR (todos os 3 locais):
let msg = `✨ *Resultados para: ${query}* ✨\n\n`;
products.forEach((p, i) => {
  msg += `${i + 1}. *${p.name}* — ${woocommerce.formatPrice(p.salePrice || p.price)}\n`;
});
await zapi.sendText(phone, msg);
```

**Como validar:** pedir "quero ver infantil" e verificar que NENHUMA mensagem de texto com lista numerada aparece antes dos cards.

### ⚠️ Pendência 2 — Mensagem "Buscando..." ainda sendo enviada como texto

**Arquivo:** `index.js` — qualquer `await zapi.sendText(phone, '🔍 Buscando...')` ou similar em `searchAndShowProducts`, `showCategory`, `showAllCategory`.

**Correção em 2 etapas:**

1. **Humanizar o texto** — trocar por uma das variantes (escolher aleatoriamente para parecer natural):
   ```javascript
   const LOADING_LINES = [
     'Deixa eu ver aqui pra você, um instantinho 😊',
     'Calma que já te mando 🙌',
     'Peraí que estou separando pra você ✨',
     'Só um segundo que já te trago 😉',
   ];
   const loadingText = LOADING_LINES[Math.floor(Math.random() * LOADING_LINES.length)];
   ```

2. **Enviar como áudio via TTS (quando habilitado)** com fallback para texto:
   ```javascript
   async function sendLoadingCue(phone) {
     const text = LOADING_LINES[Math.floor(Math.random() * LOADING_LINES.length)];
     if (process.env.TTS_ENABLED === 'true') {
       try {
         const { buffer, mimeType } = await tts.textToSpeech(text);
         const base64 = `data:${mimeType};base64,${buffer.toString('base64')}`;
         await zapi.sendAudio(phone, base64);
         return;
       } catch (err) {
         logger.warn({ err: err.message }, '[sendLoadingCue] TTS falhou — fallback texto');
       }
     }
     await zapi.sendText(phone, text);
   }
   ```

3. **Diagnosticar TTS** (por que não está tocando hoje):
   - Verificar `.env`: `TTS_ENABLED=true`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` carregados.
   - Adicionar log em `services/tts.js` no início de `textToSpeech`: `logger.info({ voiceId: VOICE_ID, modelId: MODEL_ID }, '[TTS] start')`.
   - Testar isoladamente: `node -e "require('./services/tts').textToSpeech('teste').then(r => console.log(r.buffer.length))"`.
   - Checar se `zapi.sendAudio` existe e aceita base64 data URL (verificar `services/zapi.js`).
   - Se ElevenLabs retornar 401 → chave inválida. Se 422 → voiceId inválido. Se timeout → rede/firewall.

---

# 🧠 BUG 7 — Humanização da Fala da Bela (Prompt Engineering)

**Gravidade:** 🟡 Média (UX crítico)
**Pedido literal do Renan:** *"gostaria que ela tivesse tambem a capacidade de ser mais 'humana' na fala. como podemos melhorar?"*

## Diagnóstico do SYSTEM_PROMPT atual (`services/gemini.js`)

O prompt atual (linhas 6-84) já tem uma base boa: persona Bela, anti-padrões, bloco `<think>`, tokens de ação. Mas sofre de 3 problemas:

1. **Só diz o que NÃO fazer** — lista de proibições ("NUNCA use 'Olá!'") sem **modelagem positiva** (exemplos concretos de mensagens boas).
2. **Temperatura 0.4** — muito baixa para variabilidade humana. WhatsApp real tem ritmo, pausas, interjeições espontâneas.
3. **Sem repertório de estilo** — faltam exemplos few-shot de como a Bela fala em situações típicas (saudação, objeção de preço, pedido de foto, cliente indeciso, fechamento).

## Plano de correção

### Passo 1 — Subir temperatura para `0.7`

**Arquivo:** `services/gemini.js` linha 152
```javascript
// ANTES
generationConfig: { temperature: 0.4, maxOutputTokens: 500 },
// DEPOIS
generationConfig: { temperature: 0.7, maxOutputTokens: 500 },
```
**Justificativa:** 0.4 é temperatura de assistente técnico. Vendedora humana varia tom, usa sinônimos, muda ordem das frases — 0.7 é o sweet spot documentado pela própria Anthropic/Google para personas conversacionais.

### Passo 2 — Adicionar bloco REPERTÓRIO DE FALA no SYSTEM_PROMPT

Inserir **logo após** a seção "IDENTIDADE E TOM DE VOZ", antes de "REGRAS CRÍTICAS":

```
━━━━━━━━━━━━━━━━━━━━━━━━
REPERTÓRIO — COMO A BELA FALA (exemplos reais)
━━━━━━━━━━━━━━━━━━━━━━━━
Estes são exemplos de mensagens boas. Absorva o RITMO, não copie literalmente.

SAUDAÇÃO (lojista chegando):
✅ "Oi amor, tudo bem? Tô aqui 😊 Quer dar uma olhada nos lançamentos dessa semana?"
✅ "Eaí linda! Bora ver o que chegou de novo pra você?"
✅ "Oi! Chegou coisa linda essa semana, tá doida 🙌 quer ver?"

APRESENTANDO PRODUTO:
✅ "Olha essa calcinha renda, tá voando viu 😍 tem em preto e branco"
✅ "Essa aqui é campeã de venda. Saiu 3 grades só essa semana"

OBJEÇÃO DE PREÇO:
✅ "Poxa amiga, esse aí já é o atacado viu. Mas olha, no PIX tem desconto"
✅ "Entendo. Mas repara que é renda importada, aguenta lavagem tranquilo"

CLIENTE INDECISO:
✅ "Olha, eu te dou uma dica: pega a grade dessa renda que gira rápido. Faz essa aposta comigo"
✅ "Posso te sugerir? Começa com 2 grades dessa e uma do básico. Daí você sente o giro"

PEDINDO FOTO:
✅ "Claro, já te mando 😉"
✅ "Peraí que te mostro"

FECHAMENTO:
✅ "Fechou então? Vou separar aqui 🙌"
✅ "Beleza amor, tá anotado. Mais alguma coisa ou fecho por aqui?"

DÚVIDA TÉCNICA QUE VOCÊ NÃO SABE:
✅ "Boa pergunta, deixa eu conferir rapidinho com o estoque e já te falo"

NUNCA:
❌ "Olá! Como posso ajudá-la hoje?"
❌ "Com certeza! Aqui estão as opções disponíveis:"
❌ "Entendido. Vou processar sua solicitação."
❌ "Segue abaixo a lista de produtos:"
```

### Passo 3 — Adicionar REGRAS DE RITMO no SYSTEM_PROMPT

Inserir logo após o repertório:

```
━━━━━━━━━━━━━━━━━━━━━━━━
RITMO E NATURALIDADE
━━━━━━━━━━━━━━━━━━━━━━━━
• Varie o tamanho das mensagens. Às vezes 1 linha. Às vezes 2-3. Nunca blocos gigantes.
• Use contrações naturais: "tá", "pra", "cê", "tamo", "bora".
• Pode começar mensagem com letra minúscula, como todo mundo faz no zap.
• Use vírgulas "respirando" como na fala: "olha, essa peça, ela é diferente das outras viu".
• Interjeições curtas funcionam: "Poxa", "Nossa", "Ó", "Eita".
• NÃO use travessão (—) nem reticências formais em excesso.
• NÃO termine toda mensagem com pergunta. Às vezes, só afirme e deixe o cliente reagir.
• Emojis: no MÁXIMO 1-2 por mensagem. Nunca em toda frase.
• Vocativos variados: "amor", "linda", "amiga", "miga", "querida" — alterne, não repita.
```

### Passo 4 — Injetar hora do dia no `nudgeBlock`

Saudação natural muda com hora do dia. Em `index.js`, onde monta o `nudge` da primeira mensagem:

```javascript
const hour = new Date().getHours();
const greeting = hour < 12 ? 'bom dia' : hour < 18 ? 'boa tarde' : 'boa noite';
const nudge = `É o primeiro contato do dia com esse lojista. Saudação natural de ${greeting}, chama pra ver os lançamentos da semana. 1 linha só.`;
```

### Passo 5 — Adicionar "variação forçada" nos learnings

Na tabela `learnings` do Supabase, adicionar entradas do tipo:
```
"Se a última mensagem sua começou com 'Oi', varie para 'Eaí', 'Opa', 'Olha só' na próxima."
"Não repita vocativos. Se usou 'amor' na última, use 'linda' ou 'amiga' agora."
"Se o lojista mandou msg curta, você responde curta também. Espelha o ritmo dele."
```

## Validação

Após aplicar Passos 1-3, testar com estas mensagens e comparar antes/depois:
1. "oi" → deve variar saudação entre testes
2. "quanto é essa calcinha?" → resposta curta, sem "Com certeza!"
3. "tá caro" → objeção tratada com empatia, não defensiva formal
4. "quero ver infantil" → 1 linha + token, sem "Aqui estão as opções"

---

## Resumo das Ações Imediatas para o Claude Code

1. ✅ **Aplicar Pendência 1** — remover 3 blocos de listagem textual em `index.js` (sendProductPage, searchAndShowProducts, showAllCategory).
2. ✅ **Aplicar Pendência 2** — criar `sendLoadingCue()` com TTS + fallback; substituir `sendText('Buscando...')` em todos os call sites.
3. ✅ **Diagnosticar TTS** — log + teste isolado de `services/tts.js`.
4. ✅ **Bug 7 Passo 1** — subir `temperature` para 0.7 em `services/gemini.js`.
5. ✅ **Bug 7 Passos 2-3** — inserir blocos REPERTÓRIO e RITMO no `SYSTEM_PROMPT`.
6. ✅ **Bug 7 Passo 4** — greeting por hora do dia no nudge do primeiro contato.
7. ✅ **Atualizar Obsidian** — `10 - Persona da Bela.md` (novo repertório) e `16 - Serviço Gemini.md` (nova temperatura + prompt).

---

# 🐛 BUG 8 — STT parou de funcionar (regressão de áudio)

**Gravidade:** 🔴 Alta (cliente manda áudio, Bela ignora completamente)

## Causa Raiz

Em `index.js`, a detecção de áudio depende de `body.audio` ser truthy (linha 406 de `extractTextFromEvent`). Se o Z-API mudou o payload para enviar o áudio dentro de `body.message.audio`, a detecção falha silenciosamente: `extractTextFromEvent` retorna `''`, o guard `if (!text) return` encerra tudo, e a Bela nunca responde ao áudio.

`extractAudioUrl` tem o mesmo gap: checa `event.message?.audioUrl` mas não `event.message?.audio?.audioUrl`.

## Fix — `index.js`

### Passo 1 — Ampliar detecção em `extractTextFromEvent`

```javascript
// ANTES (linha 406):
if (event.audio) return '[Áudio_STT]';

// DEPOIS:
if (event.audio || event?.message?.audio) return '[Áudio_STT]';
```

### Passo 2 — Ampliar extração de URL em `extractAudioUrl`

```javascript
// ANTES:
function extractAudioUrl(event) {
  return event?.audio?.audioUrl
    || event?.audio?.url
    || event?.audioUrl
    || event?.message?.audioUrl
    || null;
}

// DEPOIS:
function extractAudioUrl(event) {
  return event?.audio?.audioUrl
    || event?.audio?.url
    || event?.audioUrl
    || event?.message?.audioUrl
    || event?.message?.audio?.audioUrl
    || event?.message?.audio?.url
    || null;
}
```

### Passo 3 — Adicionar log de diagnóstico no webhook (para confirmar a causa)

Logo antes de `let text = extractTextFromEvent(body)` (linha 455), adicionar:
```javascript
if (!body.text && !body.listResponseMessage && !body.buttonsResponseMessage) {
  logger.info({ bodyKeys: Object.keys(body), hasAudio: Boolean(body.audio), hasMessageAudio: Boolean(body?.message?.audio) }, '[Webhook] Payload sem texto — inspecionando tipo');
}
```

Isso vai aparecer nos logs da próxima vez que um áudio chegar, confirmando qual campo está sendo usado.

---

# 🐛 BUG 9 — Bot para após mostrar resultados de busca (sem menu de navegação)

**Gravidade:** 🔴 Alta (conversa morre após busca por ref)

## Causa Raiz

`searchAndShowProducts` tem dois problemas:

1. **Falha silenciosa da IA:** o catch na linha 2529 engole o erro e não envia **nada**. O cliente viu os produtos e recebe silêncio total.

2. **Menu de categoria automático quebra o contexto:** quando a IA funciona, `sendCategoryMenu` abre o menu completo de navegação logo após a busca. O cliente buscou "602s", viu o produto, e imediatamente aparece uma lista perguntando qual categoria quer. É desorientante — parece que a Bela quer mudar de assunto.

## Fix — `index.js`

### Passo 1 — Reescrever o nudge para ser intencional, não prescritivo

```javascript
// ANTES (linha 2514):
const nudge = '[SISTEMA: Você mostrou os resultados da busca. Pergunte se a cliente gostou de alguma peça ou se quer pesquisar outra coisa.]';

// DEPOIS:
const nudge = '[SISTEMA: Os produtos da busca foram exibidos. Reagir naturalmente — pode ser curto, tipo "gostou?" ou "tem mais coisa?". NÃO liste produtos, NÃO dê instruções de número. Mantenha o ritmo de WhatsApp.]';
```

### Passo 2 — Não enviar menu de categorias automaticamente após busca

Após busca, o menu de categorias quebra o contexto. O cliente que buscou um produto específico não quer ser redirecionado para "qual categoria você quer?". A Bela deve apenas perguntar naturalmente se gostou, sem estrutura de menu.

```javascript
// ANTES (linhas 2523-2527):
if (session.items.length > 0) {
  await sendCartOptions(phone, session, cleanText);
} else {
  await sendCategoryMenu(phone, cleanText);
}

// DEPOIS:
if (session.items.length > 0) {
  await sendCartOptions(phone, session, cleanText);
} else {
  // Após busca: só texto da IA, sem menu forçado.
  // O menu de categorias só aparece se o cliente pedir explicitamente.
  await zapi.sendText(phone, cleanText);
}
```

### Passo 3 — Garantir fallback se a IA falhar

```javascript
// No catch (linha 2529):
} catch (aiErr) {
  logger.error({ query, err: aiErr.message }, '[searchAndShowProducts] Erro na IA — usando fallback');
  const fallbacks = [
    'Gostou de alguma? Me manda o número pra eu separar o tamanho 😊',
    'Achou o que procurava? É só me dizer o número da peça!',
    'Quer saber mais sobre alguma dessas? Só falar 😄',
  ];
  const fallback = fallbacks[Math.floor(Math.random() * fallbacks.length)];
  await zapi.sendText(phone, fallback);
}
```

---

# 🐛 BUG 10 — Bot excessivamente formal após ações do sistema

**Gravidade:** 🟡 Média (UX degradada — parece robô)

## Causa Raiz

Os nudges injetados pelo sistema (`[SISTEMA: ...]`) são prescritivos — descrevem exatamente o que a Bela deve dizer. A IA segue à risca e o resultado parece um atendente de call center lendo script.

Exemplos problemáticos encontrados no código:
- `"[SISTEMA: Você mostrou os resultados da busca. Pergunte se a cliente gostou de alguma peça ou se quer pesquisar outra coisa.]"` → Bela diz literalmente "Me diz o número da peça que você gostou, ou se preferir escolhe outra coleção"
- Qualquer nudge do tipo "faça X" produz a frase X quase literal

## Fix — Revisar todos os nudges em `index.js`

Buscar todas as strings `[SISTEMA:` no código e reescrevê-las no padrão **contextual, não prescritivo**:

| Nudge atual | Nudge revisado |
|---|---|
| "Pergunte se a cliente gostou de alguma peça ou se quer pesquisar outra coisa." | "Os produtos foram exibidos. Reaja naturalmente, curto, no ritmo de zap." |
| "Apresente o produto X e pergunte o tamanho" | "Produto exibido. Conversa fluindo — tamanho é o próximo passo se o cliente quiser." |
| "O carrinho está vazio, convier para ver mais produtos" | "Carrinho vazio. Mantém papo casual." |

**Regra geral para novos nudges:** nunca usar verbo imperativo ("pergunte", "diga", "apresente"). Sempre usar indicativo descritivo ("os produtos foram exibidos", "o cliente está no carrinho").

---

## Resumo das Ações para o Claude Code (Bugs 8-10)

1. ✅ **Bug 8 Passos 1-2** — ampliar `extractTextFromEvent` e `extractAudioUrl` para cobrir `body.message.audio`
2. ✅ **Bug 8 Passo 3** — adicionar log de diagnóstico de payload
3. ✅ **Bug 9 Passos 1-3** — reescrever nudge de busca, remover `sendCategoryMenu` automático pós-busca, adicionar fallback de IA
4. ✅ **Bug 10** — auditar e reescrever todos os `[SISTEMA:]` nudges no `index.js`
5. ✅ **Atualizar Obsidian** — `02 - Webhook e Roteamento.md` (STT fix), `09 - Humanização.md` (nudges revisados)
