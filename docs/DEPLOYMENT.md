# KORA Deployment

## Local development

Copy `.env.example` to `.env`, set `JWT_ACCESS_SECRET` to a fresh 32-byte base64url key and set `KORA_APP_ORIGIN` to the canonical browser origin, start PostgreSQL and Redis with Docker Compose, generate Prisma Client, apply migrations, and seed development data. Refresh tokens are opaque random tokens stored as hashes. Run Next.js and the realtime process separately.

## Production target

Required components: Next.js web/API runtime, PostgreSQL with automated encrypted backups, Redis for shared rate limiting/realtime fan-out, secret manager, TLS, and an independently monitored realtime/worker process. Configure `KORA_REALTIME_ORIGINS` to exact HTTPS production web origins, `NEXT_PUBLIC_REALTIME_URL` to the deployed realtime endpoint, and `NEXT_PUBLIC_ASSET_ORIGIN` to the exact HTTPS image origin when menu images use object storage. Set `KORA_PROXY_SHARED_SECRET` in the app and trusted edge; the edge must strip inbound `x-kora-client-ip*` headers, set the client IP in `x-kora-client-ip`, and set `x-kora-client-ip-signature` to lowercase or uppercase hex HMAC-SHA256(secret, exact IP string). Production login and registration fail closed with 503 until this proxy contract and Redis are configured.

## Release sequence

1. Build and run typecheck/lint/unit/integration/E2E/security checks.
2. Apply reviewed backward-compatible migrations with `prisma migrate deploy`.
3. Run `npm run db:backfill-customer-permissions` once before deploying this release so existing system Owner and Manager roles retain authorized customer access.
4. Deploy application code and background workers.
5. Check liveness/readiness and a smoke order in staging.
6. Monitor error rate, DB connections, sync backlog, Redis and order latency.
7. Roll back application code first when compatible; use forward migrations for data changes. Restore a backup only through a tested incident procedure.

## Current limitations

There is no Dockerfile, CI pipeline, committed migration, production deployment manifest, observability provider or tested backup/restore procedure. Docker is unavailable in the current engineering environment, so database launch verification is blocked.
