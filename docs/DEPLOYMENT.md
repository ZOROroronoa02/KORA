# KORA Deployment

## Local development

Copy `.env.example` to `.env`, replace `JWT_ACCESS_SECRET` with a random value of at least 32 characters, start PostgreSQL and Redis with Docker Compose, generate Prisma Client, apply migrations, and seed development data. Refresh tokens are opaque random tokens stored as hashes. Run Next.js and the realtime process separately.

## Production target

Required components: Next.js web/API runtime, PostgreSQL with automated encrypted backups, Redis for shared rate limiting/realtime fan-out, secret manager, TLS, and an independently monitored realtime/worker process. Configure `KORA_REALTIME_ORIGINS` to exact production origins and `NEXT_PUBLIC_REALTIME_URL` to the deployed socket endpoint.

## Release sequence

1. Build and run typecheck/lint/unit/integration/E2E/security checks.
2. Apply reviewed backward-compatible migrations with `prisma migrate deploy`.
3. Deploy application code and background workers.
4. Check liveness/readiness and a smoke order in staging.
5. Monitor error rate, DB connections, sync backlog, Redis and order latency.
6. Roll back application code first when compatible; use forward migrations for data changes. Restore a backup only through a tested incident procedure.

## Current limitations

There is no Dockerfile, CI pipeline, committed migration, production deployment manifest, observability provider or tested backup/restore procedure. Docker is unavailable in the current engineering environment, so database launch verification is blocked.
