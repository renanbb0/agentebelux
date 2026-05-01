# Categorias dos Testes

Baseline de 2026-05-01: **20/20 tests passam** com `npm run test:all`.

Este arquivo categoriza cada test para guiar decisões durante a modularização do `index.js`.

## Formato

`- <nome>.test.js — <categoria> — <observação>`

Categorias:
- **unit** — puro, sem I/O externo, sem estado de servidor. Pode rodar a qualquer hora.
- **integration** — requer mock leve, mas roda offline.
- **fragile-textual** — lê `index.js` via `fs.readFileSync` + `vm.Script` para extrair blocos por marcadores de comentário. **Vai quebrar quando os helpers correspondentes forem movidos para `src/`** — precisa ser reescrito para usar `require('../src/...')` na fase em que o helper migrar.
- **skip** — não roda em `npm run test:all` (precisa servidor real, credenciais, etc).

## Lista

- buy-debounce.test.js — unit — debounce de buy events
- catalog-index-integration.test.js — integration — index local do catálogo
- catalog-query-resolver.test.js — unit — resolver de query
- catalog-search.test.js — unit — busca textual
- compound-robustness.test.js — unit — robustez do compound parser
- fechar-pedido-inactivity.test.js — unit — timer de inatividade
- gemini-sanitize.test.js — unit — sanitização Gemini
- handoff-pdf-flow.test.js — integration — fluxo de handoff PDF
- inbound-message-buffer.test.js — fragile-textual — extrai bloco `// -- Inbound text debounce --` de index.js (Fase 1F)
- manual-bela-pause.test.js — fragile-textual — extrai bloco `// -- Manual Bela pause helpers --` de index.js (Fase 1A/1F)
- order-groups.test.js — unit — agrupamento de pedidos
- order-guide-image.test.js — unit — imagem de guia
- order-pdf.test.js — unit — geração de PDF
- semantic-commercial-intents.test.js — unit — intents comerciais
- size-prompt-reply.test.js — unit — prompt de tamanho
- stock-and-reply-context.test.js — unit — contexto de stock/reply
- tracking-command.test.js — fragile-textual — extrai bloco `// -- Tracking command --` de index.js (Fase 1F)
- tts.test.js — integration — stub de axios para Gemini TTS
- woocommerce-commercial-search.test.js — integration — Woo search
- zapi-document.test.js — unit — sendDocument

## Notas para a Fase 1

Os 3 tests **fragile-textual** dependem de marcadores de comentário em `index.js`. Quando os helpers correspondentes migrarem para `src/`:

1. **manual-bela-pause.test.js** (Fase 1A/1F) — passar a importar de `src/utils/phone.js` e `src/inbound/command-parsers.js`
2. **tracking-command.test.js** (Fase 1F) — passar a importar de `src/inbound/command-parsers.js`
3. **inbound-message-buffer.test.js** (Fase 1F) — passar a importar do novo módulo `src/inbound/debounce.js`

A migração do test e do helper deve ser **no mesmo commit**, para manter o commit verde.

## Como gerar baseline de replay

O `npm run replay` precisa de um servidor rodando (não sobe sozinho — operador-run para evitar processos órfãos no Windows).

```bash
# Terminal 1
npm start

# Terminal 2 (depois do "Agente Belux running")
npm run replay
mv tests/_fixtures/replay-output.json tests/_fixtures/replay-output.baseline.json
```

Para validar regressão depois de uma fase:

```bash
# (servidor rodando)
npm run replay
diff tests/_fixtures/replay-output.json tests/_fixtures/replay-output.baseline.json
```

Sem diff → sem regressão observável no ack do `/webhook`. Diff → investigar antes de mergear.
