# Plano: Modularização do `index.js`

> **Para agentes executores:** Use `superpowers:subagent-driven-development` ou `superpowers:executing-plans`. Steps usam `- [ ]` para tracking.

**Branch:** `feat/modularizacao-index`
**Data:** 2026-05-01
**Autor humano:** Renan
**Autor IA:** Claude Opus 4.7

---

## Objetivo

Quebrar o monólito `index.js` (8.353 linhas) em módulos focados, **sem alterar comportamento observável**, mantendo o servidor rodando em produção a cada commit.

## Arquitetura proposta

Estrangulamento incremental ("strangler") em 13 fases. Cada fase é um PR pequeno e independente, mergeável por si só. O `index.js` é reduzido módulo a módulo até virar puro wiring (~150 linhas).

**Tech stack:** Node.js 20, CommonJS, Express 5, Z-API, Gemini 2.5 Flash, Supabase, sem TypeScript.

**Principio inegociável:** **comportamento observável imutável**. Após cada commit, `node index.js` boota, `/webhook` aceita o mesmo input e produz o mesmo output (mensagens Z-API idênticas, mesmo estado salvo no Supabase).

---

## Por que strangler e não big bang

| Abordagem | Tempo | Risco | Reversibilidade |
|---|---|---|---|
| Big bang (todo em um PR) | 1-2 semanas | **Altíssimo** — dificuldade de revisar, qualquer bug paralisa o bot | Difícil — reverter desfaz tudo |
| Strangler (13 PRs) | 2-3 semanas | **Baixo** — cada PR é pequeno e validado | Trivial — `git revert` por PR |

Bot está em produção atendendo lojistas reais. Strangler vence.

---

## Estrutura-alvo (proposta)

