# Migração: Evolution API → Z-API

**Data:** 2026-03-25  
**Motivo:** A Evolution API self-hosted (Docker) apresentava problemas crônicos de geração de QR Code no ambiente Windows/WSL2. A Z-API é um serviço SaaS gerenciado que elimina a necessidade de infraestrutura local.

---

## O que mudou

### Arquivos Criados
| Arquivo | Descrição |
|---|---|
| `services/zapi.js` | Novo adapter com todas as funções de envio de mensagem via Z-API |

### Arquivos Modificados
| Arquivo | Mudança |
|---|---|
| `index.js` | Webhook reescrito para formato Z-API. Import `evolution` → `zapi`. Responde 200 imediatamente |
| `.env` | Credenciais Evolution removidas, credenciais Z-API adicionadas |
| `package.json` | Description atualizada |

### Arquivos Removidos
| Arquivo | Motivo |
|---|---|
| `services/evolution.js` | Substituído por `services/zapi.js` |
| `docker-compose.yml` | Evolution API Docker não é mais necessário |
| `evolution.env` | Configuração Docker removida |
| `get-qrcode.js` | Script de QR Code Evolution removido |
| `get-qrcode-v2.js` | Script de QR Code Evolution removido |
| `create-instance.js` | Gerenciamento de instância é feito pelo painel Z-API |
| `aprender.md` | Documentação Evolution removida |
| `evo.log` | Log de debug Evolution removido |

---

## Mapeamento de Endpoints

| Função | Evolution API | Z-API |
|---|---|---|
| Enviar texto | `POST /message/sendText/:instance` | `POST /send-text` |
| Enviar imagem | `POST /message/sendMedia/:instance` | `POST /send-image` |
| Enviar botões | `POST /message/sendButtons/:instance` | `POST /send-button-list` |
| Enviar lista | `POST /message/sendList/:instance` | `POST /send-option-list` |

## Mapeamento de Payloads

### Texto
```diff
-{ "number": "5511999...", "text": "..." }
+{ "phone": "5511999...", "message": "..." }
```

### Imagem
```diff
-{ "number": "...", "mediatype": "image", "media": "url", "caption": "..." }
+{ "phone": "...", "image": "url", "caption": "..." }
```

### Webhook Recebido
```diff
-body.data.key.remoteJid     → body.phone
-body.data.message.conversation → body.text.message
-body.data.key.fromMe        → body.fromMe
+Campos Z-API: phone, text.message, fromMe, buttonPayload, listResponsePayload
```

---

## Variáveis de Ambiente

```diff
-EVOLUTION_API_URL=...
-EVOLUTION_API_KEY=...
-EVOLUTION_INSTANCE_NAME=...
+ZAPI_INSTANCE_ID=sua_instancia
+ZAPI_TOKEN=seu_token
+ZAPI_CLIENT_TOKEN=seu_client_token
```

---

## Configuração Pós-Migração

1. Acesse o painel Z-API e crie/conecte sua instância
2. Copie `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN` e `ZAPI_CLIENT_TOKEN` para o `.env`
3. Configure o Webhook no painel Z-API apontando para `https://SEU_DOMINIO/webhook`
4. Rode `npm run dev` para iniciar o servidor
