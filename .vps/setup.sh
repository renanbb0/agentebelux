#!/bin/bash

# setup.sh - Instalação de Docker, Nginx, Certbot e UFW na VPS
# Uso: chmod +x setup.sh && ./setup.sh

echo "🚀 Iniciando configuração da VPS para Bela Belux..."

# 1. Atualizar o sistema
echo "📦 Atualizando pacotes..."
sudo apt update && sudo apt upgrade -y

# 2. Instalar Docker e Docker Compose
echo "🐳 Instalando Docker..."
sudo apt install -y ca-certificates curl gnupg lsb-release
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# 3. Instalar Nginx e Certbot
echo "🌐 Instalando Nginx e Certbot..."
sudo apt install -y nginx certbot python3-certbot-nginx

# 4. Configurar Firewall (UFW)
echo "🛡️ Configurando Firewall..."
sudo ufw allow ssh
sudo ufw allow http
sudo ufw allow https
sudo ufw --force enable

# 5. Criar diretórios do projeto
echo "📁 Criando estruturas de diretórios..."
mkdir -p ~/bela-belux

echo "✅ Ambiente base configurado com sucesso!"
echo "⚠️ Próximos passos: Copiar arquivos do projeto e rodar docker-compose."
