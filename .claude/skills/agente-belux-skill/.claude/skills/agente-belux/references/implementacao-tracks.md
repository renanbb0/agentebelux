
# 🛠️ Implementação: Track 1 (Grade Semântica) + Track 2 (Resolver de Produto Citado)

> **Leia este documento inteiro antes de escrever uma linha de código.**
> Implemente na ordem: Track 2 primeiro (resolve produto citado), depois Track 1 (parser de grade).
> Nenhuma mudança de schema de banco de dados é necessária — tudo é em memória na sessão.

---

## Contexto do Problema

Dois bugs recorrentes quebram a experiência de compra:

1. **Cliente cita (reply) uma vitrine/foto e pergunta "tem P dessa?"** → o sistema não consegue identificar o produto porque `sendProductShowcase` não embute número na mensagem, então `quotedProductIdx` nunca é resolvido, e o fallback de `lastViewedProduct` fica bloqueado pelo guard `canUseLastViewedFallback` (~line 620).

2. **Cliente digita grade de tamanhos durante compra**: "9P 5M 3G" ou "quero 6 do G e 3 do M"** → não há parser, a mensagem vai pra IA ou para o FSM Text Interceptor e nada é adicionado ao carrinho.

---

## Track 2 — Resolver de Produto por messageId

### Princípio
Quando a Bela envia uma vitrine (`sendProductShowcase`) ou imagem (`sendImage`), a Z-API devolve um `zaapId`. Guardar o mapeamento `zaapId → { productId, productIndex }` na sessão. Quando o cliente faz reply nessa mensagem, o `body.quotedMessage` traz o `messageId` da mensagem citada — que é o mesmo `zaapId`. Basta fazer o lookup direto.

### Passo 1 — Adicionar `messageProductMap` na sessão

Em `getSession` (~line 99), na estrutura padrão, adicionar o campo:

```javascript
// Na criação de sessão nova (sessão não existia no Supabase):
{
  history: [], items: [], products: [],
  // ... campos existentes ...
  messageProductMap: {},  // ← NOVO: zaapId → { productId, productIdx }
}

// Na restauração de sessão do Supabase:
{
  // ... campos existentes restaurados ...
  messageProductMap: stored.message_product_map || {},  // ← NOVO
}
```

Em `persistSession`, garantir que `messageProductMap` seja salvo. No `db.upsertSession`, incluir o campo `message_product_map: session.messageProductMap`.

**Nota:** O map cresce com o tempo. Limitar a 50 entradas: ao inserir, se `Object.keys(map).length > 50`, deletar as primeiras 25 (mais antigas).

### Passo 2 — Registrar zaapId ao enviar vitrine e imagem

Em todos os locais onde `sendProductShowcase` e `sendImage` são chamados no `index.js` (~lines 1185, 1188, 1261, 1263, 1327, 1335, 1346, 1392, 1394), capturar o retorno e registrar no map:

```javascript
// Padrão para sendProductShowcase:
const showcaseRes = await zapi.sendProductShowcase(phone, product, session.purchaseFlow.interactiveVersion);
const showcaseZaapId = showcaseRes?.data?.zaapId;
if (showcaseZaapId && session.messageProductMap) {
  const idx = session.products.indexOf(product) + 1;  // índice 1-based
  session.messageProductMap[showcaseZaapId] = { productId: product.id, productIdx: idx };
  // Limitar tamanho do map
  const keys = Object.keys(session.messageProductMap);
  if (keys.length > 50) keys.slice(0, 25).forEach(k => delete session.messageProductMap[k]);
}

// Padrão para sendImage (usando buildCaption que já tem o índice):
const imageRes = await zapi.sendImage(phone, product.imageUrl, woocommerce.buildCaption(product, idx));
const imageZaapId = imageRes?.data?.zaapId;
if (imageZaapId && session.messageProductMap) {
  session.messageProductMap[imageZaapId] = { productId: product.id, productIdx: idx };
  const keys = Object.keys(session.messageProductMap);
  if (keys.length > 50) keys.slice(0, 25).forEach(k => delete session.messageProductMap[k]);
}
```

**Atenção:** `sendImage` e `sendProductShowcase` em `services/zapi.js` já retornam `res` — confirmar que o retorno está sendo propagado (hoje alguns chamadores ignoram o retorno com `await zapi.sendProductShowcase(...)` sem capturar).

### Passo 3 — Usar o map na resolução de quotedMessage

No bloco de resolução de produto citado (~line 515), **antes** da tentativa via REST API, adicionar uma nova tentativa via `messageProductMap`:

