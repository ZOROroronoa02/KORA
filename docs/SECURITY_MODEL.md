# KORA Security Model

## Identity and authorization

Access tokens are short-lived and signed with a server-only secret; refresh tokens are random, stored as hashes and rotated. Every request rechecks active user state and outlet role permissions. Tenant/outlet scope must be derived server-side; IDs supplied by a client are selectors only and are verified against that scope.

## Data protections

TLS termination and PostgreSQL/S3 encryption at rest are deployment requirements and must be verified in the target cloud. The web/realtime `DATABASE_URL` must use a non-owner runtime role; only the deploy job gets `MIGRATION_DATABASE_URL` with DDL access. Do not store cardholder data. Customer phone/email are PII; mask them in list responses and limit retention/access by permission. Browser local storage is not a protected vault.

Tenant and outlet ownership is enforced twice: protected API handlers establish request-local Prisma scope, and PostgreSQL `BEFORE INSERT OR UPDATE` triggers validate ownership across related rows. The database guard covers staff-role assignments, customer/outlet links, menu ownership, orders and nested items, KOTs, bills and payments, shifts, inventory, purchases, sync records, feedback, loyalty, and audit actors. It also prevents updates from moving records between tenant/outlet owners while allowing nullable relations to be cleared by `ON DELETE SET NULL`.

The trigger migration is `prisma/migrations/20261127130000_tenant_ownership_guards`. To reverse it, run `DROP FUNCTION public.kora_assert_tenant_ownership() CASCADE;` after confirming no application version still relies on these guards. `npm run db:audit-tenant-ownership` is a read-only scan for pre-existing mismatches. Integration tests exercise direct Prisma cross-tenant relation writes and nested order-item creation.

## Financial control

Prices, taxes and payments use integer paise. Order, KOT, payment, shift, inventory and audit events are transactional. Successful payment rows are immutable, but refund/reversal ledger records and the refund workflow are not implemented yet; paid-order cancellation remains blocked. Discounts, voids and corrections require granular permission and, where configured, a separate approver.

## Abuse prevention

Validate request schemas and sizes, rate-limit using a trusted proxy identity, verify webhook signatures on raw bodies, protect refresh-cookie routes against CSRF, and log request IDs without credentials or full payment/PII payloads. Redis must be shared in multi-process production.

## Current limitations

Prisma query extensions do not intercept nested writes; PostgreSQL guards now cover ownership links, but new relations must be added to the trigger and its adversarial tests when the schema changes. The local development database uses a privileged account; the non-owner runtime role separation has not yet been exercised in staging. Production still requires verified TLS termination, PostgreSQL/S3 encryption, a trusted-edge HMAC header implementation, shared Redis, backup/restore drills, and a deployment security review.
