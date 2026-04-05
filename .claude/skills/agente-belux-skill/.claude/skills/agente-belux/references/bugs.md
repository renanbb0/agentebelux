# Bugs Conhecidos — Referência de Troubleshooting

> Consulte ANTES de corrigir qualquer bug. Evita repetir abordagens que já falharam.
> Atualizado em: 2026-04-04

---

## Bug #1 — Produto não identificado ao citar vitrine/foto (CRÍTICO)

**⚠️ CAUSA RAIZ IDENTIFICADA EM 2026-04-04 — ver [[fix-resolver-produto-citado]] para o plano completo.**

### Sintoma
Cliente faz reply (cita) a uma vitrine de produto (button-list) ou foto e digita qualquer coisa ("tem mais foto?", "Quero 3 P dessa", etc.). A Bela não identifica o produto e pergunta qual peça o cliente gostou — como se o reply não existisse.

### Causa raiz real (investigação de 2026-04-04)

A implementação do `messageProductMap` (Track 2) foi aplicada com duas premissas erradas descobertas consultando a documentação oficial da Z-API:

**Premissa 1 errada:** "o `zaapId` retornado ao enviar é o mesmo ID que aparece no `quotedMessage` do webhook."
- **Realidade:** A Z-API retorna dois IDs distintos: `zaapId` (ID interno Z-API) e `messageId` (ID real do WhatsApp). Só o `messageId` aparece no webhook.

**Premissa 2 errada:** "o ID da mensagem citada fica em `body.quotedMessage.messageId`."
- **Realidade:** A Z-API envia o ID da mensagem citada em `body.referenceMessageId` na **raiz do body**, não dentro de `quotedMessage`. Para mensagens de botão, `quotedMessage` pode estar ausente.

### Tentativas anteriores (NÃO REPETIR)
1. ❌ Chain de extração de `quotedText` com 6 campos — NÃO resolve button messages
2. ❌ Brute-force scan no JSON raw com regex `✨N.` — NÃO resolve (mensagens de botão não têm o padrão)
3. ❌ `messageProductMap` armazenando por `zaapId` — NÃO funciona (ID errado)
4. ❌ Lookup em `body.quotedMessage.messageId` — NÃO funciona (campo errado)
5. ✅ Guard `canUseLastViewedFallback` bloqueando `lastViewedProduct` — FUNCIONA PARCIALMENTE (previne erro, mas não resolve)

### Solução — ver [[fix-resolver-produto-citado]]
Resumo das 3 correções obrigatórias:
1. `registerMessageProduct` deve armazenar pelo `res.data.messageId` (além do `zaapId`)
2. Todas as chamadas de `registerMessageProduct` devem passar `res?.data?.messageId`
3. Lookup via `body.referenceMessageId` (raiz do body) — **fora** do bloco `if (body?.quotedMessage)`

---

## Bug #3 — Catálogo masculino com produtos duplicados (DADOS)

### Sintoma
Catálogo masculino exibe 7 itens praticamente idênticos (mesmo SKU "672S", mesmo preço R$35,60).

### Causa
Produtos duplicados no WooCommerce (dados sujos).

### Solução
Deduplicar em `services/woocommerce.js` por SKU/slug antes de retornar resultados.

---

## Bug #5 — Alucinação da IA durante FSM ativa (fila de compras) 🔴 CRÍTICO

**Data:** 2026-04-03 | **Arquivo:** `index.js`

### Sintoma

Cliente clica "Comprar" em vários produtos em sequência sem digitar nada. A FSM entra em `awaiting_size` para o primeiro produto e enfileira os demais no `buyQueue`. Até aqui correto. Quando o cliente então digita qualquer texto — como "Ok" — ao invés de clicar no botão de tamanho, a Bela ignora o fluxo de compra e responde com uma alucinação: pergunta qual categoria o cliente quer ver, como se fosse um primeiro contato.

### Duas causas raiz simultâneas

**Causa A — Sem interceptor FSM para mensagens de texto**

O interceptor FSM (~linha 240) só captura eventos de botão/lista:
```javascript
if (fsmEventId && /^(buy_|size_|qty_|add_size_|skip_more_)/.test(fsmEventId)) { ... }
```
Quando o cliente digita texto com `pf.state !== 'idle'`, não há bloqueio — cai direto na IA. Só existe interceptor de texto para `awaiting_quantity` (digitação manual de número), mas nenhum para `awaiting_size` ou `awaiting_more_sizes`.

**Causa B — Histórico vazio dispara `isFirstContact = true`**

