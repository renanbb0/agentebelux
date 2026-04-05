# Relatório — Funções Ausentes (`index.js`)

**Projeto:** Agente Belux · **Data:** 2026-04-04
**Arquivo afetado:** `index.js`

---

## Problema

6 funções são chamadas em runtime mas **nunca foram definidas** no arquivo.
O Node lança `ReferenceError` silenciosamente — o bot para de responder sem nenhuma mensagem de erro visível para o lojista.

Todas devem ser adicionadas **ao final do `index.js`**, após a função `showAllCategory` (última definição do arquivo, linha ~1653).

Após implementar, rodar:

```bash
node --check index.js
```

---

## Mapa de Impacto

| Função ausente | Linha(s) chamada | Ativada quando |
|---|---|---|
| `sendProductPage` | 1646 | Qualquer `[VER:categoria]` — exibir página de produtos |
| `showNextPage` | 1031 | Token `[PROXIMOS]` — botão "Ver Mais Produtos" |
| `showProductPhotos` | 848, 870, 1035 | Token `[FOTOS:N]`, pedido de fotos, quote reply em imagem |
| `clearCart` | 409, 1142 | Texto "limpar carrinho", token `[LIMPAR_CARRINHO]` |
| `searchAndShowProducts` | 1027 | Token `[BUSCAR:termo]` |
| `handoffToConsultant` | 1186, 1308 | Token `[HANDOFF]`, botão Finalizar com fila pendente |

---

## Ordem de Implementação Recomendada

1. `sendProductPage` — desbloqueia imediatamente `[VER:categoria]` e "Ver Mais Produtos"
2. `showNextPage` — desbloqueia `[PROXIMOS]`
3. `clearCart` — desbloqueia limpeza de carrinho
4. `showProductPhotos` — desbloqueia pedidos de foto
5. `searchAndShowProducts` — desbloqueia `[BUSCAR:termo]`
6. `handoffToConsultant` — desbloqueia finalização do pedido

---

## Especificações

### 1. `sendProductPage`

```js
async function sendProductPage(phone, result, session, startIdx = 0)
```

**O que faz:** Exibe uma página de produtos — envia texto-lista numerado, depois envia cada produto via `sendProductShowcase` (com fallback para `sendImage`). Registra cada mensagem no `messageProductMap`. Ao final, chama a IA para comentar e encerra com `sendCategoryMenu` ou `sendCartOptions`.

**Referência direta:** `showAllCategory` (linha 1653) usa o mesmo padrão. A diferença é que `sendProductPage` trabalha com `result.products` (página atual) e `startIdx` para numeração correta.

**Contexto disponível:**
- `result.products` — array de produtos desta página
- `result.total` — total de produtos na categoria
- `session.currentCategory` — slug da categoria ativa
- `session.currentPage` / `session.totalPages` — para montar nudge de paginação
- `session.items` — para decidir entre `sendCategoryMenu` vs `sendCartOptions` ao final
- `session.purchaseFlow.interactiveVersion` — versão compartilhada por todos os botões do lote (gerar UMA VEZ com `Date.now()` antes do loop)
- `registerMessageProduct(session, zaapId, messageId, product)` — registrar cada showcase
- `woocommerce.buildCaption(product, numero)` — caption do fallback de imagem
- `woocommerce.formatPrice(p.salePrice || p.price)` — formatação de preço
- `zapi.sendProductShowcase`, `zapi.sendImage`, `zapi.delay(400)`

**Nudge para a IA ao final:**
- Se `session.currentPage < session.totalPages`: informar que há mais produtos e sugerir `[PROXIMOS]`
- Senão: informar que todos os produtos da categoria foram mostrados

---

### 2. `showNextPage`

```js
async function showNextPage(phone, session)
```

**O que faz:** Verifica se há próxima página disponível, busca do WooCommerce, acumula em `session.products` e chama `sendProductPage`.

**Guards necessários:**
- Se `!session.currentCategory` ou `session.currentPage >= session.totalPages` → `zapi.sendText` informando que todos os produtos já foram mostrados

**Contexto disponível:**
- `session.currentCategory` — slug para buscar
- `session.currentPage` — página atual; buscar `currentPage + 1`
- `woocommerce.getProductsByCategory(slug, 10, nextPage)`
- `startIdx` deve ser calculado como `session.products.length` **antes** de acumular, para numeração correta
- `session.products = [...session.products, ...result.products]` — acumula, não substitui
- `session.currentPage = result.page` — atualizar após busca

---

### 3. `showProductPhotos`

```js
async function showProductPhotos(phone, productIdx, session)
```

**O que faz:** Envia todas as fotos do produto número `productIdx` da lista atual. A primeira foto usa `buildCaption` completo; as seguintes usam legenda curta "Foto 2/3", "Foto 3/3" etc.

**Guards necessários:**
- `productIdx` inválido (< 1 ou > `session.products.length`) → `zapi.sendText` pedindo número válido
- Produto sem imagens (`!product.images?.length && !product.imageUrl`) → `zapi.sendText` informando que não há fotos

