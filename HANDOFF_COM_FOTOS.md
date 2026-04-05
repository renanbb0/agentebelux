# Especificação — Handoff com Fotos para a Vendedora

**Projeto:** Agente Belux · **Data:** 2026-04-05
**Arquivo afetado:** `index.js` (função `handoffToConsultant`)
**Status:** 🟢 Implementado — aguardando teste E2E final

---

## Contexto e Problema

Quando o cliente finaliza o pedido, a função `handoffToConsultant` (linha ~1884 do `index.js`) envia para a vendedora (`ADMIN_PHONE`) apenas um **resumo em texto** do carrinho.

**O problema:** na Belux Moda Íntima, **muitos produtos compartilham o mesmo nome de modelo** (ex: "Calcinha Renda") e o site WooCommerce **não possui SKU cadastrado**. A vendedora recebe a mensagem e não consegue identificar qual peça específica separar no estoque — dois itens podem sair com o mesmo nome e tamanho, mas serem modelos diferentes.

---

## Solução: Enviar Foto de Cada Produto

Após o resumo em texto, a função deve enviar **uma imagem por produto único** do carrinho para a vendedora, com legenda contendo:

- Nome do produto
- Tamanhos e quantidades (agrupados por produto)
- Subtotal por produto

A vendedora vê **visualmente** qual peça separar, sem depender de SKU.

---

## Dados Disponíveis na Sessão

### Itens do carrinho (`session.items`)

```javascript
{
  productId: 123,
  productName: "Calcinha Renda",
  size: "M",
  quantity: 3,
  unitPrice: 39.90,
  price: 119.70, // subtotal = unitPrice * quantity
}
```

### Produtos da página ativa (`session.products`)

Contém os produtos carregados do WooCommerce, com o campo `imageUrl` (primeira foto) e `images` (todas as fotos). Cada produto tem `id` que bate com `productId` do item.

```javascript
{
  id: 123,
  name: "Calcinha Renda",
  price: "39.90",
  salePrice: "35.90",
  imageUrl: "https://belux.com.br/.../calcinha.jpg",
  images: ["url1", "url2"],
  sizes: ["P", "M", "G", "GG"],
  // ...
}
```

### ⚠️ Possível problema — produto pode não estar mais em `session.products`

Se o cliente navegou por várias categorias durante a compra, `session.products` agora pode conter apenas os produtos da **última categoria vista**, não os que estão no carrinho. Solução: **persistir o `imageUrl` no item do carrinho** na hora de adicionar.

---

## Implementação

### Passo 1 — Persistir `imageUrl` nos itens do carrinho

**Arquivo:** `index.js`
**Função afetada:** `addToCart` (linha ~1306)

Localizar o bloco:

```javascript
session.items.push({
  productId: pf.productId,
  productName: pf.productName,
  size: pf.selectedSize,
  quantity: qty,
  unitPrice,
  price,
});
```

**Adicionar campo `imageUrl`:**

```javascript
// Buscar imageUrl do produto atual (se ainda estiver em session.products)
const productRef = session.products?.find(p => p.id === pf.productId);
const imageUrl = productRef?.imageUrl || null;

session.items.push({
  productId: pf.productId,
  productName: pf.productName,
  size: pf.selectedSize,
  quantity: qty,
  unitPrice,
  price,
  imageUrl, // ← novo campo
});
```

**Fazer a mesma alteração em `pushCartItem` (linha ~1282)**, que é usada pelo grade parser para inserção em lote:

```javascript
function pushCartItem(session, productId, productName, size, qty, unitPrice, imageUrl = null) {
  if (!productId || !size || !qty || qty < 1) return;
  const price = unitPrice * qty;
  session.items.push({ productId, productName, size, quantity: qty, unitPrice, price, imageUrl });
  // ...
}
```

Quem chama `pushCartItem` deve passar o `imageUrl` do produto correspondente em `session.products`.

---

### Passo 2 — Adicionar helper `buildProductGroupsFromCart`

Agrupar os itens do carrinho por `productId` (juntando tamanhos/quantidades de produtos iguais em um único bloco).

**Adicionar logo após `buildCartSummary` (linha ~1580):**

```javascript
/**
 * Agrupa os itens do carrinho por productId para envio visual à vendedora.
 * Cada grupo contém: productId, productName, imageUrl, variações (size+qty) e subtotal.
 */
function buildProductGroupsFromCart(session) {
  const groups = {};

  for (const item of session.items) {
    const key = item.productId;
    if (!groups[key]) {
      groups[key] = {
        productId: item.productId,
        productName: item.productName,
        imageUrl: item.imageUrl || null,
        variations: [], // [{ size, quantity, unitPrice }]
        subtotal: 0,
        totalPieces: 0,
      };
    }
    groups[key].variations.push({
      size: item.size,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    });
    groups[key].subtotal += item.price;
    groups[key].totalPieces += item.quantity;
  }

  return Object.values(groups);
}
```

---

### Passo 3 — Refatorar `handoffToConsultant` para enviar fotos

**Arquivo:** `index.js`
**Função afetada:** `handoffToConsultant` (linha ~1884)

O fluxo atual envia apenas texto. Deve ser ampliado para:

1. Montar resumo em texto (mantém o atual `buildCartSummary`)
2. Enviar ao cliente (mantém como está)
3. Enviar ao admin o **texto-resumo**
4. **Novo:** agrupar itens por produto com `buildProductGroupsFromCart`
5. **Novo:** para cada grupo, enviar foto com legenda detalhada
6. Resetar flow e marcar handoffDone