```javascript
// Tentativa via messageProductMap (NOVA — inserir antes do bloco REST API existente)
if (!extractedIdx && session.products?.length > 0 && session.messageProductMap) {
  const msgId = body.quotedMessage.messageId
    || body.quotedMessage.stanzaId
    || body.quotedMessage.id;

  if (msgId && session.messageProductMap[msgId]) {
    const mapped = session.messageProductMap[msgId];
    // Verifica se o produto ainda está na lista atual
    const productStillLoaded = session.products.some(p => p.id === mapped.productId);
    if (productStillLoaded) {
      extractedIdx = mapped.productIdx;
      logger.info({ msgId, productId: mapped.productId, productIdx: mapped.productIdx }, '[QuotedProduct] Resolvido via messageProductMap ✓');
    }
  }
}
```

### Passo 4 — Fallback por nome do produto no texto citado

Após o bloco do map (e antes do REST API), adicionar resolução por nome:

```javascript
// Tentativa via nome do produto no texto citado
if (!extractedIdx && session.products?.length > 0 && quotedText) {
  const matchByName = session.products.findIndex(p =>
    quotedText.includes(p.name) ||
    (p.sku && quotedText.includes(p.sku)) ||
    // Tenta casar pela referência tipo "Ref 422"
    (p.name.match(/Ref \d+/) && quotedText.includes(p.name.match(/Ref \d+/)[0]))
  );
  if (matchByName >= 0) {
    extractedIdx = matchByName + 1;
    logger.info({ productName: session.products[matchByName].name, productIdx: extractedIdx }, '[QuotedProduct] Resolvido via nome ✓');
  }
}
```

---

## Track 1 — Parser Semântico de Grade por Texto

### Princípio
Quando a FSM está ativa (`pf.state !== 'idle'`) e o cliente envia um texto com padrão de tamanho+quantidade, um parser determinístico (regex, sem IA) extrai a grade e a processa em sequência. A IA não é chamada para esses casos — velocidade e precisão máximas.

### Padrões a cobrir

| Input do cliente | Saída esperada |
|---|---|
| `9P 5M 3G` | `[{size:"P",qty:9},{size:"M",qty:5},{size:"G",qty:3}]` |
| `9p 5m 3g` | idem (case insensitive) |
| `quero 6 do G e 3 do M` | `[{size:"G",qty:6},{size:"M",qty:3}]` |
| `separa 2P e 4GG` | `[{size:"P",qty:2},{size:"GG",qty:4}]` |
| `P: 9, M: 5, G: 3` | `[{size:"P",qty:9},{size:"M",qty:5},{size:"G",qty:3}]` |
| `6G` | `[{size:"G",qty:6}]` |
| `2 do PP` | `[{size:"PP",qty:2}]` |

### Passo 1 — Criar a função `parseGradeText`

Adicionar como função pura **no topo do `index.js`** (após os `require`s, antes das funções de sessão):

```javascript
/**
 * Tenta extrair uma grade de tamanho+quantidade de um texto livre.
 * Só deve ser chamada quando a FSM está ativa e o produto em foco tem sizes conhecidos.
 *
 * @param {string} text - texto digitado pelo cliente
 * @param {string[]} knownSizes - tamanhos válidos do produto (ex: ['P','M','G','GG'])
 * @returns {{ size: string, qty: number }[] | null} - grade extraída ou null se não reconheceu
 */
function parseGradeText(text, knownSizes) {
  if (!text || !knownSizes?.length) return null;

  const sizesPattern = knownSizes
    .slice()
    .sort((a, b) => b.length - a.length) // GG antes de G
    .join('|');

  const results = [];

  // Padrão: número antes do tamanho — "9P", "9 P", "9 do P", "9x P", "9 de P"
  const regexQtyFirst = new RegExp(
    `(\\d+)\\s*(?:do|de|x|:)?\\s*(${sizesPattern})(?=\\s|,|;|e\\b|$)`,
    'gi'
  );

  // Padrão: tamanho antes do número — "P: 9", "P 9", "P=9"
  const regexSizeFirst = new RegExp(
    `\\b(${sizesPattern})\\s*[=:]\\s*(\\d+)`,
    'gi'
  );

  let match;
  const seen = new Set();

  while ((match = regexQtyFirst.exec(text)) !== null) {
    const qty = parseInt(match[1], 10);
    const size = match[2].toUpperCase();
    if (!seen.has(size) && qty > 0 && qty <= 999) {
      results.push({ size, qty });
      seen.add(size);
    }
  }

  while ((match = regexSizeFirst.exec(text)) !== null) {
    const size = match[1].toUpperCase();
    const qty = parseInt(match[2], 10);
    if (!seen.has(size) && qty > 0 && qty <= 999) {
      results.push({ size, qty });
      seen.add(size);
    }
  }

  // Valida que todos os tamanhos extraídos existem no produto
  const validResults = results.filter(r =>
    knownSizes.some(s => s.toUpperCase() === r.size)
  );

  return validResults.length > 0 ? validResults : null;
}
```