**Contexto disponível:**
- `session.products[productIdx - 1]` — produto alvo
- `product.images` — array com URLs de **todas** as fotos (campo preservado pelo `formatProduct` do woocommerce desde a linha 128 do serviço)
- `product.imageUrl` — primeira foto (fallback se `images` estiver vazio)
- `woocommerce.buildCaption(product, productIdx)` — legenda da primeira foto
- `zapi.sendImage(phone, url, caption)` — envio individual
- `zapi.delay(300)` — delay entre fotos

**Após enviar:** atualizar `session.lastViewedProduct = product` e `session.lastViewedProductIndex = productIdx`. Registrar a última imagem enviada no `messageProductMap`.

---

### 4. `clearCart`

```js
async function clearCart(phone, session)
```

**O que faz:** Esvazia o carrinho, reseta o estado de compra e confirma para o lojista.

**Sequência:**
1. `session.items = []`
2. `resetPurchaseFlow(session)` — já existe na linha 1466, reseta preservando a `buyQueue`
3. `session.currentProduct = null`
4. Enviar mensagem carismática de confirmação
5. Chamar `sendCategoryMenu(phone, textoConfirmação)` para redirecionar o lojista

**Observação:** `resetPurchaseFlow` já existe e deve ser usada — não implementar a lógica de reset manualmente.

---

### 5. `searchAndShowProducts`

```js
async function searchAndShowProducts(phone, term, session)
```

**O que faz:** Busca produtos por termo livre no WooCommerce, atualiza a sessão e exibe os resultados via showcases (mesmo padrão de `showAllCategory`).

**Sequência:**
1. `sendLoadingMessage(phone, '🔍 Buscando...', fraseVoz)` — já existe na linha 1193
2. `woocommerce.searchProducts(term, 20)` — existe na linha 76 do serviço, retorna array formatado
3. Se nenhum resultado → `zapi.sendText` + `sendCategoryMenu`
4. Se encontrou → atualizar sessão:
   - `session.products = resultado`
   - `session.currentCategory = 'busca'`
   - `session.currentPage = 1`
   - `session.totalPages = 1`
5. Enviar texto-lista + loop de showcases (igual `showAllCategory`)
6. Nudge à IA + `ai.chat` + `sendCategoryMenu` ou `sendCartOptions`

**Referência:** `woocommerce.searchProducts` (linha 76 de `services/woocommerce.js`) retorna os mesmos campos de `getProductsByCategory` — mesma estrutura de produto.

---

### 6. `handoffToConsultant`

```js
async function handoffToConsultant(phone, session)
```

**O que faz:** Encerra o atendimento automatizado, envia resumo do pedido para o lojista e notifica o administrador.

**Sequência:**
1. Montar resumo com `buildCartSummary(session)` — já existe na linha 1511, retorna `{ summary, total }`
2. Enviar para o lojista: resumo do carrinho + mensagem humanizada de que um consultor vai confirmar em breve
3. Se `ADMIN_PHONE` estiver configurado (linha 19, pode ser `null`): encaminhar resumo + número do lojista para o admin via `zapi.sendText(ADMIN_PHONE, mensagem)`
4. Chamar `resetPurchaseFlow(session)` — **não** limpar `session.items` (o pedido foi feito)
5. Marcar `session.handoffDone = true` para evitar disparos duplicados

**Variáveis disponíveis:**
- `ADMIN_PHONE` — linha 19, pode ser `null` (pular envio ao admin se nulo)
- `buildCartSummary(session)` — linha 1511
- `woocommerce.formatPrice(total)` — formatação do valor final
- `phone` — número do lojista (incluir na mensagem ao admin para facilitar o atendimento)

---

## Guard Adicional — Alucinação durante FSM ativa

Além das funções, há uma brecha de lógica identificada: a IA pode emitir tokens de navegação (`[VER:*]`, `[BUSCAR:*]`, `[PROXIMOS]`, `[SELECIONAR:*]`) enquanto o `purchaseFlow` está ativo, sobrescrevendo `session.products` no meio de uma compra.

Adicionar o seguinte bloco no webhook, **imediatamente antes do `if (action)`** que chama `executeAction` (linha ~999):

```js
// Guard: bloqueia tokens de navegação durante fluxo de compra ativo
if (action && ['VER', 'VER_TODOS', 'BUSCAR', 'PROXIMOS', 'SELECIONAR'].includes(action.type)) {
  if (session.purchaseFlow?.state !== 'idle') {
    logger.info(
      { actionType: action.type, pfState: session.purchaseFlow.state },
      '[Guard] Token de navegação bloqueado — FSM ativa'
    );
    action = null;
  }
}
```

---

## Checklist de Testes

Após implementar, testar o fluxo completo:

- [ ] `[VER:feminino]` → exibe categoria com showcases e botões Comprar
- [ ] `[PROXIMOS]` → carrega próxima página numerada corretamente
- [ ] `[FOTOS:2]` → envia todas as fotos do produto 2
- [ ] `[BUSCAR:pijama]` → busca e exibe resultados
- [ ] "limpar carrinho" → esvazia e redireciona para categorias
- [ ] `[HANDOFF]` / Finalizar Pedido → envia resumo ao lojista e ao admin
- [ ] Token `[VER:*]` durante compra ativa → descartado pelo guard
