# Z-API — Referência Completa

> Serviço SaaS para WhatsApp Business · Substituiu a Evolution API em 2026-03-25

---

## Sumário

1. [Configuração](#configuração)
2. [Cliente HTTP](#cliente-http)
3. [Endpoints de Envio](#endpoints-de-envio)
4. [Webhook (Recebimento)](#webhook-recebimento)
5. [Payload do Webhook](#payload-do-webhook)
6. [Tipos de Evento](#tipos-de-evento)
7. [Mapeamento Evolution → Z-API](#mapeamento-evolution--z-api)
8. [Erros Comuns](#erros-comuns)

---

## Configuração

### Variáveis de Ambiente

```env
ZAPI_INSTANCE_ID=sua_instancia     # Painel Z-API → Instância → ID
ZAPI_TOKEN=seu_token               # Painel Z-API → Instância → Token
ZAPI_CLIENT_TOKEN=seu_client_token # Painel Z-API → Segurança → Client Token
```

### URL Base

```
https://api.z-api.io/instances/{INSTANCE_ID}/token/{TOKEN}
```

### Configuração de Webhook no Painel Z-API

1. Acesse o painel Z-API
2. Vá em Instância → Webhooks
3. Configure a URL: `https://SEU_DOMINIO/webhook`
4. Selecione os eventos desejados (mensagens recebidas)
5. Salve

---

## Cliente HTTP

**Arquivo:** `services/zapi.js`

```javascript
const zapiClient = axios.create({
  baseURL: `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`,
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
});

// Client-Token opcional (segurança extra)
if (ZAPI_CLIENT_TOKEN) {
  zapiClient.defaults.headers.common['Client-Token'] = ZAPI_CLIENT_TOKEN;
}
```

---

## Endpoints de Envio

### Enviar Texto

```javascript
async function sendText(to, message) {
  return zapiClient.post('/send-text', { phone: to, message });
}
```

**Payload:**
```json
{ "phone": "5585999999999", "message": "Olá! 👋" }
```

### Enviar Imagem

```javascript
async function sendImage(to, imageUrl, caption) {
  return zapiClient.post('/send-image', {
    phone: to,
    image: imageUrl,
    caption,
  });
}
```

**Payload:**
```json
{
  "phone": "5585999999999",
  "image": "https://exemplo.com/foto.jpg",
  "caption": "✨ Produto X — R$ 49,90"
}
```

### Enviar List Message (Menu de Categorias) ✅ IMPLEMENTADO

```javascript
async function sendOptionList(to, message, title, buttonLabel, options) {
  const typingSeconds = Math.min(Math.max(Math.ceil(message.length / 80), 1), 5);
  const payload = {
    phone: to,
    message,
    optionList: { title, buttonLabel, options },
    delayMessage: typingSeconds,
  };
  return zapiClient.post('/send-option-list', payload);
}
```

**Payload de options:**
```js
[
  { id: 'cat_feminina', title: 'Linha Feminina', description: 'Vestidos, conjuntos e mais' },
  { id: 'cat_infantil', title: 'Linha Infantil', description: 'Conforto para os pequenos' },
  // ...
]
```

**Regras:**
- `buttonLabel` máximo 20 caracteres
- Quando o cliente seleciona, chega como texto normal no webhook (o `title` da opção)

### Enviar Botões Interativos ✅ IMPLEMENTADO

```javascript
async function sendButtonList(to, message, title, footer, buttonList) {
  return zapiClient.post('/send-button-list', { phone: to, message, title, footer, buttonList });
}
```

### Outros Endpoints Disponíveis (não implementados)

| Endpoint | Uso |
|---|---|
| `POST /send-link` | Link com preview |
| `POST /send-video` | Vídeo |
| `POST /send-document/{extension}` | Documentos (PDF, etc) |
| `POST /send-sticker` | Figurinhas |

### Delay entre Mensagens

```javascript
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Uso: await zapi.delay(400); // entre envios para evitar flood
```

---

## Webhook (Recebimento)

**Rota:** `POST /webhook` no `index.js`

```javascript
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responde IMEDIATAMENTE (Z-API exige)

  const body = req.body;
  const from = body?.phone || '';
  if (!from) return;
  if (body?.fromMe) return;         // Ignora mensagens enviadas pelo bot
  const text = (body?.text?.message || '').trim();
  if (!text) return;                 // Ignora mensagens sem texto

  // Processar mensagem...
});
```

**⚠️ IMPORTANTE:** Sempre retorne `200` antes de processar. A Z-API faz retry se não receber resposta rápida.

---

## Payload do Webhook

### Mensagem de Texto Recebida

```json
{
  "phone": "5585999999999",
  "fromMe": false,
  "text": {
    "message": "Quero ver as lingeries"
  },
  "messageId": "ABCDEF123456",
  "momment": 1711382400000,
  "instanceId": "sua_instancia"
}
```

### Campos Principais

| Campo | Tipo | Descrição |
|---|---|---|
| `phone` | string | Número do remetente (formato: 55DDD9XXXXXXXX) |
| `fromMe` | boolean | `true` se a mensagem foi enviada pelo bot |
| `text.message` | string | Conteúdo da mensagem de texto |
| `messageId` | string | ID único da mensagem |
| `momment` | number | Timestamp Unix em milissegundos |
| `instanceId` | string | ID da instância Z-API |

### Outros Campos (para eventos futuros)

| Campo | Descrição |
|---|---|
| `buttonPayload` | Payload de botão clicado |
| `listResponsePayload` | Payload de item de lista selecionado |
| `image` | Objeto de imagem recebida |
| `audio` | Objeto de áudio recebido |
| `document` | Objeto de documento recebido |

---

## Tipos de Evento

### Eventos já tratados
- **Mensagem de texto recebida** — Campo `text.message` preenchido

### Eventos planejados (09 - Humanização e Eventos WhatsApp.md)
- Mensagens de imagem, áudio, documento
- Cliques em botões (`buttonPayload`)
- Seleção em listas (`listResponsePayload`)
- Status de mensagem (entregue, lida)
- Presença (online, digitando)

---

## Mapeamento Evolution → Z-API

| Função | Evolution API | Z-API |
|---|---|---|
| Enviar texto | `POST /message/sendText/:instance` | `POST /send-text` |
| Enviar imagem | `POST /message/sendMedia/:instance` | `POST /send-image` |
| Enviar botões | `POST /message/sendButtons/:instance` | `POST /send-button-list` |
| Enviar lista | `POST /message/sendList/:instance` | `POST /send-option-list` |

### Payloads

```diff
# Texto
- { "number": "5511999...", "text": "..." }
+ { "phone": "5511999...", "message": "..." }

# Imagem
- { "number": "...", "mediatype": "image", "media": "url", "caption": "..." }
+ { "phone": "...", "image": "url", "caption": "..." }

# Webhook recebido
- body.data.key.remoteJid       → body.phone
- body.data.message.conversation → body.text.message
- body.data.key.fromMe          → body.fromMe
```

---

## Mensagens Citadas (quotedMessage)

### Estrutura do Payload (NÃO CONFIÁVEL)

Quando um cliente faz reply numa mensagem, o webhook inclui `body.quotedMessage`. A estrutura varia e NÃO é documentada oficialmente pelo Z-API. Campos conhecidos:

| Campo possível | Quando aparece |
|---|---|
| `quotedMessage.text.message` | Quote de texto puro |
| `quotedMessage.image.caption` | Quote de imagem (variante 1) |
| `quotedMessage.imageMessage.caption` | Quote de imagem (variante 2) |
| `quotedMessage.caption` | Campo direto (raro) |
| `quotedMessage.message.imageMessage.caption` | Aninhado (variante 3) |
| `quotedMessage.message.extendedTextMessage.text` | Texto estendido |

**⚠️ PROBLEMA ABERTO:** Nenhum desses campos funciona consistentemente para replies de FOTOS com caption. A causa está sendo investigada (Bug #1 em `references/bugs.md`).

### Endpoint REST para buscar mensagem por ID

Alternativa ao parsing inline — buscar a mensagem completa via API:

```
GET /messages/{messageId}
```

Parâmetros:
- `messageId`: ID da mensagem citada (disponível em `quotedMessage.messageId` ou `quotedMessage.stanzaId` ou `quotedMessage.id`)

Retorna o objeto completo da mensagem incluindo `caption`, `text`, etc.

Exemplo de uso:
```javascript
async function getMessageById(messageId) {
  try {
    const { data } = await zapiClient.get(`/messages/${messageId}`);
    return data;
  } catch (err) {
    logger.error({ messageId, error: err.message }, '[Z-API] getMessageById failed');
    return null;
  }
}
```

### Funções de envio atuais em `zapi.js`

| Função | Uso |
|---|---|
| `sendText(to, message)` | Texto simples com delayTyping |
| `replyText(to, message, messageId)` | Resposta citando mensagem original |
| `sendImage(to, imageUrl, caption)` | Imagem com legenda |
| `sendAudio(to, buffer, mimeType)` | Áudio base64 (TTS) |
| `readMessage(phone, messageId)` | Checks azuis |
| `getMessageById(messageId)` | Busca mensagem completa via REST |
| `sendButtonList(to, message, title, footer, buttonList)` | Botões interativos |
| `sendOptionList(to, message, title, buttonLabel, options)` | List Message (menu lateral) |
| `delay(ms)` | Pausa entre envios de imagem |

---

## Erros Comuns

| Erro | Causa | Solução |
|---|---|---|
| `401 Unauthorized` | Token inválido ou Client-Token ausente | Verifique `.env` e painel Z-API |
| `404 Not Found` | Instance ID errado | Confirme ID no painel |
| `429 Too Many Requests` | Rate limit | Adicione `delay()` entre envios |
| Webhook não recebe | URL não configurada ou ngrok caiu | Verifique painel Z-API → Webhooks |
| `fromMe: true` passando | Filtro não aplicado | Cheque `if (body?.fromMe) return;` |
| Mensagem duplicada | Webhook retry (200 não enviado a tempo) | Garanta `res.sendStatus(200)` imediato |
