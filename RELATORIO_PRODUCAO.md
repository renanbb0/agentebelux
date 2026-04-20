# Relatório de Produção — Agente Belux

**Gerado em:** 17/04/2026, 21:45:13
**Logs analisados:** 6 arquivo(s)
- `belux-20260417-0317.log`
- `belux-20260417-0318.log`
- `belux-20260417-0736.log`
- `belux-20260417-0955.log`
- `belux-20260417-1038.log`
- `belux-20260417-1041.log`

---

## 📊 Visão Geral

| Métrica | Valor |
|---------|-------|
| Total de eventos parseados | 6.516 |
| Total de sessões | 28 |
| Clientes únicos | 21 |
| Mensagens recebidas | 99 |
| Mensagens enviadas | 949 |
| Média de msgs/sessão | 3.5 |
| Chamadas à IA | 29 |
| Falhas da IA | 0 |
| Erros totais (logs) | 4 |
| **Taxa de handoff** | **25.0%** (7/28) |
| **Taxa de conversão (sessão com item no carrinho)** | **3.6%** (1/28) |
| Clientes com nome capturado | 0 (0.0%) |

## 🚨 Gatilhos de Handoff

| Gatilho | Ocorrências |
|---------|-------------|
| `SEMANTICA_WANTS_HUMAN` | 4 |
| `UNKNOWN` | 2 |
| `AUTO_ESCALATION` | 1 |

## 🧠 Intenções Semânticas Detectadas

| Intenção | Total |
|----------|-------|
| wantsHuman | 6 |
| wantsCheckout | 3 |
| wantsClearCart | 0 |
| wantsCart | 0 |

## 🤖 Ações da IA (parseAction)

| Action Type | Ocorrências |
|-------------|-------------|
| `TEXT_ONLY` | 13 |
| `VER_TODOS` | 12 |
| `VER` | 2 |
| `CARRINHO` | 1 |
| `FOTOS` | 1 |

## 🔍 Top 10 sessões por duração

| Cliente | Duração | Msgs | Carrinho | Handoff | Erros |
|---------|---------|------|----------|---------|-------|
| 5534****3844 | 110min | 17 | 0 | ✓ | 0 |
| 5588****5536 | 103min | 7 | 0 | — | 0 |
| 5585****7537 | 98min | 3 | 0 | ✓ | 0 |
| 5588****0051 | 83min | 9 | 0 | ✓ | 0 |
| 5588****5269 | 69min | 6 | 0 | — | 3 |
| 5563****6356 | 61min | 4 | 0 | — | 0 |
| 5531****7833 | 57min | 6 | 0 | — | 0 |
| 5582****0066 | 44min | 5 | 0 | — | 0 |
| 5566****0050 | 42min | 4 | 0 | — | 0 |
| 5585****5870 | 39min | 1 | 0 | — | 0 |

## 🔥 Top 10 sessões por erros

| Cliente | Erros | Falhas IA | Handoff | Gatilho |
|---------|-------|-----------|---------|---------|
| 5588****5269 | 3 | 0 | — | — |
| 5551****4247 | 1 | 0 | — | — |

## ⚠️ Erros agrupados por marker

| Marker | Ocorrências | Amostra |
|--------|-------------|---------|
| `[TTS] Erro ao enviar áudio` | 4 | Request failed with status code 429 |

---

## 📁 Arquivos gerados

- `logs/parsed/parsed-events.jsonl` — todos os eventos estruturados
- `logs/parsed/sessions.jsonl` — uma linha por sessão (com timeline)
- `RELATORIO_PRODUCAO.md` — este relatório

> Para análise mais profunda por IA, mande `sessions.jsonl` para o Gemini
> com prompt: "Analise estas sessões, agrupe padrões de falha e sugira melhorias."