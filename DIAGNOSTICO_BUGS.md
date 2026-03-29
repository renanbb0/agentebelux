# Diagnóstico de Bugs — Agente Belux
**Data:** 2026-03-29
**Preparado por:** Equipe Lume Soluções
**Destinado a:** Especialista externo

---

## Stack do Projeto

| Componente | Tecnologia |
|---|---|
| Runtime | Node.js + Express 5 |
| WhatsApp | Z-API (SaaS, não oficial) |
| IA | Google Gemini 2.5 Flash (via `@google/generative-ai`) |
| Catálogo | WooCommerce REST API |
| Persistência | Supabase (PostgreSQL) |
| Deploy | Processo Node nativo no Windows (sem PM2/cluster) |

---

## Bug #1 — Foto do produto errado ao citar mensagem (CRÍTICO, NÃO RESOLVIDO)

### Comportamento observado

O cliente cita a foto de um produto específico (ex: produto #3 — Conjunto sem bojo com aro) e pergunta "Tem mais foto dessa?". O sistema responde enviando fotos de um produto **completamente diferente** (produto #10 — Camisola sensual liganete).

### Evidência visual
- Cliente citou: ✨ 3. Conjunto sem bojo com aro - Ref 414L — R$ 17,00
- Sistema enviou fotos de: ✨ 10. Camisola sensual liganete - Ref 204B FROZEN

### Causa raiz identificada

O Z-API entrega o payload de mensagens citadas (`quotedMessage`) em uma estrutura de campos que **não é documentada publicamente** e varia entre versões. O código tenta ler a legenda da foto citada nos seguintes campos:

```js
const quotedText =
  body.quotedMessage.text?.message ||         // texto puro
  body.quotedMessage.image?.caption ||        // imagem simples
  body.quotedMessage.imageMessage?.caption || // variante imageMessage
  body.quotedMessage.caption ||               // campo direto
  body.quotedMessage.message?.imageMessage?.caption ||   // aninhado (adicionado na última tentativa)
  body.quotedMessage.message?.extendedTextMessage?.text; // texto estendido
```

Quando **nenhum desses campos** contém a legenda (o campo real no payload Z-API para este caso ainda é desconhecido), o `quotedText` retorna `null`, e o número do produto (#3) nunca é extraído.

Com `quotedProductIdx = null`, o sistema cai num **fallback perigoso**:

```js
// Usa o ÚLTIMO produto cujas fotos foram enviadas — que era o #10
if (IS_PHOTO_REQUEST && !quotedProductIdx && session.lastViewedProduct) {
  const idx = session.lastViewedProductIndex || 1;  // era 10
  await showProductPhotos(from, idx, session);       // envia produto errado
}
```

### O que foi tentado

1. **Tentativa 1:** Adicionamos os fields `message.imageMessage.caption` e `message.extendedTextMessage.text` à cadeia de extração.
2. **Tentativa 2:** Adicionamos um "brute-force scan" no JSON bruto da `quotedMessage` buscando o padrão `✨N.` via regex — cobrindo qualquer campo aninhado desconhecido.
3. **Tentativa 3:** Adicionamos um guard `quotedButUnresolved` que **bloqueia** o fallback `lastViewedProduct` quando existe uma `quotedMessage` mas não conseguimos extrair o número — evitando o produto errado (mas não corrigindo a causa raiz).

### Estado atual

O fallback errado foi bloqueado (não envia mais o produto #10). Porém, **não sabemos em qual campo o Z-API está entregando a caption**, porque os logs do servidor (`server.log`) não estão capturando o output do processo Node. Sem ver o `[QuotedMsg raw]` impresso no console, não é possível identificar o campo correto.

### O que o especialista precisa fazer

1. **Capturar o payload bruto** de uma `quotedMessage` real do Z-API. Reiniciar o servidor com `node index.js > server.log 2>&1`, fazer um reply de foto no WhatsApp, e inspecionar o JSON impresso pela linha:
   ```js
   console.log(`[QuotedMsg raw] ${JSON.stringify(body.quotedMessage)}`);
   ```
2. Identificar o campo correto onde a caption aparece e adicionar ao chain de extração.
3. Alternativa arquitetural: o Z-API tem um endpoint REST para buscar detalhes de uma mensagem por ID. Ao receber `body.quotedMessage`, chamar `GET /message/{messageId}` e extrair a caption de lá — eliminando a dependência da estrutura do payload inline.

---

## Bug #2 — Pedido misto de categorias e quantidades (COMPLEXIDADE ESTRUTURAL)

### Comportamento observado

O cliente enviou:
> "Quero essa 7 masculina / Bota 2 p 3 gg / E as femina 3 sendo 3p 2gg 2M / Da quanto?"

A Bela respondeu: "Ah, entendi! Vamos lá, já anotei aqui pra você: Da peça masculina" — resposta **incompleta e truncada**, sem processar o pedido.

### Por que acontece

O fluxo do agente é projetado para uma categoria por vez. Quando o cliente mistura:
- Referência a produto pelo número de uma lista já fechada (masculina, produto #7)
- Quantidades por tamanho (2P, 3GG)
- Produtos de outra categoria (feminina, produto #3)
- Pergunta de preço total

...o sistema não tem mecanismo para:
1. Reconhecer que "7 masculina" e "3 feminina" são produtos de listas **diferentes** (os índices se sobrepõem — `session.products` só guarda a lista atual)
2. Processar quantidades por tamanho (o modelo de dados do carrinho só tem `{produto, tamanho, preço}` unitário)
3. Calcular total antes de finalizar o pedido

### Estado atual

Parcialmente mitigado: adicionamos `activeCategory` na sessão e regras de sequenciamento no system prompt para que a IA exiba uma categoria por vez. Mas o problema fundamental é que o cliente enviou tudo numa só mensagem após ver as duas categorias.

### O que o especialista precisa avaliar

1. **Modelo de dados do carrinho:** o sistema atual não suporta quantidade (`qty`). Cada item é unitário. Para suportar "2 P e 3 GG", o carrinho precisaria de `{produto, tamanho, quantidade}`.
2. **Referência cruzada de categorias:** quando `session.products` é sobrescrito ao mudar de categoria, os índices antigos ficam inválidos. Uma possível solução é manter um mapa global `productRegistry: { [globalId]: product }` que persista entre mudanças de categoria.
3. **Parser de intenção complexa:** pedidos como "7 masculina 2p 3gg + 3 feminina 3p 2gg 2M" requerem um parser estruturado (slot-filling) que o modelo de linguagem puro não garante.

---

## Bug #3 — Catálogo masculino com produtos duplicados (DADOS, NÃO É BUG DO AGENTE)

### Comportamento observado

O catálogo masculino exibiu 7 produtos com nomes praticamente idênticos:
- Pijama masculino - Ref 672S (R$ 35,60)
- Pijama masculino - Ref 672S (R$ 35,60)
- Pijama Masculino Adulto- Ref 672s (R$ 35,60)
- ... (7 variações do mesmo produto)

### Causa raiz

Não é um bug do agente. O WooCommerce tem produtos duplicados ou variações do mesmo produto cadastradas como produtos separados. O agente simplesmente lista o que a API retorna.

### Solução

Deduplicar os produtos no WooCommerce, ou implementar deduplicação no `woocommerce.js` por `sku`/`ref` antes de exibir.

---

## Bug #4 — Logs insuficientes para diagnóstico em produção (INFRA)

### Problema

O `server.log` captura apenas erros de módulos (`[Supabase]`). Os `console.log` do fluxo principal (webhooks, payloads Z-API, respostas da IA) **não estão sendo capturados** — seja porque o processo foi iniciado sem redirecionamento de stdout, seja por encoding incompatível (UTF-16 Wide detectado no log).

### Impacto

Impossível diagnosticar bugs em produção sem acessar o terminal interativo. O Bug #1 persiste parcialmente por essa razão.

### Solução recomendada

Substituir `console.log` por um logger estruturado (ex: `pino` ou `winston`) com saída em arquivo. Alternativamente, usar PM2 com `pm2 start index.js --log server.log` que captura stdout/stderr automaticamente.

---

## Resumo Executivo

| # | Bug | Gravidade | Status | Bloqueio |
|---|-----|-----------|--------|----------|
| 1 | Foto errada ao citar mensagem | 🔴 Crítico | Parcialmente mitigado | Payload Z-API desconhecido sem logs |
| 2 | Pedido misto de categorias/quantidades | 🟠 Alto | Mitigado com regras de prompt | Limitação arquitetural do modelo de dados |
| 3 | Produtos duplicados no catálogo | 🟡 Médio | Não tratado | Dado sujo no WooCommerce |
| 4 | Logs insuficientes | 🟡 Médio | Não tratado | Infra de deploy sem logger estruturado |

### Dependência crítica para resolver Bug #1

**É necessário capturar o JSON bruto do payload `body.quotedMessage` de uma chamada real do Z-API.** Sem isso, qualquer fix é tentativa às cegas. O campo correto onde a caption da foto citada trafega precisa ser identificado empiricamente — a documentação oficial do Z-API não cobre variações de payload por versão de WhatsApp.