**Código sugerido (substituindo apenas o bloco "Notify the admin"):**

```javascript
// ── 2. Notify the admin (ADMIN_PHONE) ──────────────────────────────────
if (ADMIN_PHONE) {
  // 2a. Enviar resumo em texto
  const adminHeader =
    `📦 *NOVO PEDIDO — Agente Belux*\n` +
    `─────────────────\n` +
    `📱 *Lojista:* wa.me/${phone}\n` +
    (session.customerName ? `👤 *Nome:* ${session.customerName}\n` : '') +
    `─────────────────\n` +
    `${summary}\n\n` +
    `📸 _Enviando fotos dos produtos a seguir..._`;

  try {
    await zapi.sendText(ADMIN_PHONE, adminHeader);
    logger.info({ phone, adminPhone: ADMIN_PHONE }, '[Handoff] Text summary sent to admin');

    // 2b. Enviar uma foto por grupo de produto
    const groups = buildProductGroupsFromCart(session);
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const variationsText = g.variations
        .map(v => `${v.size} x${v.quantity}`)
        .join(' · ');

      const caption =
        `📦 *Produto ${i + 1}/${groups.length}*\n` +
        `*${g.productName}*\n` +
        `Tamanhos: ${variationsText}\n` +
        `Total: ${g.totalPieces} ${g.totalPieces === 1 ? 'peça' : 'peças'} — ${woocommerce.formatPrice(g.subtotal)}`;

      if (g.imageUrl) {
        try {
          await zapi.sendImage(ADMIN_PHONE, g.imageUrl, caption);
          await zapi.delay(400); // evita flood Z-API
        } catch (err) {
          logger.error({ err: err?.message, productId: g.productId }, '[Handoff] Falha ao enviar foto, fallback para texto');
          await zapi.sendText(ADMIN_PHONE, caption);
        }
      } else {
        // Fallback: produto sem imagem — envia só texto
        await zapi.sendText(ADMIN_PHONE, caption + '\n⚠️ _Produto sem foto cadastrada._');
      }
    }

    logger.info({ phone, groupCount: groups.length }, '[Handoff] Photos forwarded to admin');
  } catch (err) {
    logger.error({ err: err?.message || String(err), adminPhone: ADMIN_PHONE }, '[Handoff] Failed to notify admin');
  }
} else {
  logger.warn({ phone }, '[Handoff] ADMIN_PHONE not configured — skipping admin notification');
}
```

---

## Exemplo do Fluxo Completo (visão da vendedora)

A vendedora recebe a seguinte sequência no WhatsApp:

### Mensagem 1 (texto):
```
📦 NOVO PEDIDO — Agente Belux
─────────────────
📱 Lojista: wa.me/5585999999999
👤 Nome: Maria Silva
─────────────────
🛒 RESUMO DO SEU PEDIDO
─────────────────
1. Calcinha Renda (M) x3 — R$ 119,70
2. Calcinha Renda (G) x2 — R$ 79,80
3. Sutiã Strappy (M) x1 — R$ 89,90
─────────────────
💰 Total: R$ 289,40

📸 Enviando fotos dos produtos a seguir...
```

### Mensagem 2 (imagem):
```
[foto do produto 1]
📦 Produto 1/2
Calcinha Renda
Tamanhos: M x3 · G x2
Total: 5 peças — R$ 199,50
```

### Mensagem 3 (imagem):
```
[foto do produto 2]
📦 Produto 2/2
Sutiã Strappy
Tamanhos: M x1
Total: 1 peça — R$ 89,90
```

---

## Checklist de Testes

Após implementar, testar:

- [ ] Adicionar produto A (2 tamanhos diferentes) ao carrinho
- [ ] Adicionar produto B (1 tamanho) ao carrinho
- [x] Verificar no Supabase que `items[].imageUrl` está preenchido ✅ *validado em 2026-04-05*
- [ ] Finalizar pedido (botão "Finalizar" ou `[HANDOFF]`)
- [ ] Cliente recebe confirmação em texto ✓
- [ ] Vendedora recebe 1 texto-resumo + 2 imagens (1 por produto)
- [ ] Legenda de cada foto traz nome, tamanhos agrupados e subtotal corretos
- [ ] Caso borda: produto sem foto → envia só texto com aviso
- [ ] Caso borda: 1 produto, 1 tamanho → apenas 1 imagem com legenda curta
- [ ] Caso borda: 5+ produtos → delay de 400ms evita flood

---

## Guardrails

- ❌ **NÃO** exponha o número do cliente em logs públicos.
- ❌ **NÃO** envie fotos se `ADMIN_PHONE` estiver `null` — apenas log de warning.
- ❌ **NÃO** trave o handoff se uma foto falhar — usar fallback para texto.
- ✅ **USE** `zapi.delay(400)` entre envios para evitar rate limit.
- ✅ **PRESERVE** `session.items` após o handoff (mantém auditoria).

---

## Atualização Pós-Implementação

Após codificar, atualizar os seguintes arquivos no vault Obsidian (`D:\obsidian\Agente Belux\Agente Belux Docs`):

1. **`01 - Fluxo de Vendas.md`** — adicionar seção "Handoff com Fotos" descrevendo o fluxo visual.
2. **`05 - Sessões e Carrinho.md`** — documentar novo campo `imageUrl` nos itens.
3. **`07 - Histórico e Migrações.md`** — adicionar ADR-006: "Handoff visual com fotos por produto".

E atualizar na skill `agente-belux`:
- `references/arquitetura.md` — seção "Finalização de Pedido" deve incluir o envio de fotos.