```
agente-belux/
├── index.js                       (~150 linhas — boot e wiring)
├── src/
│   ├── boot/
│   │   ├── env.js                 # Constantes de process.env
│   │   ├── express-app.js         # Express + Socket.io setup
│   │   └── shared-state.js        # Mapas em memória (sessions, queues, timers)
│   ├── utils/
│   │   ├── phone.js               # digitsOnly, normalizeWhatsAppPhone, isAdminPhone
│   │   ├── compound-parser.js     # parseCompoundSpec, parseGradeText
│   │   ├── event-extractor.js     # extractTextFromEvent, extractAudioUrl
│   │   ├── public-url.js          # getPublicBaseUrl, buildPublicAssetUrl
│   │   └── variant-text.js        # normalizeVariantText, matchVariant, parseMultiVariantGrade
│   ├── session/
│   │   ├── lifecycle.js           # getSession, persistSession
│   │   ├── history.js             # appendHistory, trimSessionHistory, getActiveHistoryWindow
│   │   └── flags.js               # isBotSuspendedForHuman, shouldSkipBotAutomation, image-match flags
│   ├── ai/
│   │   ├── context.js             # buildFsmContext, buildAiContext, buildReflectionPrompt
│   │   └── intent.js              # isHumanPauseResumeIntent, isShoppingResumeIntent
│   ├── inbound/
│   │   ├── debounce.js            # buffer/flush de texto inbound
│   │   └── command-parsers.js     # parseBelaPauseCommand, parseTrackingCommand
│   ├── admin/
│   │   ├── handoff-pdf.js         # sendLegacyHandoffToAdmin(s), buildAdminPdfHeader
│   │   ├── pause-command.js       # handleBelaPauseAdminCommand
│   │   └── tracking-command.js    # handleTrackingAdminCommand
│   ├── messaging/
│   │   ├── tts-wrapper.js         # sendTextWithTTS
│   │   ├── loading.js             # sendLoadingMessage, pickLoadingPhrase, pickSearchLoadingPhrase
│   │   └── category-cards.js      # sendCategoryMenu, sendCategoryCard, sendCategoryShowcase
│   ├── product/
│   │   ├── resolver.js            # resolveQuotedProduct, resolveProductById, registerMessageProduct
│   │   ├── stock.js               # ensureProductStockData, getAvailableSizesForSession, etc.
│   │   ├── variant.js             # sendVariantList, tryAdvanceToSize
│   │   └── size-qty-list.js       # sendStockAwareSizeList, sendStockAwareQuantityList, sendStockAwareSizeQtyList
│   ├── cart/
│   │   ├── operations.js          # pushCartItem, addToCart, clearCart, getCartStats
│   │   ├── summary.js             # buildCartSummary, sendCartSummary, scheduleCartSummary
│   │   ├── menus.js               # sendCartOptions, sendCatalogBrowseOptions, sendPostAddMenu
│   │   ├── edit-from-quote.js     # handleCartEditFromQuote
│   │   └── label-helpers.js       # normalizeCartLabel, extractRefKey, stripVariantSuffix
│   ├── fsm/
│   │   ├── purchase-flow.js       # createDefaultPurchaseFlow, resetPurchaseFlow, switchFsmFocus
│   │   ├── purchase-event.js      # handlePurchaseFlowEvent (~373 linhas)
│   │   ├── queue.js               # processNextInQueue, skipCurrentProduct, queue-guard, buy-debounce
│   │   ├── interactive.js         # startInteractivePurchase, showProductPhotos
│   │   ├── compound.js            # detectCompoundCase, runCompoundConfirmation, etc.
│   │   └── focus.js               # buildPurchaseFlowFocusLines
│   ├── catalog/
│   │   ├── browse.js              # showCategory, showAllCategory, showNextPage, sendProductPage
│   │   ├── commercial-search.js   # runCommercialCatalogSearch, tryHandleCommercialCatalogQuery
│   │   └── render.js              # sendCatalogProductCards, openCatalogProductDirectly, etc.
│   ├── handoff/
│   │   ├── consultant.js          # handoffToConsultant, handoffToHuman, executeHandoff
│   │   ├── scheduler.js           # scheduleUpsellAndHandoff, scheduleFecharPedidoHandoff
│   │   └── failure.js             # handlePartialFailureResponse, sendContextualFallback
│   ├── support/
│   │   └── flow-control.js        # cancelCurrentFlow, clearSupportMode
│   └── webhook/
│       ├── routes.js              # /webhook + /wc-webhook/product (após extração)
│       ├── dispatcher.js          # Roteamento principal de mensagem inbound (a Fase 11)
│       ├── execute-action.js      # executeAction
│       └── http-routes.js         # /, /admin/reset-sessions
```

**Total esperado:** ~38 módulos, mediana ~200 linhas, máx ~400 linhas (`fsm/purchase-event.js`).

---

## Rede de segurança

Antes da Fase 1 começar, precisamos:
1. **Test runner unificado** — `npm test` hoje só roda `tts.test.js`. Sem isso, não temos sinal verde automatizado.
2. **Smoke boot** — script que sobe o servidor, faz request a `/`, valida `status: online`, mata o processo.
3. **Replay de webhook** — capturar 5-10 payloads reais de `logs/parsed/parsed-events.jsonl` e replayar pré e pós cada extração, comparando saída do `/webhook` (status code + side effects logados).

A Fase 0 entrega esses três.

---

## Fase 0: Rede de segurança

**Objetivo:** ter um sinal automatizado "boot OK + tests OK + replay OK" antes de mover qualquer linha.

**Arquivos:**
- Criar: `scripts/smoke-boot.js`
- Criar: `scripts/run-all-tests.js`
- Criar: `scripts/replay-webhook.js`
- Criar: `tests/_fixtures/replay-payloads.json`
- Modificar: `package.json` (adicionar scripts `test:all`, `smoke`, `replay`)

### Steps

- [ ] **0.1** Listar nomes exatos dos 20 arquivos `tests/*.test.js`

```bash
ls tests/*.test.js
```
Esperado: 20 caminhos, um por linha.

- [ ] **0.2** Criar `scripts/run-all-tests.js`

