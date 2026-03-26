FROM node:20-slim

WORKDIR /app

# Instala dependências primeiro para aproveitar o cache do Docker
COPY package*.json ./
RUN npm install --production

# Copia o restante dos arquivos (exceto os do .dockerignore)
COPY . .

# Expõe a porta do servidor
EXPOSE 3000

# Comando para rodar o bot
CMD ["node", "index.js"]
