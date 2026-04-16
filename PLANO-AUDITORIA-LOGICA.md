# 🛠️ Plano de Correção — Auditoria de Lógica de Negócio

**Origem:** Auditoria profunda do projeto Agente Belux conduzida em 2026-04-10.
**Escopo:** Apenas bugs e inconsistências de **lógica de código** (não inclui temas de pricing/estoque, que ficam por conta da confirmação manual da consultora).
**Para:** Claude Code (executor das correções).
**Prioridade:** P0 → P1 → P2 → P3. Faça na ordem.

> Antes de tocar em qualquer item, leia primeiro `CLAUDE.md` e os docs do Obsidian relevantes (`05 - Sessões e Carrinho.md`, `02 - Webhook e Roteamento.md`, `07 - Histórico e Migrações.md`). Atualize o Obsidian no mesmo turno em que mexer no código.

---

## 🚨 P0 — index.js está QUEBRADO (servidor não sobe)

### Sintoma
`node --check index.js` retorna:
```
index.js:2919
      `�
SyntaxError: Unexpected end of input
```

O arquivo termina **no meio de uma string**, dentro de `handoffToConsultant`, na linha 2919. A última linha íntegra é:
```js
    // 2a. Resumo em texto com header do pedido
    const adminHeader =
      `�   ← string nunca fechada, EOF
```

### O que falta na cauda do arquivo
A função `handoffToConsultant` está incompleta. Precisa:

1. Fechar a template string `adminHeader` com o cabeçalho do pedido (telefone, nome do cliente, total, contagem de itens).
2. Enviar `adminHeader` para `ADMIN_PHONE` via `zapi.sendText`.
3. Enviar 1 foto por produto distinto do carrinho usando `buildProductGroupsFromCart` (ver ADR-006 em `07 - Histórico e Migrações.md`). Cada produto agrupa seus tamanhos/quantidades em uma legenda e usa a primeira imagem em cache.
4. Marcar `session.handoffDone = true`.
5. Limpar `purchaseFlow` via `resetPurchaseFlow(session)` (já existe).
6. Persistir a sessão (`persistSession(phone)`).
7. Fechar a função, fechar qualquer bloco pendente, e garantir que existe `app.listen(PORT, ...)` no fim do arquivo.

### Como restaurar
1. **Tente o git primeiro:**
   ```bash
   cd "D:\Agente Belux"
   git log --oneline -- index.js | head
   git show HEAD:index.js > /tmp/index-head.js
   diff index.js /tmp/index-head.js
   ```
   Se o HEAD tiver a versão íntegra, restaure só a cauda (a partir da linha 2891 — início de `handoffToConsultant`) preservando qualquer mudança recente acima dela.

2. **Se não houver versão no git:** reconstrua a função seguindo o padrão dos outros handlers de envio para admin no próprio `index.js` (busque por `ADMIN_PHONE` e veja como `handoffToHuman` monta a notificação — linha ~2877 em diante).

3. **Validação obrigatória após o fix:**
   ```bash
   node --check index.js     # deve retornar "index.js OK"
   node index.js             # deve subir sem stack trace
   ```

4. Faça um teste de fumaça do fluxo: `buy_ → size_ → qty_ → cart_finalize` e veja se o admin recebe header + fotos.

---

## 🔴 P1 — Bugs de lógica (fazer em ordem)

### P1.1 — `addToCart` duplica linhas do mesmo produto+tamanho
**Arquivo:** `index.js`, função `addToCart` (linha ~1834).

**Problema:** A função sempre faz `session.items.push(...)`. Se o lojista clicar "comprar M" duas vezes (mesmo produto, mesmo tamanho), vira:
```
1. Calcinha Renda (M) x1
2. Calcinha Renda (M) x1   ← duplicata
```
ao invés de `Calcinha Renda (M) x2`.

**Fix:**
```js
const existingIdx = session.items.findIndex(
  it => it.productId === pf.productId && it.size === selectedSize
);

if (existingIdx >= 0) {
  const existing = session.items[existingIdx];
  existing.quantity += qty;
  existing.price = existing.unitPrice * existing.quantity;
} else {
  session.items.push({
    productId: pf.productId,
    productName: pf.productName,
    size: selectedSize,
    quantity: qty,
    unitPrice,
    price,
    imageUrl,
  });
}
```

**Teste:** comprar mesmo tamanho 2x → carrinho deve mostrar **uma** linha com `quantity` somada.

