# Análise Detalhada: Os 2 Erros no Fluxo de Compra do Bela Belux

**Projeto:** Bela Belux  
**Autor:** Manus AI  
**Data:** 04 de Abril de 2026  
**Objetivo:** Identificar e documentar os dois erros específicos no fluxo de compra para orientar a correção no Claude Code.

---

## Resumo Executivo

Foram identificados **2 erros distintos** no fluxo de compra interativo do Bela Belux:

1. **Erro #1 - Repetição Infinita da Pergunta de Tamanho:** Após o usuário clicar em "Escolher Tamanho" (botão verde), o bot pergunta qual tamanho deseja, mas não processa corretamente a seleção do tamanho. Em vez disso, reenvia a mesma pergunta repetidamente.

2. **Erro #2 - Mudança Incorreta de Contexto de Produto:** Quando o usuário clica em "Eu quero ver mais fotos dele" enquanto está em um fluxo de compra ativo, o bot muda para um produto diferente (enviando fotos do novo produto), mas depois volta a enviar fotos do produto anterior, criando confusão e quebra de contexto.

---

## Erro #1: Repetição Infinita da Pergunta de Tamanho

### Descrição do Problema

Quando o usuário clica no botão "Escolher Tamanho" (que vem de uma lista de opções), o seguinte fluxo deveria ocorrer:

1. ✅ Z-API envia um evento com `listResponseMessage.selectedRowId = "size_422_P_v12345"`
2. ✅ O webhook intercepta esse evento (linha 365 do `index.js`)
3. ✅ A função `handlePurchaseFlowEvent` processa o evento `size_`
4. ✅ O tamanho é armazenado em `session.purchaseFlow.selectedSize`
5. ✅ O estado muda para `awaiting_quantity`
6. ✅ Uma lista de quantidades é enviada ao usuário
7. ✅ O fluxo aguarda o usuário clicar em uma quantidade

**O que realmente acontece:**
- O bot envia a pergunta de tamanho novamente
- O usuário clica em um tamanho
- O bot envia a pergunta de tamanho NOVAMENTE
- Ciclo infinito

### Causa Raiz Identificada

A análise do código revelou que a função `handlePurchaseFlowEvent` **não está sendo chamada corretamente ou não existe completamente**. Embora o código na linha 365 do `index.js` tente chamar essa função:

```javascript
// index.js - Linha 365-370
if (fsmEventId && /^(buy_|size_|qty_|add_size_|skip_more_)/.test(fsmEventId)) {
  if (messageId) zapi.readMessage(from, messageId);
  logger.info({ from, fsmEventId }, '[FSM] Evento interativo capturado');
  const session = await getSession(from);
  await handlePurchaseFlowEvent(from, fsmEventId, session);  // ← ESTA FUNÇÃO NÃO EXISTE
  persistSession(from);
  return;
}
```

**O código que DEVERIA estar em `handlePurchaseFlowEvent` para processar `size_` está em outro lugar** (linhas 1478-1510 do `index.js`), mas **não é chamado quando o evento chega**. Isso causa:

1. O webhook recebe o evento `size_422_P_v12345`
2. Tenta chamar `handlePurchaseFlowEvent` (que não existe ou está vazia)
3. A função falha silenciosamente ou retorna sem fazer nada
4. A sessão **não é atualizada** com o tamanho selecionado
5. O estado permanece em `awaiting_size` (não muda para `awaiting_quantity`)
6. A próxima vez que o usuário interage, o bot ainda acha que está aguardando tamanho
7. Reenvia a pergunta de tamanho

### Código Problemático

**Localização 1:** `index.js` - Linhas 1478-1510 (código que processa `size_` mas não é chamado)

```javascript
if (eventId.startsWith('size_')) {
  // Formato: size_422_P_v1234567890  → remove prefixo e sufixo de versão
  const withoutPrefix = eventId.slice('size_'.length);              // '422_P_v1234567890'
  const vIdx = withoutPrefix.lastIndexOf('_v');
  const withoutVersion = vIdx >= 0 ? withoutPrefix.slice(0, vIdx) : withoutPrefix;  // '422_P'
  const firstUnderscore = withoutVersion.indexOf('_');
  const productIdStr = withoutVersion.slice(0, firstUnderscore);    // '422'
  const size = withoutVersion.slice(firstUnderscore + 1);           // 'P'
  const product = session.products?.find(p => String(p.id) === productIdStr)
               || session.products?.find(p => p.id === pf.productId);
  
  // ... validações ...
  
  pf.productId = product.id;
  pf.productName = product.name;
  pf.price = parseFloat(product.salePrice || product.price);
  pf.selectedSize = size;
  pf.state = 'awaiting_quantity';  // ← ESTADO DEVERIA MUDAR AQUI
  pf.interactiveVersion = Date.now();
  
  logger.info({ phone, productId: product.id, size }, '[FSM] size_ → awaiting_quantity');
  await zapi.sendQuantityList(phone, size, pf.interactiveVersion);  // ← LISTA DE QUANTIDADE DEVERIA SER ENVIADA
  return;
}
```

