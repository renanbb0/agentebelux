---
name: quote-reply-logic
description: Lógica de resolução de produto via reply (quote) e troca de foco da FSM — essencial para o modelo B2B da Belux
type: reference
---

# Quote Reply como Cursor de Seleção B2B

> ⚠️ **ISTO É FEATURE, NÃO BUG.** Não tente "consertar" removendo esta lógica.
> Ver ADR-022 em `07 - Histórico e Migrações.md`.

## Por que existe

A Belux é atacado de moda íntima. O lojista típico:
1. Pede "quero ver feminino" → recebe 5 pages de 10 produtos.
2. Rola o chat de volta, **dá reply em cards antigos** digitando a grade ("3P 5M 2G").
3. Faz isso 20–50 vezes no mesmo pedido.

**O reply do WhatsApp é o cursor de seleção do lojista.** Não é ruído.

## Como funciona

### `resolveTargetProduct` (embutido no grade pipeline)

```
1. Extrair quoteRefId = body.referenceMessageId || quotedMessage.messageId
2. Buscar session.messageProductMap[quoteRefId]
3. Se found && productId ≠ pf.productId → switchFsmFocus(session, quotedProd)
4. Produto pode não estar em session.products → resolveProductById(session, id)
```

### `switchFsmFocus(session, newProduct)` — index.js

```js
// Se produto em foco tem tamanhos pendentes → snapshot no TOPO da buyQueue
pf.buyQueue.unshift({ productId, productName, productSnapshot, addedSizes });
// Troca foco
pf.productId = newProduct.id;
pf.addedSizes = [];
pf.state = 'awaiting_size';
```

**`unshift` (topo), não `push` (fim).** O lojista interrompeu o produto atual — ao terminar o novo, retorna automaticamente ao anterior via `processNextInQueue`.

### `processNextInQueue` restaura `addedSizes`

Quando avança para o próximo da fila, restaura `pf.addedSizes = next.addedSizes` para não repetir tamanhos já adicionados antes da interrupção.

## Testes de aceitação

| Cenário | Comportamento esperado |
|---------|------------------------|
| Reply em Produto B, FSM ativa no Produto A | A → top of buyQueue; foco vira B; depois de B o bot volta para A |
| Reply em Produto A quando A **é** o foco | Apenas processa a grade, sem troca |
| Reply em produto fora de `session.products` | `resolveProductById` busca no Woo; troca de foco funciona |
| FSM idle + reply em card | Grade processada direto no produto citado (path FSM-idle) |

## O que NÃO fazer

- **Não** remover `switchFsmFocus` achando que é "confuso"
- **Não** forçar o lojista a cancelar o produto atual antes de citar outro
- **Não** limitar a `buyQueue` a tamanho pequeno — lojistas B2B podem ter 50+ itens
- **Não** reportar como regressão o fato de o bot aceitar grades de cards antigos
