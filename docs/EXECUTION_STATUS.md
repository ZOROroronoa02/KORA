# KORA implementation status

Updated: 2026-11-27. This records locally verified work; it is not a production-readiness claim.

## Verified implementation

- Next.js App Router app, PostgreSQL/Prisma schema and migrations, Socket.IO realtime service, RBAC, online POS flows, and IndexedDB order outbox are present.
- Tenant/outlet query scope wraps protected API routes. PostgreSQL triggers validate tenant/outlet ownership for related writes and block ownership-key reassignment.
- `npm run db:audit-tenant-ownership` is a read-only historical-data scan. It reported zero mismatches in the current local database.
- Runtime and migration database URLs are separated in Prisma CLI configuration. CI provisions a non-owner runtime role and verifies it cannot disable tenant triggers.
- GitHub Actions CI and production Docker targets for web, realtime, and one-shot migrations are configured.
- Billing amounts use integer paise. Server-side payment recording rejects amounts above the unpaid bill balance.
- Captured payments and `PaymentReversal` rows are append-only at the database layer. Refunds are outlet-scoped, permission-gated, idempotent, bounded by captured amounts, included in bill net status and cash shift reconciliation, and audited with a reason.
- Fully refunded orders can be voided; partially refunded/paid orders remain protected. The Orders detail shows payment/refund history and a refund form for authorized managers. KORA records reversals; it does not transfer money through a gateway.
- Prisma `P2034` and raw SQL `40001`/`40P01` transaction conflicts now map to retryable 409 responses, including refund races.
- Raw SQL row locks and invoice-sequence scans include tenant and outlet predicates. Cash refunds also require the same shift row to remain open when its lock is acquired.
- GST and service-charge rates now use `BigInt` basis-point arithmetic; a near-safe-integer regression test proves exact paise rounding.
- GST now includes service charge in the taxable base, apportioned to lines by their taxable values and calculated at each line's GST rate. Unit tests and a cloud order-to-invoice integration assertion cover the result. CBIC's FAQ identifies restaurant service charge as liable to GST; the live profile/rate setup still needs accountant confirmation.
- Realtime production startup now fails closed without Redis; `/health/ready` checks PostgreSQL and Redis while `/health/live` stays independent for liveness probes.
- Invoice numbers now use `prefix-FYyyyy-yy-sequence`, allocated under the serializable order transaction. On first use in a financial year, the allocator continues from the highest existing invoice suffix issued within that year.
- SQL migration history includes `20261127153000_invoice_financial_year_sequence` after the tenant ownership guard migration.
- Production start now launches `.next/standalone/server.js`, matching `output: "standalone"`. The locally built production server starts without the `next start` configuration warning.
- Local preview is available at `http://localhost:3000`; `/` and `/api/health/live` returned 200. `/api/health/ready` returned 503 because local Redis is unavailable, as production readiness requires Redis.

## Latest verification

- `npx prisma generate` and `npm run lint` (TypeScript check): passed after a clean `npm ci`.
- `npx prisma validate`: passed on the current schema.
- `npx prisma migrate status`: all seven migrations applied locally.
- `npm run build`: passed on the production configuration; all App Router routes, including the refund route, compiled.
- `npm test` against the local PostgreSQL-backed development API: 51 passed, 0 failed, 1 skipped (52 tests total). Cloud POS, KDS, RBAC, tenant isolation, billing/refund, and cash reconciliation integration suites passed; Socket.IO revocation integration skipped because local Redis is unavailable.
- `npm audit --omit=dev --audit-level=high`: zero production dependency advisories. `npm run db:audit-tenant-ownership`: zero local mismatches.
- Rendered desktop demo check: Cashier “New order” opens POS; Masala Dosa at ₹180 calculated ₹9 GST and ₹189 due; a demo UPI payment appeared in Orders as paid. The cloud API integration now verifies GST on service charge and invoice total reconciliation. This did not exercise cloud refund UI or physical printing. A prior dev session showed a transient `unhandledRejection: undefined`; its cause remains unverified.
- Git commits for the current security work: `c75eb1d`, `90d9842`, `a9abe8b`.

## Production blockers

1. Production data has not yet been scanned with `npm run db:audit-tenant-ownership`; the local zero-mismatch result does not say anything about customer production data.
2. CI and production container targets exist, but the workflow has not yet run on GitHub and no production deployment manifest exists. Runtime and migration role separation still needs staging verification. Docker was unavailable on the local host.
3. Backups, restore, rollback, observability, TLS, trusted-edge HMAC, and production Redis behavior need staging verification.
4. Cloud UI coverage is partial. Refund recording is implemented but does not initiate provider transfers; split-bill settlement, full menu variants/add-ons, and several admin workflows remain incomplete. The cloud refund UI path still needs browser verification.
5. Offline cloud mode queues order creation only. Payment, KOT, conflict recovery, and printer queues are not fully offline-first or validated through browser restart/quota failures.
6. Inventory/recipes/purchasing, reporting/GST exports, subscription plan gating, aggregator operations, and owner multi-outlet analytics are incomplete.
7. Full browser/accessibility/device QA and physical ESC/POS printer testing remain outstanding; the local demo POS flow was only smoke-tested on desktop Chrome.
8. Tax prices are intended to be exclusive and multiple GST profiles are required, but the profile model and regime-specific rules are not implemented.

## Next engineering order

1. Run the historical ownership scan on a production-like data clone and verify the restricted runtime PostgreSQL role.
2. Run the GitHub CI workflow and build all three Docker targets in a clean Linux environment.
3. Finish tax-profile rules and document the accounting assumptions before changing invoice calculations.
4. Close POS settlement/refund and offline recovery gaps, then continue operations/reporting modules.
5. Complete staging, browser/accessibility, printer, load, backup/restore and incident rollback acceptance.

KORA remains in active development and must not be represented as production-ready until these blockers are completed and verified in the target deployment environment.