---

### P1.2 — Race condition em `getSession` (corrupção de sessão concorrente)
**Arquivo:** `index.js`, função `getSession` (linha ~263).

**Problema:** Quando o lojista manda 3 mensagens em sequência, a Z-API dispara 3 webhooks quase simultâneos. Se `sessions[phone]` ainda não existe em memória, cada webhook executa `await db.getSession(phone)` em paralelo — e cada um cria seu próprio objeto e mutates `sessions[phone]`. O último `persistSession` vence e **sobrescreve carrinho/histórico** do anterior.

Isso é a causa real de relatos como "ela esqueceu o que eu disse" e "carrinho sumiu".

**Fix — Lock por phone usando Map de Promises:**
```js
const sessionLoadLocks = new Map();

async function getSession(phone) {
  if (sessions[phone]) {
    sessions[phone].previousLastActivity = sessions[phone].lastActivity || null;
    sessions[phone].lastActivity = Date.now();
    return sessions[phone];
  }

  // Se já há um load em andamento para este phone, aguarda ele terminar
  if (sessionLoadLocks.has(phone)) {
    await sessionLoadLocks.get(phone);
    return sessions[phone];
  }

  const loadPromise = (async () => {
    const stored = await db.getSession(phone);
    // ... resto da lógica de hidratação atual ...
    sessions[phone] = /* objeto montado */;
  })();

  sessionLoadLocks.set(phone, loadPromise);
  try {
    await loadPromise;
  } finally {
    sessionLoadLocks.delete(phone);
  }

  return sessions[phone];
}
```

**Teste:** simule 3 webhooks paralelos para o mesmo phone (Promise.all com 3 chamadas a getSession). O `sessions[phone]` resultante deve ser **um único** objeto.

---

### P1.3 — `persistSession` é fire-and-forget (writes podem se sobrescrever)
**Arquivo:** `index.js`, função `persistSession` (linha ~319).

**Problema:** A função faz `db.upsertSession(...).catch(log)` sem `await`. Em sequências rápidas (`addToCart` → `sendPostAddMenu` → próxima mensagem) duas chamadas podem viajar em paralelo, e o upsert mais antigo (com estado novo) pode chegar **depois** do mais novo (com estado mais antigo? não — mesma ordem de disparo, mas a rede pode reordenar) e ganhar.

**Fix — Serializar writes por phone:**
```js
const persistQueues = new Map();

function persistSession(phone) {
  const session = sessions[phone];
  if (!session) return Promise.resolve();

  const previous = persistQueues.get(phone) || Promise.resolve();
  const next = previous
    .catch(() => {}) // não propaga erro do upsert anterior
    .then(() => db.upsertSession(phone, session))
    .catch(err => logger.error({ err: err.message }, '[Supabase] upsertSession'));

  persistQueues.set(phone, next);
  // Limpa a fila quando esvaziar
  next.finally(() => {
    if (persistQueues.get(phone) === next) persistQueues.delete(phone);
  });
  return next;
}
```

E nos pontos críticos (após `addToCart`, após handoff), trocar `persistSession(phone)` por `await persistSession(phone)`.

**Teste:** instrumentar log de upserts e disparar 5 mutações em sequência rápida — todos os upserts devem completar em ordem, sem `unhandled rejection`.

---

### P1.4 — `categoryCache` nunca expira
**Arquivo:** `services/woocommerce.js` (linha 18).

**Problema:** `categoryCache[slug] = id` é mantido para sempre no processo. Se o admin renomear/recriar uma categoria no WooCommerce, o bot continua usando o ID antigo até o restart. Pode até buscar produtos numa categoria deletada e retornar lista vazia silenciosamente.

**Fix:** TTL de 10 minutos:
```js
const categoryCache = new Map();
const CATEGORY_CACHE_TTL_MS = 10 * 60 * 1000;

async function getCategoryIdBySlug(slug) {
  const cached = categoryCache.get(slug);
  if (cached && (Date.now() - cached.loadedAt) < CATEGORY_CACHE_TTL_MS) {
    return cached.id;
  }
  // ... busca atual ...
  if (id) categoryCache.set(slug, { id, loadedAt: Date.now() });
  return id;
}
```

---

### P1.5 — Dedup global de `session.products` quando paginar
**Arquivo:** `index.js`, onde quer que `session.products` receba `[...session.products, ...newPage]` (busque por `session.products =` e `session.products.push`).

