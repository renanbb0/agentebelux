# 🚀 Guia de Implantação VPS — Bela Belux

Este guia contém os passos finais para colocar a Bela Belux online na sua nova VPS.

## 📋 Pré-requisitos
- Uma VPS com **Ubuntu** (recomendado).
- Um **domínio ou subdomínio** apontando para o IP da VPS (Registro tipo `A`).
- Acesso SSH ao servidor.

---

## 🛠️ Passo 1: Preparar a VPS
No seu terminal local, copie a pasta do projeto para a VPS:
```bash
scp -r . root@seu_ip_vps:~/bela-belux
```

Acesse a VPS via SSH:
```bash
ssh root@seu_ip_vps
cd ~/bela-belux
```

Execute o script de setup para instalar Docker e Nginx:
```bash
chmod +x .vps/setup.sh
./.vps/setup.sh
```

---

## ⚙️ Passo 2: Configurar o Domínio e SSL
1. Edite o arquivo `.vps/nginx.conf` e substitua `<DOMINIO_OU_SUBDOMINIO>` pelo seu endereço real.
2. Ative a configuração no Nginx:
```bash
cp .vps/nginx.conf /etc/nginx/sites-available/belux
ln -s /etc/nginx/sites-available/belux /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default # Remove o padrão se houver
nginx -t && systemctl restart nginx
```

3. **Gerar Certificado SSL (HTTPS):**
```bash
certbot --nginx -d seu_subdominio.com.br
```
Siga as instruções para ativar o redirecionamento automático para HTTPS.

---

## 🚀 Passo 3: Iniciar o Agente
Certifique-se de que o arquivo `.env` na VPS está preenchido corretamente.

```bash
docker compose up -d --build
```

---

## 🔗 Passo 4: Atualizar a Z-API
Agora que você tem uma URL fixa (ex: `https://api.belabelux.com.br`), você não precisa mais do Ngrok.

Execute o script de atualização de webhook (pode ser feito da sua máquina local se tiver o `.env` configurado):
```bash
node update_webhook.js
```
*Ou configure manualmente no painel da Z-API.*

---

## 📊 Comandos Úteis na VPS
- **Ver logs:** `docker logs -f belux-agent`
- **Reiniciar:** `docker compose restart`
- **Parar:** `docker compose down`
- **Status do Nginx:** `systemctl status nginx`

---

> [!TIP]
> **Backup:** Como o banco de dados (Supabase) é externo, você não precisa se preocupar com backups de banco na VPS, apenas com os logs e o código.