### Passo 2 — Invocar o parser no webhook handler

Inserir **imediatamente após o bloco `awaiting_quantity` manual (~line 305)** e **antes** do FSM Text Interceptor:

```javascript
// ── Grade Semântica: parser determinístico de tamanho+quantidade ──────────
// Só dispara quando a FSM está ativa e o produto está em foco.
// Processa toda a grade sequencialmente sem chamar a IA.
if (pfCheck.state !== 'idle' && pfCheck.productId) {
  const focusedProduct = session.products?.find(p => p.id === pfCheck.productId);

  if (focusedProduct?.sizes?.length) {
    const grade = parseGradeText(text, focusedProduct.sizes);

    if (grade) {
      logger.info({ from, grade, product: pfCheck.productName }, '[Grade] Grade semântica detectada');

      // Reseta para estado limpo antes de processar a grade
      resetPurchaseFlow(session);
      session.purchaseFlow.productId    = focusedProduct.id;
      session.purchaseFlow.productName  = focusedProduct.name;
      session.purchaseFlow.price        = parseFloat(focusedProduct.salePrice || focusedProduct.price);

      let addedCount = 0;
      for (const { size, qty } of grade) {
        // Verifica se o tamanho existe no produto
        const validSize = focusedProduct.sizes.find(s => s.toUpperCase() === size);
        if (!validSize) continue;

        session.purchaseFlow.selectedSize = validSize;
        session.purchaseFlow.state = 'awaiting_quantity';
        await addToCart(from, qty, session);
        addedCount++;
      }

      if (addedCount === 0) {
        await zapi.sendText(from, `Hmm, não reconheci os tamanhos. Os disponíveis são: *${focusedProduct.sizes.join(', ')}* 😊`);
      }

      persistSession(from);
      return;
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────
```

**Atenção importante sobre `addToCart`:** Hoje `addToCart` envia mensagens e chama `sendPostAddMenu` a cada item. Para processar uma grade com 3 tamanhos, isso geraria 3 menus. Criar uma variável de flag `silentMode` ou processar diferente: chamar a lógica de push do item sem o menu intermediário, e só enviar o menu no final da grade inteira.

Sugestão: extrair a lógica de push do item de `addToCart` para uma função `pushCartItem(session, productId, productName, size, qty, price)` que só atualiza a sessão sem enviar mensagens. Depois enviar uma confirmação única com toda a grade e chamar `sendPostAddMenu` uma única vez.

```javascript
// Confirmação consolidada da grade:
const gradeLines = grade.map(({ size, qty }) =>
  `• ${focusedProduct.name} (${size}) x${qty}`
).join('\n');
const cartTotal = session.items.reduce((acc, it) => acc + parseFloat(it.price), 0);
await zapi.sendText(from,
  `✅ Grade separada!\n${gradeLines}\n\n🛒 Carrinho: ${session.items.length} itens — *${woocommerce.formatPrice(cartTotal)}*`
);
```

---

## Ordem de implementação

```
1. Track 2, Passo 1 — Adicionar messageProductMap na sessão
2. Track 2, Passo 2 — Registrar zaapId em sendProductShowcase e sendImage
3. Track 2, Passo 3 — Usar map na resolução de quotedMessage
4. Track 2, Passo 4 — Fallback por nome do produto
5. Track 1, Passo 1 — Criar parseGradeText
6. Track 1, Passo 2 — Invocar parser no webhook (com lógica de grade silenciosa)
```

## Testes manuais esperados após implementação

| Cenário | Resultado esperado |
|---|---|
| Cliente cita vitrine do Chocolate e digita "tem P dessa?" | Sistema resolve Chocolate via messageProductMap, mostra fotos |
| Cliente cita vitrine e digita "quero comprar" | Sistema resolve produto, inicia FSM de compra |
| Cliente está em `awaiting_size` e digita "9P 5M 3G" | Grade adicionada, confirmação única, `sendPostAddMenu` uma vez |
| Cliente digita "quero 6 do G e 3 do M" durante compra | Idem acima |
| Cliente digita "9P 5M 3G" sem FSM ativa | Parser não dispara, vai pra IA normalmente |
| Cliente cita foto de lista de produtos (que TEM número ✨N.) | Fluxo existente continua funcionando — não quebrar |