**Problema:** `deduplicateProducts` em `woocommerce.js` só dedupa **dentro** da página. Quando o lojista avança página com `[PROXIMOS]` e a função concatena com a página anterior, produtos repetidos passam — porque `orderby=popularity` no Woo não é estável (uma compra entre páginas reordena), então a página 2 pode trazer um item que já estava na página 1.

Resultado: dois "1. Calcinha Renda" com índices diferentes na lista mostrada, e `[SELECIONAR:N]` pode selecionar o errado.

**Fix:** Após qualquer concatenação, dedupar por ID:
```js
function mergeProductsUnique(existing, incoming) {
  const seen = new Set(existing.map(p => p.id));
  const merged = [...existing];
  for (const p of incoming) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      merged.push(p);
    }
  }
  return merged;
}

session.products = mergeProductsUnique(session.products, response.products);
```

---

### P1.6 — `purchaseFlow.contextMemory` aninhando memória de conversa
**Arquivo:** `services/supabase.js`, função `upsertSession` (linha 19).

**Problema:** A memória de conversa (`session.conversationMemory`) é enfiada **dentro** do `purchase_flow` jsonb:
```js
const purchaseFlowPayload = {
  ...session.purchaseFlow,
  handoffDone: session.handoffDone,
  contextMemory: session.conversationMemory || null,
};
```

Isso (a) infla um jsonb que devia ser pequeno, (b) acopla dois conceitos ortogonais, (c) na próxima refatoração da FSM você arrasta a memória junto sem querer.

**Fix:**
1. Criar coluna `conversation_memory jsonb` na tabela `sessions` no Supabase (migration).
2. Em `upsertSession`, mover `contextMemory` para fora do `purchaseFlowPayload` e gravar em `conversation_memory`.
3. Em `getSession` (em `index.js`, hidratação), ler de `stored.conversation_memory` ao invés de `storedPurchaseFlow.contextMemory`.
4. Manter compatibilidade reversa por 1 release: se a coluna nova for `null` mas `purchase_flow.contextMemory` existir, usar como fallback e migrar no próximo upsert.

---

## 🟡 P2 — Coisas obsoletas / inconsistências

### P2.1 — Avaliar se `parseGradeText` ainda faz sentido
**Arquivo:** `index.js`, função `parseGradeText` (linha 33), e seus call sites (linhas ~670 e ~1117).

**Problema:** A função foi criada quando a IA não conseguia parsear "9P 5M 3G". Hoje, com Gemini 3 Flash + `[COMPRAR_DIRETO:{...}]`, a IA dá conta. O parser regex pode capturar falsos positivos (ex: "vou levar 2P agora" quando o lojista só está descrevendo). E ela roda **antes** de a IA ser consultada em alguns paths.

**Ação:**
1. Listar todos os call sites de `parseGradeText`.
2. Para cada um, verificar se está protegido por `pf.state === 'awaiting_size' || 'awaiting_quantity' || 'awaiting_more_sizes'`.
3. Se algum call site rodar fora desses estados, mover para depois da IA (a IA decide; o parser só ajuda dentro da FSM ativa).
4. Adicionar log estruturado quando o parser captura algo, pra você medir falsos positivos antes de remover.

---

### P2.2 — `addLearning` usa `ilike` por prefixo de 40 chars
**Arquivo:** `services/supabase.js`, função `addLearning` (linha 67).

**Problema:** Dois insights diferentes com mesmo prefixo de 40 chars são tratados como o **mesmo** registro. Ex: "Lojista de Fortaleza prefere conjuntos pretos" e "Lojista de Fortaleza pediu desconto extra" colidem.

**Fix:** Hash determinístico do insight inteiro:
```js
const crypto = require('crypto');
const insightHash = crypto.createHash('sha256').update(insight).digest('hex').slice(0, 16);
```
Adicionar coluna `insight_hash` em `learnings` e dedupar por ela. Migration necessária.

---

### P2.3 — `searchProducts` sem paginação
**Arquivo:** `services/woocommerce.js`, função `searchProducts` (linha 79).

**Problema:** `per_page = 20` hardcoded. Se a busca tem 50 resultados, o bot só vê 20 e a IA acha que viu tudo.

**Fix:** Aceitar parâmetro `page` e retornar metadata como `getProductsByCategory` (`hasMore`, `totalPages`). Atualizar call sites em `index.js` para encadear paginação.

