---
name: agente-belux
description: >
  Skill mestre do projeto Agente Belux — bot de vendas WhatsApp para Belux Moda Íntima,
  desenvolvido pela Lume Soluções. Cobre Z-API (webhooks, envio de mensagens, quotedMessage,
  replyText, readMessage), WooCommerce REST API (catálogo, categorias, busca, paginação,
  deduplicação), Gemini 2.5 Flash (IA conversacional, TTS, action tokens), Supabase
  (sessões, learnings, pedidos), arquitetura Node.js/Express 5, sessões com timeout,
  carrinho de compras, handoff para humano, continuous learning, e documentação Obsidian.
  USE ESTA SKILL SEMPRE que o contexto envolver: WhatsApp bot, Z-API, WooCommerce, Gemini,
  Supabase, Belux, moda íntima, agente de vendas, webhook, catálogo, carrinho, sessão,
  debug, troubleshooting, bugs, logs, quotedMessage, reply de foto, TTS, handoff, learning,
  ou qualquer tarefa de desenvolvimento, debug, refatoração ou documentação do Agente Belux.
---

# Agente Belux — Skill Mestre (Claude Code)

> Bot de vendas WhatsApp para **Belux Moda Íntima** · Lume Soluções
> Stack: Node.js · Express 5 · Z-API · WooCommerce REST · Gemini 2.5 Flash · Supabase

## Mapa do Projeto

```
Agente Belux/
├── index.js                 ← Servidor Express, webhook, lógica principal
├── services/
│   ├── zapi.js              ← Envio/recebimento de mensagens (Z-API WhatsApp SaaS)
│   ├── woocommerce.js       ← Catálogo de produtos (WooCommerce REST v3)
│   ├── gemini.js            ← IA conversacional (Gemini 2.5 Flash)
│   ├── tts.js               ← TTS via Gemini (voz Aoede, feature flag)
│   ├── supabase.js          ← Persistência (sessões, pedidos, learnings)
│   ├── learnings.js         ← Extração de insights pós-venda
│   └── logger.js            ← Logger estruturado (pino + pino-pretty)
├── .env                     ← Credenciais (NUNCA versionar)
├── .claude/CLAUDE.md        ← Instruções gerais do Claude Code
├── MIGRATION.md             ← Histórico: Evolution API → Z-API
└── Obsidian Vault           ← D:\obsidian\Agente Belux\Agente Belux Docs
```

## Referências (Progressive Disclosure)

Leia APENAS a referência necessária para a tarefa atual. Cada arquivo está em `references/` dentro desta skill.

| Se a tarefa envolve... | Leia este arquivo | Tokens (~) |
|---|---|---|
| Webhook, envio de mensagens, payloads WhatsApp, Z-API | `references/zapi.md` | ~1800 |
| Catálogo, produtos, categorias, preços, WooCommerce | `references/woocommerce.md` | ~1700 |
| IA, prompts, action tokens, persona Bela, modelo Groq | `references/groq.md` | ~2000 |
| Visão geral, fluxo de venda, sessões, carrinho, ADRs | `references/arquitetura.md` | ~2400 |
| Documentação Obsidian, templates, vault, padrões | `references/obsidian.md` | ~1500 |
| Bugs, troubleshooting, erros conhecidos | `references/bugs.md` | ~1200 |

**Exemplo:** Tarefa "corrigir envio de imagem no WhatsApp" → leia `references/zapi.md`.
Tarefa "adicionar nova categoria" → leia `references/woocommerce.md` e `references/groq.md`.

## Variáveis de Ambiente

```env
ZAPI_INSTANCE_ID=       # ID da instância no painel Z-API
ZAPI_TOKEN=             # Token da instância
ZAPI_CLIENT_TOKEN=      # Client token (segurança extra)
WC_BASE_URL=            # Ex: https://belux.com.br/wp-json/wc/v3
WC_CONSUMER_KEY=        # ck_xxxxx
WC_CONSUMER_SECRET=     # cs_xxxxx
GEMINI_API_KEY=         # Gemini 2.5 Flash (IA + TTS)
SUPABASE_URL=           # URL do projeto Supabase
SUPABASE_ANON_KEY=      # Chave anônima Supabase
TTS_ENABLED=true        # Feature flag TTS
TTS_VOICE=Aoede         # Voz do TTS
ADMIN_PHONE=            # Notificação de handoff
PORT=3000
```

Nunca exponha essas chaves em código, logs, commits ou respostas.

## Protocolo Obrigatório (cada turno)

### Antes de codificar
1. Identifique quais referências desta skill são relevantes e leia-as.
2. Leia os docs Obsidian relacionados, seguindo links `[[ ]]` para entender impactos.
3. Se algo não está documentado → pergunte ao Renan.

### Durante o desenvolvimento
- Código limpo, modular, com tratamento de erros verboso.
- Variáveis e comentários de código em inglês.
- Respostas e comunicação sempre em português brasileiro.

### Após codificar (MESMO TURNO, OBRIGATÓRIO)
- Atualize os `.md` correspondentes no Obsidian vault (`D:\obsidian\Agente Belux\Agente Belux Docs`).
- Se criou módulo novo → crie doc no vault e linke em pelo menos 1 doc existente.
- Decisões técnicas importantes → ADR em `07 - Histórico e Migrações.md`.
- Se a mudança afetou arquitetura, APIs ou fluxos → atualize esta skill também.

## Guardrails

- Nunca apague arquivo do Obsidian sem perguntar.
- Nunca deixe doc sem links para outros (sem órfãos no vault).
- Nunca assuma — se não está documentado, pergunte.
- Nunca exponha chaves, tokens ou segredos em qualquer output.
- Nunca invente produtos — use apenas dados do WooCommerce.
- Sempre atualize Obsidian no mesmo turno que o código muda.
- Sempre use diagramas Mermaid para documentar fluxos.
- Sempre teste action tokens com regex antes de deploy.

## Comandos Úteis

```bash
npm run dev          # Dev com hot-reload (node --watch)
npm start            # Produção
ngrok http 3000      # Expor webhook para Z-API
curl localhost:3000  # Health check
```

## Dependências

| Pacote | Uso |
|---|---|
| `express` | Servidor HTTP + webhook |
| `axios` | HTTP client (Z-API, WooCommerce) |
| `dotenv` | Variáveis de ambiente |
| `@google/generative-ai` | Gemini 2.5 Flash (IA + TTS) |
| `@supabase/supabase-js` | Persistência (sessões, pedidos, learnings) |
| `pino` | Logger estruturado |
| `pino-pretty` | Formatação de logs no console |

## Status Atual do Projeto

- ✅ Migração Evolution API → Z-API concluída
- ✅ Migração Groq/Qwen → Gemini 2.5 Flash concluída
- ✅ Persistência Supabase (sessões, pedidos, learnings)
- ✅ TTS com Gemini (voz Aoede)
- ✅ Webhook com handling de texto, áudio (fallback), imagem, sticker
- ✅ Paginação de catálogo (10 por página)
- ✅ Busca por texto livre no WooCommerce
- ✅ Handoff para consultora humana com notificação
- ✅ Continuous learning (insights pós-venda)
- ✅ Session timeout (30min) + cleanup automático
- ✅ Guards: anti-saudação, anti-lista-inventada, reset de contexto
- 🔴 Bug: foto errada ao citar mensagem (quotedMessage)
- 🔴 Bug: logs não estão sendo salvos em arquivo
- 🟡 Bug: produtos duplicados no catálogo masculino
- 🟡 Pedidos mistos multi-categoria (limitação estrutural)