```js
// Roda todos os tests/*.test.js sequencialmente. Falha se qualquer um falhar.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TESTS_DIR = path.join(__dirname, '..', 'tests');
const files = fs.readdirSync(TESTS_DIR).filter(f => f.endsWith('.test.js'));

let failed = 0;
for (const f of files) {
  const full = path.join(TESTS_DIR, f);
  process.stdout.write(`\n▶ ${f}\n`);
  const res = spawnSync('node', [full], { stdio: 'inherit' });
  if (res.status !== 0) {
    failed++;
    process.stdout.write(`✗ ${f} falhou (exit=${res.status})\n`);
  }
}
process.stdout.write(`\n${files.length - failed}/${files.length} testes passaram.\n`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **0.3** Adicionar script `test:all` em `package.json`

```json
"scripts": {
  "test": "node tests/tts.test.js",
  "test:all": "node scripts/run-all-tests.js",
  ...
}
```

- [ ] **0.4** Rodar `npm run test:all` para mapear estado real

```bash
npm run test:all
```
Esperado: alguns vão passar, outros podem falhar (são "manuais"). Anotar quais falham e por quê em comentário no script. Tests **manuais** (que precisam servidor rodando, mocks externos) ficam marcados; tests **unitários** (puros) viram a baseline obrigatória.

- [ ] **0.5** Categorizar tests em `tests/_categories.md`

Criar arquivo listando: cada test → categoria (`unit` | `manual` | `integration`). Apenas `unit` é obrigatório passar a cada commit. `manual` e `integration` rodam no fim de cada fase.

- [ ] **0.6** Criar `scripts/smoke-boot.js`

```js
// Sobe o servidor, faz GET /, espera 200 com status:online, mata o processo.
const { spawn } = require('child_process');
const http = require('http');

const proc = spawn('node', ['index.js'], { env: { ...process.env, PORT: '3999' } });
let booted = false;

proc.stdout.on('data', d => process.stdout.write(d));
proc.stderr.on('data', d => process.stderr.write(d));

function checkAlive(retries = 20) {
  http.get('http://127.0.0.1:3999/', res => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      try {
        const json = JSON.parse(body);
        if (json.status === 'online') {
          booted = true;
          console.log('✓ Smoke OK');
          proc.kill();
          process.exit(0);
        } else {
          throw new Error('status != online');
        }
      } catch (e) {
        if (retries > 0) setTimeout(() => checkAlive(retries - 1), 500);
        else { proc.kill(); process.exit(1); }
      }
    });
  }).on('error', () => {
    if (retries > 0) setTimeout(() => checkAlive(retries - 1), 500);
    else { proc.kill(); process.exit(1); }
  });
}

setTimeout(() => checkAlive(), 1500);
setTimeout(() => { if (!booted) { proc.kill(); process.exit(1); } }, 30_000);
```

- [ ] **0.7** Adicionar `smoke` em `package.json`

```json
"smoke": "node scripts/smoke-boot.js"
```

- [ ] **0.8** Rodar `npm run smoke` na branch atual

```bash
npm run smoke
```
Esperado: `✓ Smoke OK` + exit 0. Se falhar, debugar antes de prosseguir (não é regressão da modularização — é estado atual).

- [ ] **0.9** Capturar 5 payloads reais para replay

Extrair do `logs/parsed/parsed-events.jsonl` 5 eventos cobrindo: (1) primeira mensagem de texto, (2) reply em card antigo, (3) áudio, (4) imagem, (5) clique em botão. Salvar em `tests/_fixtures/replay-payloads.json` como array `[{name, payload}]`.

```bash
# Inspecionar primeiras linhas para escolher os 5
head -200 logs/parsed/parsed-events.jsonl | jq 'select(.type=="webhook_inbound") | {type, body: .body | .[:200]}' | head -50
```

(Se `jq` não estiver disponível, ler manualmente com Read.)

- [ ] **0.10** Criar `scripts/replay-webhook.js`

```js
// Faz POST /webhook para cada fixture. Compara output (logs) entre baseline e alvo.
// Uso: node scripts/replay-webhook.js [--baseline | --compare baseline.log]
const fs = require('fs');
const path = require('path');
const http = require('http');

const fixtures = require(path.join(__dirname, '..', 'tests', '_fixtures', 'replay-payloads.json'));
const PORT = process.env.PORT || 3999;

