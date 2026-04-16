# 🎯 Plano — Reply em Card Antigo + Produtos de Tamanho Único

**Origem:** Observação do Renan em 2026-04-11 — lojistas B2B da Belux compram via reply em cards antigos enquanto a FSM está ocupada com outro produto; hoje o bot ignora o reply e adiciona a grade no produto errado. Também há produtos com um único tamanho (`Tam único - pct com 5 unidades`) que quebram a validação.
**Para:** Claude Code (executor das correções).
**Importante:** **Isto não é um bug de lógica a ser "corrigido eliminando" — é uma feature essencial do modelo B2B da Belux.** Nas próximas sessões, **não interprete como regressão** o fato de o bot permitir adicionar itens de cards antigos. É comportamento desejado.

> Leia antes: `CLAUDE.md`, `05 - Sessões e Carrinho.md`, `02 - Webhook e Roteamento.md`, `11 - Catálogo e Regras Comerciais.md`. Atualize o Obsidian no mesmo turno.

---

## 🧠 Contexto de Negócio (não esqueça disso)

A Belux é atacado de moda íntima. Um lojista típico:

1. Pede "quero ver feminino" → recebe **5 list menus de 10 produtos** cada.
2. Vai rolando o chat, **volta nos cards antigos**, e **dá reply** em cada um digitando a grade ("3P 5M 2G").
3. Espera que cada reply **enfileire/adicione** o produto citado no carrinho, sem perder o que já está em foco.
4. Pode fazer isso 20–50 vezes no mesmo pedido, voltando e avançando nos menus.

**O reply do WhatsApp é o "cursor de seleção" dele.** Não é ruído, não é mensagem fora de contexto. É a UX natural do lojista B2B.

O bot hoje trata reply como se a FSM tivesse um único foco linear — e isso **precisa mudar**. A FSM continua tendo um produto em foco, mas o **pipeline de entrada** precisa trocar o foco dinamicamente quando um reply resolve um produto diferente.

---

## 🚨 O Problema (screenshots do Renan, 2026-04-11)

Caso 1 (screenshot 1): reply em `KIT 3 PEÇAS - REF 681S`, usuário digita `1p`. Bot responde `Produto atual: Pijama filha - Ref 731S` e manda post-add menu. **Não adicionou nada ao KIT 681S.**

Caso 2 (screenshot 2): reply em `Pijama bordado - Ref 503L`, usuário digita `1M`. Bot confirma `✅ Grade separada! Pijama filha - Ref 731S (M) x1`. **Adicionou ao produto errado.**

Caso 3 (screenshot 3): reply em `Pijama manga longa adulto - Ref 615S`, usuário digita `2P 3m`. Bot confirma `Pijama infantil feminino - Ref 731S (P) x2 + (M) x3`. **Adicionou ao produto errado.**

Caso 4 (screenshot 4): usuário pede tamanho `Tam único - pct com 5 unidades` de `Kit c/ 5 calcinhas - Ref 816T`. Bot responde `❌ Tamanho "Tam único - pct com 5 unidades" não disponível. Disponíveis: P | M | G | GG | EXGG`. **Validou contra os tamanhos de OUTRO produto.**

### Raiz única dos 4 casos

Quando a FSM está em `awaiting_size` / `awaiting_quantity` / `awaiting_more_sizes`, o roteador de texto chama `parseGradeText` / `setSize` contra o **`pf.productId`** (produto em foco) sem olhar se a mensagem tem `quotedMessage` resolvendo um produto diferente. O quote é ignorado e a grade é validada/aplicada no produto errado.

Os 4 casos são **o mesmo bug**. O caso 4 parece "tamanho único quebrado" mas na verdade também é quote-ignorado: o "Tam único" é o único tamanho do `816T`, mas o bot validou contra os tamanhos do `731S`, que era o produto em foco.

---

## 🎯 Regra Correta (implementar)

### R1 — Quote resolve o alvo ANTES da FSM

Em qualquer mensagem de texto que chegar:

1. Extrair `quotedMessage` do payload Z-API (já existe parcialmente — procure por `quotedProductIdx`, `messageProductMap`, `event.message.contextInfo` no `index.js`).
2. Se o quote resolver um produto conhecido (via `session.messageProductMap`, ou via parse do texto do quote procurando referência `Ref \d+[A-Z]?`, ou via match de nome do produto nos `session.products`), **esse é o produto-alvo**. Ele sobrescreve `pf.productId` **para essa mensagem**.
3. Se o produto-alvo ≠ produto atualmente em foco na FSM:
   - Se o produto em foco ainda tem tamanhos não adicionados → snapshot dele vai para `pf.buyQueue` (no topo da fila, não no final, pra não perder prioridade).
   - Se o produto em foco já esgotou tamanhos (ou se `pf.state === 'idle'`) → apenas descarta o foco antigo.
   - Troca o foco: `pf.productId`, `pf.productName`, `pf.price`, `pf.addedSizes = []`, `pf.selectedSize = null`, `pf.interactiveVersion = Date.now()`.
