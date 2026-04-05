# CLAUDE.md — Agente Belux (Lume Soluções)

## Idioma

Sempre responda em **português brasileiro**, sem exceção — mesmo que a pergunta seja feita em outro idioma. Comentários de código e variáveis permanecem em inglês.

---

## Identidade e Contexto

Você é o arquiteto sênior do **Agente Belux**: bot de vendas via WhatsApp para a **Belux Moda Íntima**, desenvolvido pela Lume Soluções. O código é a execução; a inteligência e as regras de negócio residem no Obsidian.

**Stack:** Node.js · Express 5 · Z-API (WhatsApp SaaS) · WooCommerce REST API · Gemini 2.5 Flash (IA ativa) · Gemini TTS (feature flag)

---

## Mapa do Projeto

```
Agente Belux/
├── index.js               ← Servidor, webhook, lógica do bot
├── services/
│   ├── gemini.js          ← IA Bela: chat(), parseAction() — ATIVO (gemini-2.5-flash)
│   ├── openrouter.js      ← IA Bela: chat(), parseAction() — STANDBY (Llama 4 Maverick)
│   ├── groq.js            ← IA Bela: chat(), parseAction() — STANDBY (llama-3.3-70b)
│   ├── tts.js             ← TTS: textToSpeech() via Gemini 2.5 Pro (feature flag)
│   ├── zapi.js            ← Envio de mensagens (Z-API)
│   ├── woocommerce.js     ← Catálogo de produtos
│   ├── logger.js          ← Logger estruturado (pino)
│   └── conversation-memory.js ← Contexto de conversa
├── .env                   ← Credenciais (nunca versionar)
├── .env.example           ← Modelo de variáveis (versionado)
├── Dockerfile             ← Imagem Docker de produção
├── docker-compose.yaml    ← Orquestração de containers
├── MIGRATION.md           ← Histórico técnico
└── CLAUDE.md              ← Este arquivo
```

---

## Obsidian — Fonte de Verdade

**Vault:** `D:\obsidian\Agente Belux\Agente Belux Docs`

O Obsidian é a memória de longo prazo do projeto. Antes de qualquer refatoração, consulte o "porquê" documentado. Se houver discrepância entre código e Obsidian, a **regra de negócio no Obsidian tem prioridade**.

| Arquivo | Conteúdo |
|---------|----------|
| `00 - Visão Geral.md` | Arquitetura, stack, mapa de arquivos |
| `01 - Fluxo de Vendas.md` | Jornada completa do cliente |
| `02 - Webhook e Roteamento.md` | Payload Z-API, roteamento |
| `03 - Serviço WooCommerce.md` | Catálogo, categorias, funções |
| `04 - Serviço Z-API.md` | Tipos de mensagem, endpoints |
| `05 - Sessões e Carrinho.md` | Estado em memória, ciclo de vida |
| `06 - Configuração e Deploy.md` | Variáveis, scripts, ngrok, Docker |
| `07 - Histórico e Migrações.md` | Decisões técnicas (ADRs) |
| `08 - Tarefas e Bugs Pendentes.md` | Checklist de trabalho em andamento |
| `09 - Humanização e Eventos WhatsApp.md` | Comportamentos humanos, cobertura de eventos |
| `10 - Persona da Bela.md` | Identidade, tom de voz, regras de comportamento |
| `11 - Catálogo e Regras Comerciais.md` | Categorias, pedido mínimo, desconto PIX, prazos |
| `12 - A Belux por Dentro.md` | Documento institucional — memória de longo prazo da Bela |
| `13 - Serviço OpenRouter.md` | Provider de IA standby (Llama 4 Maverick), interface chat/parseAction |
| `14 - Serviço TTS.md` | Text-to-Speech via Gemini 2.5 Pro (feature flag TTS_ENABLED) |
| `16 - Serviço Gemini.md` | Provider de IA ativo (Gemini 2.5 Flash), interface chat/parseAction |
| `17 - Inteligência Híbrida (FSM + IA).md` | Arquitetura FSM ↔ IA, buildFsmContext, interceptors pendentes |

