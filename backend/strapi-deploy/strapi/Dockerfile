# Strapi 5 production Dockerfile (multi-stage, Node 20 LTS on Alpine)
FROM node:20-alpine AS builder
WORKDIR /opt/app

# Build deps for native modules (sharp, better-sqlite3 fallback, bcrypt)
RUN apk add --no-cache --virtual .build-deps \
    build-base \
    python3 \
    gcc \
    autoconf \
    automake \
    libtool \
    zlib-dev \
    libpng-dev \
    vips-dev \
    git

COPY package.json yarn.lock* package-lock.json* ./
# Prefer yarn if lockfile exists, else npm
RUN if [ -f yarn.lock ]; then \
      corepack enable && yarn install --frozen-lockfile; \
    else \
      npm install --legacy-peer-deps; \
    fi

COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY public ./public

ENV NODE_ENV=production
RUN npm run build && \
    mkdir -p database/migrations public/uploads .tmp

# ---------- runtime ----------
FROM node:20-alpine
RUN apk add --no-cache vips tini tzdata
WORKDIR /opt/app

COPY --from=builder --chown=node:node /opt/app ./

USER node
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=1337

EXPOSE 1337
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "start"]