4. **Só depois** disso, roda `parseGradeText(text, product.sizes)` contra o **novo alvo**.

### R2 — Parse de grade contra o produto certo

`parseGradeText` deve receber os tamanhos do produto-alvo (o resolvido pelo quote ou o `pf.productId` atual, nessa ordem). Hoje em alguns paths ele recebe `allSizes` de um escopo fechado — refatorar para sempre tomar o produto resolvido como argumento.

### R3 — Produto de tamanho único pula `awaiting_size`

Em `startInteractivePurchase` (index.js), adicionar short-circuit:

```js
// Após resolver o produto e antes de entrar em awaiting_size
const productSizes = Array.isArray(product.sizes) ? product.sizes.filter(Boolean) : [];

if (productSizes.length === 0) {
  // Produto sem variação de tamanho — tratar como único "padrão"
  pf.selectedSize = 'ÚNICO';
  pf.state = 'awaiting_quantity';
  pf.interactiveVersion = Date.now();
  await sendStockAwareQuantityList(phone, session, pf.selectedSize, pf.interactiveVersion, product);
  return;
}

if (productSizes.length === 1) {
  pf.selectedSize = productSizes[0];
  pf.state = 'awaiting_quantity';
  pf.interactiveVersion = Date.now();
  await zapi.sendText(phone, `📦 *${product.name}* vem em *${productSizes[0]}*. Quantas você quer?`);
  await sendStockAwareQuantityList(phone, session, pf.selectedSize, pf.interactiveVersion, product);
  return;
}

// caso contrário — caminho atual de awaiting_size
```

E no caminho de parse de grade, se o produto tem `sizes.length === 1`, aceitar qualquer número digitado como quantidade do único tamanho (ex: lojista digita só "5" ao dar reply no kit).

### R4 — Normalizador de tamanho canônico

Em `services/woocommerce.js`, expandir `normalizeSizeLabel` para tratar rótulos sinônimos de "tamanho único":

```js
const UNIQUE_SIZE_SYNONYMS = new Set([
  'U', 'UN', 'UNI', 'UNICO', 'ÚNICO',
  'TU', 'TAMUNICO', 'TAM UNICO', 'TAM ÚNICO',
  'UNIVERSAL',
]);

function normalizeSizeLabel(value) {
  const raw = String(value || '').trim().toUpperCase();
  // "Tam único - pct com 5 unidades" → "TAM ÚNICO - PCT COM 5 UNIDADES"
  // Colapsa qualquer variação que comece com "TAM UNICO" / "ÚNICO" em "ÚNICO"
  if (raw.startsWith('TAM ÚNICO') || raw.startsWith('TAM UNICO') || raw.startsWith('ÚNICO') || raw.startsWith('UNICO')) {
    return 'ÚNICO';
  }
  if (UNIQUE_SIZE_SYNONYMS.has(raw)) return 'ÚNICO';
  return raw;
}
```

Cuidado: a comparação de tamanho em `buildSizeDetailsFromVariations` e em `getAvailableSizesForSession` precisa usar o rótulo canônico nas duas pontas (lista vinda do Woo e escolha do usuário), mas a **exibição ao cliente** deve manter o rótulo original do Woo (`Tam único - pct com 5 unidades`), não o canônico.

### R5 — Parser de grade ciente de tamanho único

Em `parseGradeText`, se `knownSizes.length === 1`, aceitar padrões como:
- Só número: `"5"` → `{ size: único, qty: 5 }`
- Número + palavra: `"5 pacotes"`, `"5 un"`, `"5 peças"`
- Número + "do tam único": `"5 do único"`

Hoje o regex exige que o texto contenha um rótulo válido de `knownSizes`. Ajuste para o caso de único tamanho.

---

## 🛠️ Implementação (ordem sugerida)

### Etapa 1 — Resolver o produto-alvo a partir do quote

**Arquivo:** `index.js`, rota do webhook (procure por `app.post('/webhook')` e por `extractQuotedProductFromEvent` / `messageProductMap`).

**Objetivo:** criar uma função única `resolveTargetProduct(session, event, text)` que retorna:
```js
{
  product,              // objeto produto (ou null)
  source,               // 'quote' | 'fsm_focus' | 'last_viewed' | 'none'
  shouldSwitchFocus,    // boolean
}
```