---

### P2.4 — Atualizar referências do skill
**Arquivos:** `.claude/skills/agente-belux/references/woocommerce.md` e `.claude/skills/agente-belux/references/arquitetura.md`.

**Problemas:**
1. `woocommerce.md` lista CATEGORY_MAP só com 3 categorias; o código tem 5 (`feminino`, `femininoinfantil`, `masculino`, `masculinoinfantil`, `lancamento-da-semana`).
2. `arquitetura.md` ADR-004 diz "Gemini 2.5 Flash, temperature 0.4" — atualizar para "Gemini 3 Flash Preview, temperature 0.7, maxOutputTokens 800".
3. `arquitetura.md` no fluxo de handoff descreve em um lugar "sessão deletada" e em outro "sessão preservada com handoffDone=true". Hoje a função preserva — corrigir o trecho do mermaid.

**Ação:** ler ambos os arquivos, alinhar com o código atual, e atualizar também os docs do Obsidian em `D:\obsidian\Agente Belux\Agente Belux Docs\07 - Histórico e Migrações.md` (registrar como ADR-007).

---

### P2.5 — `MAX_HISTORY_MESSAGES = 40` corta contexto crítico
**Arquivo:** `index.js`, linha 23.

**Problema:** O trim mantém só as 40 últimas mensagens. Em pedidos grandes (>20 turnos), a categoria escolhida no início **sai do histórico** e a IA passa a depender 100% do `buildCatalogContext`/`buildFsmContext`. Parte da "burrice" relatada vem disso.

**Fix:** Aumentar para 80–100, **OU** implementar trim por tokens ao invés de por count (mais robusto). Como Gemini 3 Flash tem context window grande, 80 mensagens é seguro.

---

## 🟢 P3 — Pequenos endurecimentos

### P3.1 — `formatPrice` retorna "Preço indisponível" silenciosamente
**Arquivo:** `services/woocommerce.js` (linha 302).

`parseFloat('')` vira `NaN`. Quando isso vira "Preço indisponível" no caption, o lojista vê isso sem aviso. Logar `warn` no `NaN` para visibilidade.

### P3.2 — `extractSizes` não filtra vazios
**Arquivo:** `services/woocommerce.js` (linha 109).

Se o atributo "Tamanho" existe mas tem `options: []`, o lojista entra em `awaiting_size` sem opções e fica preso. Filtrar `options.filter(s => s && s.trim())` e, se vier vazio, logar e tratar como produto sem variação.

### P3.3 — Limite de bytes em `session.history`
**Arquivo:** `index.js`, função `trimSessionHistory` (linha 154).

Hoje só limita por count. Mensagem longa × 40 pode estourar o jsonb do Supabase. Adicionar limite secundário em bytes (ex: 30KB).

### P3.4 — Tratar `extractSizes` com tamanhos não-padrão
Hoje funciona com `P/M/G/GG`. Se o Woo tiver "PP", "XG", "XXG" — verificar se `parseGradeText` (regex sortBy length) e o resto da FSM lida corretamente.

---

## ✅ Checklist final (depois de tudo)

- [ ] `node --check index.js` retorna OK
- [ ] `node index.js` sobe sem erro
- [ ] Teste de fumaça: 1 produto, 1 tamanho, 1 quantidade, finalizar, admin recebe foto + texto
- [ ] Teste de duplicata: mesmo produto+tamanho 2x → 1 linha no carrinho
- [ ] Teste de paralelismo: 3 webhooks paralelos do mesmo phone → 1 sessão
- [ ] Teste de paginação: avançar 2 páginas na mesma categoria → sem produtos duplicados
- [ ] Obsidian atualizado: `05 - Sessões e Carrinho.md`, `07 - Histórico e Migrações.md` (novos ADRs)
- [ ] References do skill alinhadas com código atual

---

## 📌 Notas finais

- **NUNCA** mexa em pricing ou reserva de estoque sem alinhar com o Renan primeiro. A Belux confirma manualmente — esses temas estão fora do escopo desta auditoria.
- Mantenha `handoffDone` como guard único contra handoff duplicado; não introduza novos flags.
- Toda mudança em `services/supabase.js` que afete schema precisa de migration documentada.
- Atualize o Obsidian no **mesmo turno** em que mexer no código (regra do `CLAUDE.md`).
