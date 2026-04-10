# 🚀 Guia de Startup — Agente Belux

**Objetivo:** Iniciar os servidores Node.js e Ngrok para que o Agente Belux receba mensagens da Z-API.

---

## 📋 Pré-requisitos

- **Node.js** instalado (v18+)
- **Ngrok** instalado e acessível via CLI
- **`.env`** configurado no diretório raiz do projeto
- **Porta 3000** livre (sem outros processos Node rodando)

---

## 🛑 Passo 1: Parar Servidores Anteriores

Se houver instâncias antigas rodando, mate-as primeiro:

```powershell
Stop-Process -Name node -Force -ErrorAction SilentlyContinue
Stop-Process -Name ngrok -Force -ErrorAction SilentlyContinue
```

**Verificação:**
```bash
netstat -ano | grep :3000
```
Se não retornar nada, a porta está livre.

---

## 🟢 Passo 2: Iniciar o Servidor Node.js

1. Abra um terminal PowerShell ou Bash
2. Navegue até o diretório do projeto:
```bash
cd "d:/Projetos Antigravity/Bela Belux"
```

3. Inicie o servidor:
```bash
node index.js &
```

O `&` executa em background. Você verá:
```
[dotenv@17.3.1] injecting env (16) from .env
[HH:MM:SS.sss] [32mINFO[39m (XXXX): [36m🚀 Agente Belux running[39m
    port: "3000"
```

**Verificação da porta:**
```bash
netstat -ano | grep :3000
```
Deve retornar algo como:
```
TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       XXXX
```

---

## 🌐 Passo 3: Iniciar o Ngrok

O Ngrok cria um túnel HTTPS público que aponta para `localhost:3000`.

1. Aguarde 2 segundos após iniciar o Node (garante que a porta está pronta):
```powershell
Start-Sleep -Seconds 2
```

2. Inicie o Ngrok em background:
```powershell
Start-Process 'C:\Users\renan\AppData\Local\Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe' -ArgumentList 'http 3000' -WindowStyle Hidden
```

3. Aguarde o Ngrok inicializar (~5 segundos):
```powershell
Start-Sleep -Seconds 5
```

---

## 📍 Passo 4: Obter a URL do Webhook

Execute este comando para recuperar a URL pública gerada pelo Ngrok:

```powershell
(Invoke-RestMethod -Uri 'http://localhost:4040/api/tunnels').tunnels.public_url
```

Você receberá uma URL como:
```
https://daisy-nonlive-delorse.ngrok-free.dev
```

---

## ✅ Passo 5: Atualizar a Z-API

1. Acesse o painel da **Z-API**
2. Localize a seção **Webhooks** ou **Configurações**
3. Configure a URL do webhook como:
```
https://daisy-nonlive-delorse.ngrok-free.dev/webhook
```
(Substitua o domínio pela URL obtida no Passo 4)

4. Salve e teste a conexão

---

## 🔍 Verificação Rápida

### Servidor Node está rodando?
```bash
netstat -ano | grep :3000
```
Deve retornar uma linha com `LISTENING`.

### Ngrok está funcionando?
```powershell
Invoke-RestMethod -Uri 'http://localhost:4040/api/tunnels'
```
Deve retornar um JSON com as tunelagens ativas.

### Servidor responde?
```bash
curl http://localhost:3000/
```
Deve retornar:
```json
{"status":"online","activeSessions":0}
```

### Túnel público funciona?
```bash
curl https://daisy-nonlive-delorse.ngrok-free.dev/
```
Mesmo resultado acima (substituir URL pela atual).

---

## 🆘 Troubleshooting

| Problema | Causa | Solução |
|----------|-------|---------|
| `EADDRINUSE :3000` | Porta ocupada | `Stop-Process -Name node -Force` |
| Node carrega mas não responde | `.env` inválido ou erro no código | Verifique os logs: `node index.js` (foreground) |
| Ngrok não abre | Caminho incorreto ou não instalado | Use `ngrok --version` para verificar |
| Webhook não recebe eventos | URL não configurada na Z-API | Verifique se `/webhook` está no final da URL |
| Bela não responde às mensagens | Erro no webhook | Verifique os logs do Node para `[Webhook] Error` |

---

## 📝 One-Liner Completo

Se preferir fazer tudo em um comando (PowerShell):

```powershell
Stop-Process -Name node -Force -ErrorAction SilentlyContinue; `
Stop-Process -Name ngrok -Force -ErrorAction SilentlyContinue; `
cd "d:/Projetos Antigravity/Bela Belux"; `
node index.js & `
Start-Sleep -Seconds 2; `
Start-Process 'C:\Users\renan\AppData\Local\Microsoft\WinGet\Packages\Ngrok.Ngrok_Microsoft.Winget.Source_8wekyb3d8bbwe\ngrok.exe' -ArgumentList 'http 3000' -WindowStyle Hidden; `
Start-Sleep -Seconds 5; `
(Invoke-RestMethod -Uri 'http://localhost:4040/api/tunnels').tunnels.public_url
```

---

## 📚 Notas

- O Ngrok gera um novo domínio a cada reinicialização (no plano gratuito)
- A URL deve estar sempre configurada na Z-API antes de testar
- Mantenha ambos os processos rodando: Node (backend) + Ngrok (túnel)
- Se mudar código em `index.js`, reinicie o Node (Passo 2)
- O Ngrok não precisa reiniciar se o Node reiniciar, desde que a porta 3000 permaneça livre

---

**Status:** ✅ Pronto para uso  
**Data:** 2026-04-07  
**Mantido por:** Claude Code