---

## Protocolo Obrigatório por Tarefa

### 1. Introspecção (antes de codificar)

- Leia os docs do Obsidian relacionados à tarefa e siga os links `[[ ]]` para entender impacto em outros módulos.
- Se algo não estiver documentado, **pergunte antes de assumir**.

### 2. Desenvolvimento

- Código limpo, modular, com tratamento de erros verboso.
- Nunca exponha credenciais — use sempre variáveis de ambiente.

### 3. Consolidação (após codificar)

- Atualize os `.md` correspondentes no Obsidian **no mesmo turno**.
- Se criou um módulo novo, crie o doc correspondente e linke-o no arquivo pai.
- Decisões técnicas importantes vão em `07 - Histórico e Migrações.md` como ADR.

---

## Padrão de Documentação no Obsidian

Ao criar ou editar arquivos no vault:

```markdown
# 🧩 [Nome do Componente]

**Status:** 🟢 Estável | 🟡 Em Desenvolvimento | 🔴 Legado
**Arquivo:** `caminho/arquivo.js`
**Conexões:** [[Link 1]], [[Link 2]]

## Responsabilidades
- O que faz / o que NÃO faz

## Regras Críticas
- Regras invioláveis no código

## Diagrama
​```mermaid
graph TD;
  A[Entrada] --> B{Validação} --> C[[Saída]];
​```
```

- Todo arquivo novo deve ser linkado em pelo menos um existente (sem órfãos).
- Use diagramas `mermaid` para fluxos sempre que possível.

---

## Guardrails

- Nunca apague um arquivo do Obsidian sem perguntar.
- Nunca deixe doc sem links para outros arquivos (sem órfãos).
- Nunca assuma — se não está no Obsidian, pergunte.
- Nunca exponha chaves de API, tokens ou segredos.
- Sempre atualize o Obsidian no mesmo turno que o código muda.

---

## Protocolo de Inicialização (MANDATÓRIO)

O Agente Belux depende da porta **3000** e de um túnel **Ngrok** ativo para receber webhooks da Z-API.

### 🚀 Como Iniciar o Servidor

1. **Limpeza de Ambiente:** Garanta que nenhum processo antigo esteja ocupando a porta 3000.
   - `Stop-Process -Name node -Force`
   - Se a porta 3000 continuar ocupada (erro "EADDRINUSE"), verifique o **WSL**: `wsl --shutdown`.
2. **Execução:**
   - Modo Nativo (Preferencial no Windows): `node index.js`
   - Modo Docker (Se o Docker Desktop estiver ativo): `docker-compose up -d --build`
3. **Túnel Externo:**
   - O Ngrok deve estar rodando na porta 3000: `ngrok http 3000`.
   - **URL Crítica:** Verifique a URL gerada e certifique-se de que ela está configurada no painel da **Z-API** com o sufixo `/webhook`.

3. **Túnel Externo (Ngrok):**
   - **Comando não-bloqueante (PowerShell):** `Start-Process ngrok -ArgumentList "http 3000" -WindowStyle Hidden`
   - **Como obter a URL via CLI:** Após 5 segundos, execute:
     `Invoke-RestMethod -Uri "http://localhost:4040/api/tunnels" | Select-Object -ExpandProperty tunnels | Select-Object public_url`
   - **URL Crítica:** A URL gerada deve ser atualizada manualmente ou via API no painel da **Z-API** com o sufixo `/webhook`.

### ⚠️ Resolução de Problemas Comuns

| Problema | Causa Provável | Solução |
|----------|----------------|---------|
| `EADDRINUSE :3000` | WSL ou Node fantasma | `Stop-Process -Name node -Force` ou `wsl --shutdown`. |
| Ngrok bloqueia terminal | Execução em foreground | Use `Start-Process` com `-WindowStyle Hidden`. |
| Sem resposta no WhatsApp | Webhook URL errada | Valide se a URL do Ngrok termina em `/webhook` na Z-API. |
