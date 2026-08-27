# better-sqlite3 pode precisar compilar via node-gyp — as ferramentas de build
# ficam só no estágio de build, fora da imagem final.
FROM node:24-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Sessão do WhatsApp e banco: sem volume, o QR precisa ser reescaneado a cada restart.
VOLUME ["/app/data"]
ENV AUTH_DIR=/app/data/auth_info \
    DB_PATH=/app/data/app.db

EXPOSE 3000
CMD ["node", "dist/index.js"]
