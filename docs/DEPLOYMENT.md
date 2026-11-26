# KORA Deployment

## Local development

Copy `.env.example` to `.env`, set `JWT_ACCESS_SECRET` to a fresh 32-byte base64url key and set `KORA_APP_ORIGIN` to the canonical browser origin, start PostgreSQL and Redis with Docker Compose, generate Prisma Client, apply migrations, and seed development data. Refresh tokens are opaque random tokens stored as hashes. Run Next.js and the realtime process separately.

## Production target

Required components: Next.js web/API runtime, PostgreSQL with automated encrypted backups, Redis for shared rate limiting/realtime fan-out, secret manager, TLS, and an independently monitored realtime/worker process. Configure `KORA_REALTIME_ORIGINS` to exact HTTPS production web origins, `NEXT_PUBLIC_REALTIME_URL` to the deployed realtime endpoint, and `NEXT_PUBLIC_ASSET_ORIGIN` to the exact HTTPS image origin when menu images use object storage. Set `KORA_PROXY_SHARED_SECRET` in the app and trusted edge; the edge must strip inbound `x-kora-client-ip*` headers, set the client IP in `x-kora-client-ip`, and set `x-kora-client-ip-signature` to lowercase or uppercase hex HMAC-SHA256(secret, exact IP string). Production login and registration fail closed with 503 until this proxy contract and Redis are configured.

Use separate database credentials. `DATABASE_URL` is the web/realtime runtime role: it needs DML access to application tables and sequence usage, but must not own tables, be a member of the migration role, or have schema/trigger DDL privileges. `MIGRATION_DATABASE_URL` is deploy-only and belongs to the schema owner. `prisma.config.ts` uses it for migration commands and falls back to `DATABASE_URL` only for local development. This separation prevents the app process from disabling tenant ownership triggers.

The root `Dockerfile` has `web`, `realtime`, and `migrator` targets. Build the web image with the deployed public realtime endpoint because `NEXT_PUBLIC_*` values are embedded into browser assets at build time:

```sh
docker build --target web --build-arg NEXT_PUBLIC_REALTIME_URL=https://realtime.example.com -t kora-web:release .
docker build --target realtime -t kora-realtime:release .
docker build --target migrator -t kora-migrator:release .
```

Inject server secrets only when running the containers. Run the migrator as a one-shot release job with `MIGRATION_DATABASE_URL`; run web and realtime with the restricted `DATABASE_URL`. Put a TLS reverse proxy in front of the web container, configure the trusted-edge HMAC contract there, and do not publish PostgreSQL/Redis ports publicly.

Example grants (replace role/database names and inject the password through your secret manager):

```sql
CREATE ROLE kora_runtime LOGIN PASSWORD '<managed-secret>';
GRANT CONNECT ON DATABASE kora TO kora_runtime;
GRANT USAGE ON SCHEMA public TO kora_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kora_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kora_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE kora_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kora_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE kora_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kora_runtime;
```

## Release sequence

1. On an existing database at the current schema version, run `npm run db:audit-tenant-ownership`; resolve every reported mismatch before applying the ownership-guard migration. On a new empty database, apply migrations first and then run the audit.
2. Back up PostgreSQL and verify restore in the release environment.
3. Build and run typecheck/lint/unit/integration/E2E/security checks.
4. Run `npm run db:backfill-customer-permissions` once before deploying this release so existing system Owner and Manager roles retain authorized customer access.
5. Apply reviewed migrations with `MIGRATION_DATABASE_URL` set to the deploy-only role: `npm run db:migrate:deploy`.
6. For the invoice financial-year sequence migration, briefly quiesce order creation while deploying: stop old app writers, apply the migration, then deploy the new code before accepting orders again. This prevents old and new invoice-number formats from allocating concurrently. Existing invoices are retained and the first new financial-year sequence continues from the highest existing numeric suffix for that year.
7. Deploy application code and background workers using only the restricted `DATABASE_URL` runtime credential.
8. Check `/api/health/live`, `/api/health/ready`, `/health/live`, and `/health/ready`, then run a smoke order in staging. Realtime readiness requires a live PostgreSQL connection and connected Redis publisher/subscriber.
9. Monitor error rate, DB connections, sync backlog, Redis and order latency.
10. Roll back application code first when compatible; use forward migrations for data changes. Restore a backup only through a tested incident procedure.

## Current limitations

CI and Docker image targets are defined in the repository. There is no production deployment manifest, observability provider or tested backup/restore procedure. CI verifies migrations, build, live PostgreSQL/Redis tests, and that the runtime role cannot disable a tenant trigger; the target cloud role split, trusted-edge contract, TLS, backups, and deployment rollback still require staging verification.