Este código **existe** mas **não é executado** porque está dentro de uma função que não é chamada.

### Solução para o Claude Code

O Claude Code deve:

1. **Restaurar a função `handlePurchaseFlowEvent`** que deve conter toda a lógica de processamento de eventos FSM (`buy_`, `size_`, `qty_`, `add_size_`, `skip_more_`).

2. **Consolidar o código disperso:** O código que processa `size_` (linhas 1478-1510) deve ser movido DENTRO da função `handlePurchaseFlowEvent`.

3. **Garantir que a função seja chamada:** Verificar que a linha 369 (`await handlePurchaseFlowEvent(from, fsmEventId, session);`) realmente executa a função e não falha.

---

## Erro #2: Mudança Incorreta de Contexto de Produto

### Descrição do Problema

Quando o usuário está em um fluxo de compra ativo (ex: escolhendo tamanho do "Conjunto Básico Chocolate - Ref 422") e clica em "Eu quero ver mais fotos dele" (respondendo a uma mensagem anterior de um produto diferente, como "Conjunto com bojo VERDE TEOS - Ref 401L"), o seguinte acontece:

1. ✅ O bot reconhece que o usuário quer ver mais fotos
2. ✅ O bot começa a enviar fotos do novo produto (Ref 401L)
3. ❌ **Mas depois volta a enviar fotos do produto anterior (Ref 422)**
4. ❌ O contexto fica confuso e o fluxo quebra

### Causa Raiz Identificada

O problema está na **lógica de migração de foco de produto** (linhas 469-488 do `index.js`). Quando o usuário cita uma mensagem anterior, o código tenta migrar o foco do produto para o que foi citado:

```javascript
// index.js - Linhas 469-488
const pfGrade = session.purchaseFlow;
if (pfGrade.state !== 'idle' && pfGrade.productId) {
  // Se o cliente citou um produto diferente do que está em foco, migrar o foco
  const quoteRefId = body?.referenceMessageId
    || body?.quotedMessage?.messageId
    || body?.quotedMessage?.stanzaId
    || body?.quotedMessage?.id;
  if (quoteRefId && session.messageProductMap?.[quoteRefId]) {
    const mapped = session.messageProductMap[quoteRefId];
    if (mapped.productId !== pfGrade.productId) {
      const productStillLoaded = session.products?.some(p => p.id === mapped.productId);
      if (productStillLoaded) {
        const quotedProd = session.products.find(p => p.id === mapped.productId);
        logger.info(
          { prev: pfGrade.productId, next: mapped.productId, prevName: pfGrade.productName, nextName: quotedProd?.name },
          '[Grade] Migrando foco do produto via quote reply'
        );
        pfGrade.productId = mapped.productId;        // ← MUDA PARA O NOVO PRODUTO
        pfGrade.productName = quotedProd?.name || pfGrade.productName;
        pfGrade.unitPrice = parseFloat(quotedProd?.salePrice || quotedProd?.price);
        pfGrade.addedSizes = [];
      }
    }
  }
}
```

**O problema:** Este código muda o foco do produto (`pfGrade.productId`) para o produto citado, **MAS APENAS TEMPORARIAMENTE**. Depois que a IA processa a mensagem e responde com "Eu quero ver mais fotos dele", a IA chama a ação `FOTOS` que chama `showProductPhotos(phone, parseInt(action.payload, 10), session)`.

**Localização 2:** `index.js` - Função `executeAction` (linhas 1015-1040)

```javascript
case 'FOTOS':
  await showProductPhotos(phone, parseInt(action.payload, 10), session);
  break;
```

**O problema:** O `action.payload` contém o **índice do produto na lista original**, não o ID do produto. Quando o usuário citou um produto diferente, o `action.payload` ainda aponta para o índice do produto ANTERIOR, não do novo.

