# KORA Security Model

## Identity and authorization

Access tokens are short-lived and signed with a server-only secret; refresh tokens are random, stored as hashes and rotated. Every request rechecks active user state and outlet role permissions. Tenant/outlet scope must be derived server-side; IDs supplied by a client are selectors only and are verified against that scope.

## Data protections

TLS termination and PostgreSQL/S3 encryption at rest are deployment requirements and must be verified in the target cloud. Do not store cardholder data. Customer phone/email are PII; mask them in list responses and limit retention/access by permission. Browser local storage is not a protected vault.

Tenant and outlet ownership is enforced twice: protected API handlers establish request-local Prisma scope, and PostgreSQL `BEFORE INSERT OR UPDATE` triggers validate ownership across related rows. The database guard covers staff-role assignments, customer/outlet links, menu ownership, orders and nested items, KOTs, bills and payments, shifts, inventory, purchases, sync records, feedback, loyalty, and audit actors. It also prevents updates from moving records between tenant/outlet owners while allowing nullable relations to be cleared by `ON DELETE SET NULL`.

The trigger migration is `prisma/migrations/20261127130000_tenant_ownership_guards`. To reverse it, run `DROP FUNCTION public.kora_assert_tenant_ownership() CASCADE;` after confirming no application version still relies on these guards. Integration tests exercise direct Prisma cross-tenant relation writes and nested order-item creation.

## Financial control

Prices/taxes/payments use integer paise. Order, KOT, payment, shift, inventory and audit events are transactional. Successful payments are immutable; refunds/reversals create new linked ledger records. Discounts, voids, refunds and corrections require granular permission and, where configured, a separate approver.

## Abuse prevention

Validate request schemas and sizes, rate-limit using a trusted proxy identity, verify webhook signatures on raw bodies, protect refresh-cookie routes against CSRF, and log request IDs without credentials or full payment/PII payloads. Redis must be shared in multi-process production.

## Current limitations

The web client is still a local demo and is not yet connected to authenticated APIs. Prisma query extensions do not intercept nested writes; PostgreSQL guards now cover ownership links, but new relations must be added to the trigger and its adversarial tests when the schema changes. Production still requires verified TLS termination, PostgreSQL/S3 encryption, a trusted-edge HMAC header implementation, shared Redis, and a deployment security review.