Eventos FSM (`buy_`, `size_`, `qty_`) dão `return` imediato sem jamais tocar em `session.history`. Se o cliente só clicou botões (sem digitar nada), `session.history.length === 0`. Quando digita "Ok":
```javascript
// ~linha 287 — dispara com histórico vazio!
if (session.history.length === 0 || PURE_GREETING.test(text.trim())) {
  isFirstContact = true; // ← ativa nudge de primeiro contato + hard-force de lançamentos
}
```
A IA recebe contexto de "primeiro atendimento" e alucina, ignorando que a FSM estava em `awaiting_size`.

### Rastreamento completo do fluxo defeituoso

```
1. buy_(A) → state = awaiting_size → sendSizeList(A) → return [history intacto, VAZIO]
2. buy_(B) → B enfileirado → zapi.sendText("B anotado") → return [history ainda VAZIO]
3. buy_(C) → C enfileirado → zapi.sendText("C anotado") → return [history ainda VAZIO]
4. Cliente digita "Ok"
   → fsmEventId = null (texto, não botão) → interceptor FSM não captura
   → session.history.length === 0 → isFirstContact = true ← BUG
   → session resetada (products, category...)
   → IA chamada com nudge "primeiro contato"
   → IA: "Me fala qual categoria você quer ver!" ← ALUCINAÇÃO
```

### Correção — Fix 1: FSM Text Interceptor

Inserir **após o bloco `awaiting_quantity` manual (~linha 278)** e **antes** do bloco `FIX-16` de saudação pura:

```javascript
// ── FSM Text Interceptor ──────────────────────────────────────────────────
// Quando a FSM está ativa, texto livre NÃO deve chegar à IA.
// Re-envia o menu pendente e retorna, mantendo o fluxo.
const pfCheck = session.purchaseFlow;

if (pfCheck.state === 'awaiting_size') {
  const product = session.products?.find(p => p.id === pfCheck.productId);
  if (product) {
    logger.info({ from, state: pfCheck.state }, '[FSM] Texto recebido em awaiting_size — re-enviando menu');
    await zapi.sendText(from, `😊 Escolhe o tamanho de *${pfCheck.productName}* pelo botão abaixo!`);
    await zapi.sendSizeList(from, product, pfCheck.interactiveVersion);
    persistSession(from);
    return;
  }
}

if (pfCheck.state === 'awaiting_more_sizes') {
  const product = session.products?.find(p => p.id === pfCheck.productId);
  const remainingSizes = product?.sizes?.filter(s => !pfCheck.addedSizes.includes(s)) ?? [];
  logger.info({ from, state: pfCheck.state }, '[FSM] Texto recebido em awaiting_more_sizes — re-enviando menu');
  await sendPostAddMenu(from, session, remainingSizes);
  persistSession(from);
  return;
}
// ─────────────────────────────────────────────────────────────────────────
```

### Correção — Fix 2: Proteger `isFirstContact` contra FSM ativa

```javascript
// ANTES (~linha 287):
if (session.history.length === 0 || PURE_GREETING.test(text.trim())) {

// DEPOIS:
const fsmIsIdle = !session.purchaseFlow || session.purchaseFlow.state === 'idle';
if (fsmIsIdle && (session.history.length === 0 || PURE_GREETING.test(text.trim()))) {
```

### Melhoria adicional: âncora visual nas mensagens de fila

Ao enfileirar produto, adicionar "⬆️" para o cliente saber que a ação está no menu acima:

```javascript
// Em handlePurchaseFlowEvent, bloco buy_ quando estado !== 'idle' (~linha 1328):
const queueMsg = totalQueued === 1
  ? `Vamos um de cada vez 😊 Primeiro termino *${pf.productName}* ⬆️, depois cuidamos do *${product.name}*!`
  : `Anotei! 📋 Você tem *${totalQueued + 1} peças* na fila — escolhe o tamanho acima ⬆️`;
```

### Tentativas anteriores (NÃO REPETIR)
- ❌ Enviar mensagem de confirmação de fila com mais texto — não resolve, apenas enterra mais o menu de tamanhos

### Resumo das mudanças

| # | Onde | O Que Muda |
|---|------|-----------|
| Fix 1 | `index.js` ~linha 278 | Novo FSM Text Interceptor para `awaiting_size` e `awaiting_more_sizes` |
| Fix 2 | `index.js` ~linha 287 | Guarda `fsmIsIdle` antes de checar `isFirstContact` |
| Melhoria | `index.js` ~linha 1328 | Adicionar "⬆️" nas mensagens de confirmação de fila |

---

## ~~Bug #4 — Logs insuficientes para diagnóstico~~ ✅ RESOLVIDO (2026-03-30)

`services/logger.js` criado com pino + pino-pretty. Todos os `console.log`/`console.error` substituídos por `logger.info`/`logger.error` em `index.js`, `services/zapi.js`, `services/gemini.js` e `services/supabase.js`. Structured logging com campos `{ phone, text, zaapId, err }`.