**Exemplo do fluxo quebrado:**
1. Usuário vê "Conjunto Básico Chocolate - Ref 422" (índice 1 na lista)
2. Usuário vê "Conjunto com bojo VERDE TEOS - Ref 401L" (índice 2 na lista)
3. Usuário clica em "Eu quero ver mais fotos dele" **citando a mensagem do Ref 401L**
4. O código muda `pfGrade.productId` para 401L (Ref 401L)
5. A IA processa e gera `action.payload = "1"` (índice do produto anterior, porque foi o último visto)
6. `showProductPhotos` é chamado com índice 1, que aponta para Ref 422
7. Fotos do Ref 422 são enviadas (ERRADO!)

### Código Problemático

**Localização 2:** `index.js` - Função `showProductPhotos` (linhas 1566-1620)

```javascript
async function showProductPhotos(phone, index, session) {
  const product = session.products[index - 1];  // ← USA ÍNDICE, NÃO ID
  if (!product) {
    await zapi.sendText(phone, `❌ Produto #${index} não encontrado.`);
    return;
  }
  // ... resto do código ...
}
```

O problema é que `showProductPhotos` recebe um **índice** (`index`), mas quando o contexto de produto foi migrado, o índice já não é mais válido.

### Solução para o Claude Code

O Claude Code deve:

1. **Modificar `showProductPhotos`** para aceitar um **ID de produto** em vez de um índice, ou adicionar lógica para detectar qual produto está em foco (`session.purchaseFlow.productId`).

2. **Atualizar a ação `FOTOS`** no `executeAction` para passar o ID do produto em foco, não o índice:
   ```javascript
   case 'FOTOS':
     // Em vez de usar action.payload (índice), usar o produto em foco
     const focusedProductId = session.purchaseFlow?.productId || parseInt(action.payload, 10);
     const focusedProduct = session.products?.find(p => p.id === focusedProductId);
     if (focusedProduct) {
       const focusedIndex = session.products.indexOf(focusedProduct) + 1;
       await showProductPhotos(phone, focusedIndex, session);
     }
     break;
   ```

3. **Garantir que `registerMessageProduct`** está sendo chamado corretamente para manter o mapa de mensagens → produtos atualizado.

---

## Tabela Comparativa: Comportamento Esperado vs. Atual

| Etapa | Esperado | Atual | Erro |
|-------|----------|-------|------|
| 1. Usuário clica "Escolher Tamanho" | Webhook recebe `size_422_P_v123` | ✅ Webhook recebe corretamente | - |
| 2. FSM processa evento | `handlePurchaseFlowEvent` é chamada | ❌ Função não existe/não é chamada | **Erro #1** |
| 3. Estado muda para `awaiting_quantity` | `pf.state = 'awaiting_quantity'` | ❌ Estado permanece em `awaiting_size` | **Erro #1** |
| 4. Lista de quantidade é enviada | `sendQuantityList` é executada | ❌ Não é executada | **Erro #1** |
| 5. Usuário cita outro produto | Foco muda para novo produto | ✅ Foco muda temporariamente | - |
| 6. IA gera ação `FOTOS` | Usa ID do produto em foco | ❌ Usa índice antigo | **Erro #2** |
| 7. Fotos são enviadas | Fotos do novo produto | ❌ Fotos do produto anterior | **Erro #2** |

---

## Recomendações para o Claude Code

1. **Prioridade Alta:** Restaurar/criar a função `handlePurchaseFlowEvent` e garantir que ela seja chamada quando eventos FSM chegam ao webhook.

2. **Prioridade Alta:** Consolidar toda a lógica de processamento de eventos FSM (`buy_`, `size_`, `qty_`, `add_size_`, `skip_more_`) dentro de uma única função bem estruturada.

3. **Prioridade Média:** Refatorar `showProductPhotos` para aceitar ID de produto em vez de índice, ou adicionar lógica para detectar o produto em foco.

4. **Prioridade Média:** Adicionar testes para verificar que o estado FSM muda corretamente após cada clique em botão.

5. **Prioridade Baixa:** Adicionar logs mais detalhados para rastrear mudanças de estado e contexto de produto.

---

## Conclusão

Os dois erros são causados por:
1. **Erro #1:** Função `handlePurchaseFlowEvent` não está sendo executada, impedindo que eventos FSM sejam processados.
2. **Erro #2:** Lógica de mudança de contexto usa índices em vez de IDs, causando desincronização quando o foco do produto muda.

Ambos os erros podem ser corrigidos com modificações estruturadas no `index.js` e possivelmente em `services/zapi.js`.