async function postPayload(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/webhook',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, res => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

(async () => {
  const results = [];
  for (const f of fixtures) {
    const r = await postPayload(f.payload);
    results.push({ name: f.name, status: r.status, body: r.body });
    console.log(`▶ ${f.name} → ${r.status}`);
  }
  fs.writeFileSync(
    path.join(__dirname, '..', 'tests', '_fixtures', 'replay-output.json'),
    JSON.stringify(results, null, 2)
  );
})();
```

- [ ] **0.11** Adicionar `replay` ao `package.json`

```json
"replay": "node scripts/replay-webhook.js"
```

- [ ] **0.12** Rodar baseline do replay (com servidor smoke rodando em outro terminal)

```bash
# terminal 1
node index.js
# terminal 2
PORT=3000 node scripts/replay-webhook.js
```
Esperado: arquivo `tests/_fixtures/replay-output.json` criado com 5 entradas, todas `status: 200` (assumindo Z-API permite payloads duplicados — se não, isolar com mock leve depois).

- [ ] **0.13** Commit Fase 0

```bash
git add scripts/ tests/_fixtures/ tests/_categories.md package.json
git commit -m "chore(modularizacao): rede de segurança (smoke + test:all + replay)"
```

---

## Fase 1: Helpers puros sem efeito colateral

**Objetivo:** extrair funções 100% puras (sem `await`, sem mutação de estado externo, sem I/O) para `src/utils/`. Risco mínimo.

**Funções a mover:**
- `digitsOnly`, `normalizeWhatsAppPhone`, `isAdminPhone` → `src/utils/phone.js`
- `parseBelaPauseCommand`, `parseTrackingCommand` → `src/inbound/command-parsers.js` *(NOTA: dependem de `ADMIN_PHONES`/`isAdminPhone` — ver step 1.X)*
- `parseCompoundSpec`, `parseGradeText` → `src/utils/compound-parser.js`
- `extractTextFromEvent`, `extractAudioUrl`, `extractEventVersion`, `parseSizeQtyEvent` → `src/utils/event-extractor.js`
- `getPublicBaseUrl`, `buildPublicAssetUrl` → `src/utils/public-url.js`
- `normalizeVariantText`, `matchVariant`, `parseMultiVariantGrade`, `normalizeSizeValue` → `src/utils/variant-text.js`

**Arquivos:**
- Criar: `src/utils/phone.js`, `src/utils/compound-parser.js`, `src/utils/event-extractor.js`, `src/utils/public-url.js`, `src/utils/variant-text.js`
- Criar: `src/inbound/command-parsers.js`
- Criar: `tests/utils/phone.test.js`, `tests/utils/compound-parser.test.js`, `tests/utils/event-extractor.test.js`, `tests/utils/variant-text.test.js`
- Modificar: `index.js` (substituir definições por imports)

### Steps — sub-fase 1A: phone helpers

- [ ] **1A.1** Escrever teste falhante `tests/utils/phone.test.js`

```js
const assert = require('assert');
const { digitsOnly, normalizeWhatsAppPhone, isAdminPhone } = require('../../src/utils/phone');

// digitsOnly
assert.strictEqual(digitsOnly('+55 (61) 8266-3442'), '5561826633442');
assert.strictEqual(digitsOnly(null), '');
assert.strictEqual(digitsOnly(undefined), '');

// normalizeWhatsAppPhone
assert.strictEqual(normalizeWhatsAppPhone('61826633442'), '5561826633442');
assert.strictEqual(normalizeWhatsAppPhone('5561826633442'), '5561826633442');
assert.strictEqual(normalizeWhatsAppPhone('+5561826633442'), '5561826633442');
assert.strictEqual(normalizeWhatsAppPhone('0061826633442'), '5561826633442');
assert.strictEqual(normalizeWhatsAppPhone('123'), null);
assert.strictEqual(normalizeWhatsAppPhone(''), null);

// isAdminPhone — depende de injeção de ADMIN_PHONES
assert.strictEqual(isAdminPhone('556182663442', ['556182663442']), true);
assert.strictEqual(isAdminPhone('+55 (61) 8266-3442', ['556182663442']), true);
assert.strictEqual(isAdminPhone('556182663442', []), false);

console.log('✓ phone helpers');
```

- [ ] **1A.2** Rodar e verificar que falha

```bash
node tests/utils/phone.test.js
```
Esperado: erro "Cannot find module '../../src/utils/phone'".

- [ ] **1A.3** Criar `src/utils/phone.js`

Copiar EXATAMENTE as funções `digitsOnly` (linha 61), `normalizeWhatsAppPhone` (linha 65), `isAdminPhone` (linha 80) do `index.js`. Modificar `isAdminPhone` para receber `adminPhones` como parâmetro (era global `ADMIN_PHONES`):

```js
function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeWhatsAppPhone(value) {
  let digits = digitsOnly(value);
  if (!digits) return null;

  while (digits.startsWith('00')) digits = digits.slice(2);
  while (digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  }

  if (digits.length < 12 || digits.length > 15) return null;
  return digits;
}

function isAdminPhone(phone, adminPhones) {
  const normalized = normalizeWhatsAppPhone(phone);
  if (!normalized) return false;
  return adminPhones.some((adminPhone) => normalizeWhatsAppPhone(adminPhone) === normalized);
}

module.exports = { digitsOnly, normalizeWhatsAppPhone, isAdminPhone };
```

- [ ] **1A.4** Rodar teste, deve passar

```bash
node tests/utils/phone.test.js
```
Esperado: `✓ phone helpers`.

- [ ] **1A.5** Substituir em `index.js`: importar, remover definições, ajustar chamadas

No topo de `index.js`, perto dos outros requires:

```js
const { digitsOnly, normalizeWhatsAppPhone, isAdminPhone: isAdminPhoneRaw } = require('./src/utils/phone');
const isAdminPhone = (phone) => isAdminPhoneRaw(phone, ADMIN_PHONES);
```

Remover as 3 funções (linhas ~61-84) do `index.js`.

- [ ] **1A.6** Rodar smoke + tests

```bash
npm run smoke
npm run test:all
node tests/utils/phone.test.js
```
Esperado: smoke OK, all tests still pass.

- [ ] **1A.7** Commit

```bash
git add src/utils/phone.js tests/utils/phone.test.js index.js
git commit -m "refactor(modularizacao): extrai helpers de telefone para src/utils/phone.js"
```

### Steps — sub-fase 1B: compound parser

- [ ] **1B.1** Escrever `tests/utils/compound-parser.test.js`

Cobrir os 6 casos críticos do `parseCompoundSpec` documentados em `08 - Tarefas e Bugs Pendentes.md` do Obsidian: "P+P", "M+G+G", "2P+1M", "PP, P, M", "M G G", "2 m + 1 g". E `parseGradeText` com `['P','M','G','GG']`.

```js
const assert = require('assert');
const { parseCompoundSpec, parseGradeText } = require('../../src/utils/compound-parser');

// parseCompoundSpec — extrair tamanhos compostos
const r1 = parseCompoundSpec('P+P');
assert.deepStrictEqual(r1, { items: [{ size: 'P', qty: 1 }, { size: 'P', qty: 1 }] });

const r2 = parseCompoundSpec('2P+1M');
assert.deepStrictEqual(r2, { items: [{ size: 'P', qty: 2 }, { size: 'M', qty: 1 }] });

const r3 = parseCompoundSpec('PP, P, M');
assert.deepStrictEqual(r3, { items: [{ size: 'PP', qty: 1 }, { size: 'P', qty: 1 }, { size: 'M', qty: 1 }] });

const r4 = parseCompoundSpec('texto qualquer sem tamanhos');
assert.strictEqual(r4, null);

// parseGradeText — espera array de tamanhos conhecidos
const g1 = parseGradeText('P, M, G', ['P', 'M', 'G', 'GG']);
assert.deepStrictEqual(g1, [{ size: 'P', qty: 1 }, { size: 'M', qty: 1 }, { size: 'G', qty: 1 }]);

console.log('✓ compound-parser');
```

(Steps 1B.2-1B.7 análogos a 1A.2-1A.7 — falha→cria→passa→substitui→smoke→commit.)

### Steps — sub-fase 1C: event extractors

Análogo. Inputs: payloads reais Z-API capturados em `tests/_fixtures/replay-payloads.json`. Outputs: texto extraído, URL de áudio, version do eventId, etc.

### Steps — sub-fase 1D: public-url

Análogo. Mais simples — `getPublicBaseUrl(req)` lê `req.headers['x-forwarded-host']` ou `req.get('host')`.

### Steps — sub-fase 1E: variant-text

Análogo. Cobre `normalizeVariantText`, `matchVariant`, `parseMultiVariantGrade`, `normalizeSizeValue`.

### Steps — sub-fase 1F: command-parsers

Análogo. `parseBelaPauseCommand`, `parseTrackingCommand` movem para `src/inbound/command-parsers.js`.

### Validação final da Fase 1

- [ ] **1.FINAL.1** `npm run test:all` passa (todos os tests originais + os 6 novos)
- [ ] **1.FINAL.2** `npm run smoke` passa
- [ ] **1.FINAL.3** `npm run replay` produz output **byte-idêntico** ao baseline da Fase 0

```bash
diff tests/_fixtures/replay-output.json tests/_fixtures/replay-output.baseline.json
```
Esperado: sem diff. Se houver, é regressão — debugar antes do PR.

- [ ] **1.FINAL.4** Atualizar Obsidian: criar `D:\obsidian\Agente Belux\Agente Belux Docs\18 - Modularização do index.js.md` linkado em `00 - Visão Geral.md`. Conteúdo: estado da Fase 1 (módulos extraídos, linhas reduzidas em `index.js`).

- [ ] **1.FINAL.5** Abrir PR `feat/modularizacao-index` → `main` com label `refactor` e descrição apontando para este plano.

---

## Fases 2-12: outline (a detalhar quando começarem)

Cada fase abaixo é um PR. **O bite-sized step list de cada fase é escrito como primeiro passo da própria fase**, baseado em aprendizados das anteriores.

### Fase 2 — Estado compartilhado

Mover mapas em memória (`sessions`, `sessionLoadLocks`, `persistQueues`, `SEEN_MESSAGE_IDS`, `buyDebounceBuffer`, `silentAddDebounce`, `phoneProcessingQueue`, `upsellHandoffTimers`, `fecharPedidoInactivityTimers`, `compoundConfirmationTimers`, `normalCompoundTimers`, `inboundTextDebounceBuffer`) para `src/boot/shared-state.js`.

**Risco:** todos os módulos posteriores vão depender desses. Erro aqui é caro.

**Mitigação:** uma única sessão de trabalho focada; replay extensivo; rollback fácil (1 PR).

### Fase 3 — Sessão (lifecycle + history + flags)

Mover `getSession`, `persistSession`, `appendHistory`, `trimSessionHistory`, `getActiveHistoryWindow`, `isBotSuspendedForHuman`, `shouldSkipBotAutomation`, image-match flags.

### Fase 4 — Messaging primitives

`sendTextWithTTS`, `sendLoadingMessage`, `pickLoadingPhrase`, `pickSearchLoadingPhrase`, `sendCategoryMenu`, `sendCategoryCard`, `sendCategoryShowcase`, `getOrderGuideImageDataUri`.

### Fase 5 — IA context

`buildFsmContext`, `buildAiContext`, `buildReflectionPrompt`, `normalizeCategorySlug`, `clearSupportMode`, `cancelCurrentFlow`, `isShoppingResumeIntent`, `isHumanPauseResumeIntent`.

### Fase 6 — Produto / Stock / Variante

Resolver, stock, variant, size-qty list. Independente de FSM.

### Fase 7 — Carrinho

Operations, summary, menus, edit-from-quote, label-helpers.

### Fase 8 — FSM

A mais delicada antes do `/webhook`. `purchase-flow` factory + reset, `handlePurchaseFlowEvent`, queue, interactive, compound, focus.

**Aviso:** `handlePurchaseFlowEvent` tem ~373 linhas com muitos paths. Pode precisar sub-extração interna antes de mover.

### Fase 9 — Catálogo

Browse, commercial-search, render.

### Fase 10 — Handoff

Consultant, scheduler, failure.

### Fase 11 — Admin

`handleBelaPauseAdminCommand`, `handleTrackingAdminCommand`, `sendLegacyHandoffToAdmin(s)`, `buildAdminPdfHeader`.

### Fase 12 — `/webhook` dispatcher

**A boss fight.** O handler `app.post('/webhook')` (linhas 1504-4220, 2716 linhas) precisa virar:

```js
app.post('/webhook', async (req, res) => {
  const ctx = buildWebhookContext(req);
  if (!ctx) return res.sendStatus(200);
  return dispatchInbound(ctx, res);
});
```

E o `dispatchInbound` se quebra em: `handleAdminCommand`, `handleHumanPause`, `handleAudioInbound`, `handleImageInbound`, `handleTextInbound`, `handleButtonReply`, `handleListReply`, etc.

**Regra:** cada handler interno é movido um por vez, com replay validando a cada movimentação. Esta fase pode levar 3-5 dias sozinha.

### Fase 13 — Cleanup final

`index.js` reduzido a ~150 linhas (boot + wiring + listen). Deletar imports mortos, consolidar requires.

---

## Decisões abertas (preciso de input do Renan)

1. **`src/` vs flat?** Algumas codebases Node.js evitam `src/` (porque o `package.json` aponta `main: index.js`). Manter `src/` ajuda VSCode/lint a separar app code de scripts/tests. Mantenho `src/`?
2. **Naming:** prefiro kebab-case (`compound-parser.js`) seguindo padrão atual do `services/`. Concorda?
3. **`shared-state.js` como singleton vs DI?** Singleton é simples, mas dificulta teste isolado. DI (passar state como parâmetro) é mais ortodoxo, mas exige mudar dezenas de assinaturas. **Recomendo singleton** com comentário explícito de teste-burnout-acceptance.
4. **`src/services/` migra também?** Os arquivos atuais em `services/` são bem cortados. **Recomendo NÃO mover** — eles já estão bons. O plano só ataca `index.js`.
5. **Testes — Jest/Mocha/Vitest?** Hoje são `node tests/foo.test.js` puros. Migrar para framework é fora de escopo desta modularização. **Mantenho node assert** ao escrever testes novos.

---

## Riscos conhecidos

| Risco | Mitigação |
|---|---|
| Quebrar fluxo de venda em produção sem perceber | Replay automatizado + smoke a cada commit. PR só merge depois de smoke verde. |
| `app.post('/webhook')` ter dependências circulares quando dividido | Fase 12 fica por último; até lá todos os módulos auxiliares já estão isolados e testados. |
| Sessões em memória ficarem inconsistentes durante migração de `shared-state` | Fase 2 inteira em uma sessão de foco; restart do servidor aceita perda da sessão em memória (Supabase recupera). |
| Tests "manuais" (ex: `manual-bela-pause.test.js`) não rodando no CI | Fase 0 categoriza; manuais ficam fora do gate `test:all`, mas precisam rodar no fim de cada fase manualmente. |

---

## Checklist final de auto-review

- [x] Cada fase produz software funcional sozinha (mergeable)
- [x] Fase 0 e 1 detalhadas com código real (sem placeholders nas fases iniciais)
- [x] Fases 2-12 são outline honesto (será detalhado quando começar)
- [x] Riscos listados com mitigação concreta
- [x] Decisões abertas explícitas, não escondidas em "TBD"
- [x] CLAUDE.md respeitado: PT-BR, atualização do Obsidian em paralelo
- [x] Comportamento observável imutável em todos os commits

---

## Próximo passo

Aguardar resposta do Renan sobre as **5 decisões abertas** acima. Em particular: `src/` vs flat e singleton vs DI mudam materialmente a forma do código.

Depois disso → executar Fase 0 (rede de segurança).
