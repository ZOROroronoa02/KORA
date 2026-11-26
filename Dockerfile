FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS prisma-generator
COPY . .
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/kora?schema=public
RUN npx prisma generate

FROM prisma-generator AS builder
ARG NEXT_PUBLIC_REALTIME_URL
ARG NEXT_PUBLIC_ASSET_ORIGIN=
ENV NEXT_PUBLIC_REALTIME_URL=${NEXT_PUBLIC_REALTIME_URL}
ENV NEXT_PUBLIC_ASSET_ORIGIN=${NEXT_PUBLIC_ASSET_ORIGIN}
RUN node -e "if (!process.env.NEXT_PUBLIC_REALTIME_URL) throw new Error('NEXT_PUBLIC_REALTIME_URL is required at build time')"
RUN npm run build

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS web
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.js"]

FROM prod-deps AS realtime
ENV NODE_ENV=production REALTIME_PORT=4000
COPY --from=prisma-generator --chown=node:node /app/node_modules/.prisma/client ./node_modules/.prisma/client
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node apps/realtime ./apps/realtime
COPY --chown=node:node src/lib ./src/lib
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/health/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["npm", "run", "realtime:start"]

FROM deps AS migrator
COPY prisma ./prisma
COPY prisma.config.ts ./
USER node
CMD ["npm", "run", "db:migrate:deploy"]