Lógica:
1. Se `event` tem quote com `messageId` em `session.messageProductMap` → retorna esse produto, `source: 'quote'`, `shouldSwitchFocus: true` (se diferente do foco atual).
2. Senão, se o texto do quote contém `Ref \d+[A-Z]?` e a ref bate com algum produto em `session.products` → retorna esse, `source: 'quote'`.
3. Senão, se `pf.productId` está ativo → retorna `session.currentProduct`, `source: 'fsm_focus'`, `shouldSwitchFocus: false`.
4. Senão, se `session.lastViewedProduct` existe → retorna, `source: 'last_viewed'`.
5. Senão → `product: null`.

### Etapa 2 — Trocar foco quando `shouldSwitchFocus === true`

Criar helper `switchFsmFocus(session, newProduct)`:
```js
function switchFsmFocus(session, newProduct) {
  const pf = session.purchaseFlow;

  // Se o foco antigo ainda tinha tamanhos pendentes, enfileira no TOPO da buyQueue
  if (pf.productId && pf.productId !== newProduct.id && pf.state !== 'idle') {
    const oldProduct = getLoadedProductById(session, pf.productId) || session.currentProduct;
    if (oldProduct) {
      const remaining = getAvailableSizesForSession(session, oldProduct, pf.addedSizes || []);
      if (remaining.length > 0 && !pf.buyQueue.some(q => q.productId === oldProduct.id)) {
        pf.buyQueue.unshift({
          productId: oldProduct.id,
          productName: oldProduct.name,
          productSnapshot: oldProduct,
          addedSizes: [...(pf.addedSizes || [])],
        });
        logger.info({ oldProduct: oldProduct.id, newProduct: newProduct.id }, '[FSM] Foco trocado, antigo enfileirado');
      }
    }
  }

  pf.productId = newProduct.id;
  pf.productName = newProduct.name;
  pf.price = parseFloat(newProduct.salePrice || newProduct.price) || 0;
  pf.addedSizes = [];
  pf.selectedSize = null;
  pf.state = 'awaiting_size';
  pf.interactiveVersion = Date.now();
  session.currentProduct = newProduct;
}
```

**Importante:** quando voltar a processar a buyQueue depois que o usuário fechar o novo produto, restaurar `addedSizes` do snapshot pra não recontar tamanhos.

### Etapa 3 — Aplicar R3 (tamanho único) em `startInteractivePurchase`

**Arquivo:** `index.js`, função `startInteractivePurchase` (procure pelo nome).

Adicionar os short-circuits descritos em R3 antes de chamar `sendStockAwareSizeList`.

### Etapa 4 — Aplicar R4 (normalizador) em `services/woocommerce.js`

Atualizar `normalizeSizeLabel` conforme R4. Rodar testes manuais:
- Woo retorna "Tam único - pct com 5 unidades" → exibe original, mas normaliza como "ÚNICO".
- Comparação com `pf.selectedSize` usa valor canônico nos dois lados.

### Etapa 5 — Aplicar R5 (parser de grade) em `parseGradeText`

**Arquivo:** `index.js`, função `parseGradeText` (linha 33).

Adicionar branch `if (knownSizes.length === 1)` que captura só número. Preservar o comportamento atual para multi-tamanho.

### Etapa 6 — Plugar no pipeline de texto

**Arquivo:** `index.js`, onde a mensagem de texto é processada dentro do webhook (busque por `parseGradeText(text, allSizes)` — linhas ~670 e ~1117).

Trocar:
```js
// ANTES
const grade = parseGradeText(text, allSizes);
if (grade) {
  // adiciona ao pf.productId
}
```

Por:
```js
// DEPOIS
const target = resolveTargetProduct(session, event, text);
if (target.shouldSwitchFocus) {
  switchFsmFocus(session, target.product);
}
const effectiveProduct = target.product;
if (!effectiveProduct) {
  // sem produto-alvo — cai no caminho de IA
  return handleAiFallback(...);
}

const effectiveSizes = (effectiveProduct.sizes || []).filter(Boolean);
const grade = parseGradeText(text, effectiveSizes);
if (grade) {
  for (const { size, qty } of grade) {
    session.purchaseFlow.selectedSize = size;
    await addToCart(phone, qty, session);
  }
  return;
}
// senão cai no caminho de IA com effectiveProduct como contexto
```

### Etapa 7 — `messageProductMap` deve cobrir list menus também

**Arquivo:** `index.js`, onde os list menus são enviados (busque por `zapi.sendOptionList` e por `session.messageProductMap[...]`).

Hoje o `messageProductMap` provavelmente cobre só cards de imagem. Garanta que **cada row** do list menu também registre `messageProductMap[optionId] = productId` para que replies em linhas da lista resolvam. Se o WhatsApp retornar o `messageId` do list menu como um todo (não da row), mapear pelo `messageId` do card visual anterior da lista.

Teste manual: dar reply em linha do list menu e ver se `messageProductMap` retorna o produto certo.

---

## ✅ Testes de Aceitação

Reproduzir os 4 casos do Renan e confirmar:

1. Reply em `KIT 3 PEÇAS - 681S` + `1p` → carrinho ganha linha `KIT 3 PEÇAS (P) x1`.
2. Reply em `Pijama bordado - 503L` + `1M` → carrinho ganha linha `Pijama bordado (M) x1`.
3. Reply em `Pijama manga longa - 615S` + `2P 3m` → carrinho ganha 2 linhas: `(P) x2` e `(M) x3`, ambas do 615S.
4. Selecionar `Tam único - pct com 5 unidades` do `Kit c/ 5 calcinhas - 816T` → bot aceita, pergunta quantidade, e adiciona sem cair em "tamanho não disponível".

Testes adicionais:

5. Reply em produto B enquanto FSM está em `awaiting_more_sizes` do produto A, com A ainda tendo tamanhos não comprados → produto A vai pro topo da `buyQueue`, foco vira B, depois de terminar B o bot volta pra A automaticamente via `processNextInQueue`.
6. Reply em produto A quando A **é** o produto em foco → apenas processa a grade, sem churn de foco.
7. Produto de tamanho único + reply com só um número (`"5"`) → adiciona 5 unidades.
8. Reply em produto sem `messageProductMap` mas com `Ref XXXS` no texto do quote → resolve via match de ref.

---

## 📝 Documentação (atualizar junto com o código)

### Obsidian

- `05 - Sessões e Carrinho.md`: adicionar seção **"Troca de foco via reply"** descrevendo o fluxo de `resolveTargetProduct` → `switchFsmFocus` → `buyQueue.unshift`.
- `11 - Catálogo e Regras Comerciais.md`: adicionar seção **"Produtos de tamanho único"** listando sinônimos (`ÚNICO`, `TAM ÚNICO`, `TU`, `U`, `UNIVERSAL`, `PCT`) e o short-circuit da FSM.
- `07 - Histórico e Migrações.md`: registrar ADR novo — **ADR-008: Reply-to como cursor de seleção em B2B**. Explicar que a UX do lojista da Belux é voltar em cards antigos e replicar, e que isso **não é bug** — é a interação esperada. Incluir screenshots como anexo mental.

### Skill

- `.claude/skills/agente-belux/references/arquitetura.md`: atualizar diagrama mermaid do fluxo de compra para mostrar o ramo de "reply em card antigo → troca de foco".
- Criar `.claude/skills/agente-belux/references/quote-reply-logic.md` com:
  - Por que existe
  - Como funciona (`resolveTargetProduct` + `switchFsmFocus` + `buyQueue.unshift`)
  - Testes de aceitação
  - **Aviso grande:** "Isto não é regressão. Não tente consertar eliminando."

### CLAUDE.md (raiz do projeto)

Adicionar bloco no topo, logo após "Identidade e Contexto":

```markdown
## ⚠️ Regra de Negócio Crítica — Reply é Cursor

O lojista B2B da Belux compra dando reply em cards antigos enquanto a FSM
está ocupada com outro produto. O bot DEVE resolver o produto citado no
quote ANTES de processar a grade, e trocar o foco da FSM se necessário.
Isto é feature, não bug. Ver `PLANO-QUOTE-REPLY-E-TAMUNICO.md` e ADR-008.
```

---

## 🚫 O que NÃO fazer

- **Não** remover `parseGradeText` (já existe debate sobre isso em outro plano). Ele continua válido dentro do novo pipeline — só precisa receber o produto certo.
- **Não** forçar o lojista a "cancelar o produto atual" antes de adicionar outro. O reply deve ser transparente.
- **Não** limitar a `buyQueue` a tamanho pequeno agora — lojistas B2B podem ter 50+ itens.
- **Não** validar tamanho usando o rótulo bruto do Woo quando o produto tem só uma variação — use o canônico.
- **Não** tentar "consertar" nas próximas sessões do Claude Code se encontrar essa lógica de troca de foco: ela é intencional.

---

## 📌 Checklist final

- [ ] `resolveTargetProduct` implementado e testado
- [ ] `switchFsmFocus` implementado com `buyQueue.unshift` + restauração de `addedSizes`
- [ ] Short-circuit de tamanho único em `startInteractivePurchase`
- [ ] `normalizeSizeLabel` trata sinônimos de "único"
- [ ] `parseGradeText` aceita só número quando `knownSizes.length === 1`
- [ ] Pipeline de texto do webhook troca `allSizes` hardcoded pelo produto-alvo
- [ ] `messageProductMap` cobre rows de list menus
- [ ] 8 testes de aceitação passando manualmente
- [ ] Obsidian atualizado (`05`, `11`, `07` com ADR-008)
- [ ] Skill atualizada (arquitetura + quote-reply-logic.md)
- [ ] `CLAUDE.md` com o aviso no topo
