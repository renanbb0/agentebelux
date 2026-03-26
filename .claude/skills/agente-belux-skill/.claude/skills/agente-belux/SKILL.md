---
name: agente-belux
description: >
  Skill mestre do projeto Agente Belux — bot de vendas WhatsApp para Belux Moda Íntima,
  desenvolvido pela Lume Soluções. Cobre Z-API (webhooks, eventos, envio de mensagens),
  WooCommerce REST API (catálogo, categorias, produtos), Groq SDK (IA, prompts, action tokens,
  modelo qwen3-32b), arquitetura Node.js/Express, sessões em memória, carrinho de compras,
  e documentação no Obsidian. USE ESTA SKILL SEMPRE que o contexto envolver: WhatsApp bot,
  Z-API, WooCommerce, Groq, Belux, moda íntima, agente de vendas, webhook, catálogo de
  produtos, carrinho, sessão de cliente, Obsidian vault do projeto, ou qualquer tarefa
  de desenvolvimento, debug, refatoração ou documentação do Agente Belux. Mesmo que o
  usuário não mencione "Belux" explicitamente — se a tarefa envolve bot de WhatsApp com
  WooCommerce neste workspace, esta skill se aplica.
---

# Agente Belux — Skill Mestre (Claude Code)

> Bot de vendas WhatsApp para **Belux Moda Íntima** · Lume Soluções
> Stack: Node.js · Express 5 · Z-API · WooCommerce REST · Groq SDK (qwen3-32b)

## Mapa do Projeto

```
Agente Belux/
├── index.js                 ← Servidor Express, webhook, lógica principal
├── services/
│   ├── zapi.js              ← Envio de mensagens (Z-API WhatsApp SaaS)
│   ├── woocommerce.js       ← Catálogo de produtos (WooCommerce REST v3)
│   └── groq.js              ← IA conversacional (Groq + qwen3-32b)
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
GROQ_API_KEY=           # gsk_xxxxx
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

| Pacote | Versão | Uso |
|---|---|---|
| `express` | ^5.2.1 | Servidor HTTP + webhook |
| `axios` | ^1.13.6 | HTTP client (Z-API, WooCommerce) |
| `dotenv` | ^17.3.1 | Variáveis de ambiente |
| `groq-sdk` | ^1.1.2 | SDK oficial da Groq |

## Status do Projeto

- ✅ Migração Evolution API → Z-API concluída (2026-03-25)
- ✅ Webhook recebendo mensagens de texto
- ✅ IA conversacional (Groq qwen3-32b) com persona "Bela"
- ✅ Catálogo WooCommerce integrado (feminino, masculino, infantil)
- ✅ Carrinho em memória + finalização de pedido
- ✅ Envio de texto e imagem via Z-API
- 🟡 Humanização e eventos WhatsApp (doc 09 criado, implementação pendente)
- 🟡 Handoff para atendente humano (planejado)
- 🟡 Link de pagamento (planejado)
- 🟡 RAG avançado / substituição por similaridade (planejado)
- 🟡 Persistência de sessões (atualmente só em memória)
