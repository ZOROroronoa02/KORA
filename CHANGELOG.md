# Changelog

## 2026-11-27

- Added a read-only tenant/outlet ownership audit command and separated migration credentials from runtime database credentials.
- Added standalone web output, production Docker targets for web/realtime/migrations, and GitHub Actions verification.
- Required Redis for production realtime fan-out and added realtime dependency readiness checks.
- Changed GST and service-charge rounding to exact `BigInt` basis-point arithmetic.
- Added per-outlet Indian financial-year invoice numbering, continuing from existing invoices in the active financial year.
- Added tenant-scoped append-only payment and refund ledgers, idempotent partial refunds, net bill status, paid-order void gating, and cash refund reconciliation.
- Added tenant predicates to raw SQL row locks and financial-year invoice scans; cash refunds now fail if the cashier shift closes before its row lock is acquired.
- Normalized Prisma serialization/deadlock failures from raw SQL locks into retryable 409 conflicts instead of internal-server errors.
- Made the Orders “New order” action open POS only for roles with `orders.create`, and changed the production start command to launch the configured standalone server.
- Tightened the mobile POS top bar so sync, role, and connect controls fit without hiding the sync label from assistive technology.
- Verified seven local migrations, the production Next.js build, the live suite (50 passed, 0 failed; realtime integration skipped because local Redis is unavailable), and production dependency audit (0 advisories).
- Production Docker targets and the GitHub Actions workflow still need execution in a clean Linux/GitHub environment.
