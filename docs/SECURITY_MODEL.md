# KORA Security Model

## Identity and authorization

Access tokens are short-lived and signed with a server-only secret; refresh tokens are random, stored as hashes and rotated. Every request rechecks active user state and outlet role permissions. Tenant/outlet scope must be derived server-side; IDs supplied by a client are selectors only and are verified against that scope.

## Data protections

TLS termination and PostgreSQL/S3 encryption at rest are deployment requirements and must be verified in the target cloud. Do not store cardholder data. Customer phone/email are PII; mask them in list responses and limit retention/access by permission. Browser local storage is not a protected vault.

## Financial control

Prices/taxes/payments use integer paise. Order, KOT, payment, shift, inventory and audit events are transactional. Successful payments are immutable; refunds/reversals create new linked ledger records. Discounts, voids, refunds and corrections require granular permission and, where configured, a separate approver.

## Abuse prevention

Validate request schemas and sizes, rate-limit using a trusted proxy identity, verify webhook signatures on raw bodies, protect refresh-cookie routes against CSRF, and log request IDs without credentials or full payment/PII payloads. Redis must be shared in multi-process production.

## Current limitations

There is no production CSP/TLS/deployment configuration or security test suite. Rate limiting trusts `x-forwarded-for` directly. API ownership checks need strengthening for order customer/table references. The web client currently has no authenticated session flow.
