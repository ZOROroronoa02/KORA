# KORA implementation status

Updated: 2026-11-27. This records locally verified work; it is not a production-readiness claim.

## Verified implementation

- Next.js App Router app, PostgreSQL/Prisma schema and migrations, Socket.IO realtime service, RBAC, online POS flows, and IndexedDB order outbox are present.
- Tenant/outlet query scope wraps protected API routes. PostgreSQL triggers validate tenant/outlet ownership for related writes and block ownership-key reassignment.
- `npm run db:audit-tenant-ownership` is a read-only historical-data scan. It reported zero mismatches in the current local database.
- Runtime and migration database URLs are separated in Prisma CLI configuration. CI provisions a non-owner runtime role and verifies it cannot disable tenant triggers.
- GitHub Actions CI and production Docker targets for web, realtime, and one-shot migrations are configured.
- Billing amounts use integer paise. Server-side payment recording rejects amounts above the unpaid bill balance.
- GST and service-charge rates now use `BigInt` basis-point arithmetic; a near-safe-integer regression test proves exact paise rounding.
- Realtime production startup now fails closed without Redis; `/health/ready` checks PostgreSQL and Redis while `/health/live` stays independent for liveness probes.
- Invoice numbers now use `prefix-FYyyyy-yy-sequence`, allocated under the serializable order transaction. On first use in a financial year, the allocator continues from the highest existing invoice suffix issued within that year.
- SQL migration history includes `20261127153000_invoice_financial_year_sequence` after the tenant ownership guard migration.
- Local preview is available at `http://localhost:3000`; `/api/health/live` returned 200.

## Latest verification

- `npm run typecheck`: passed after the money and realtime readiness changes.
- `npx prisma validate`: passed.
- `npx prisma migrate status`: all five migrations applied locally.
- `npm run build`: passed after the current schema and API updates.
- Full live unit/API/PostgreSQL/realtime suite: 48 passed, 0 failed, 0 skipped. The direct tenant-ownership suite also passed against the final migration.
- Production realtime startup test: missing Redis causes the process to fail closed. The local dev server reports liveness and readiness healthy with PostgreSQL; Redis is optional in local single-instance mode.
- Rendered 390px check: the top-bar controls now fit; a cashier can add a menu item and sees ₹180 + ₹9 GST = ₹189. Cart settlement is below the menu and requires a scroll. A Next.js dev overlay reported one `unhandledRejection: undefined` once, cleared after reload, and did not recur; its cause remains unverified.
- Git commits for the current security work: `c75eb1d`, `90d9842`, `a9abe8b`.

## Production blockers

1. Production data has not yet been scanned with `npm run db:audit-tenant-ownership`; the local zero-mismatch result does not say anything about customer production data.
2. CI and production container targets exist, but the workflow has not yet run on GitHub and no production deployment manifest exists. Runtime and migration role separation still needs staging verification. Docker was unavailable on the local host.
3. Backups, restore, rollback, observability, TLS, trusted-edge HMAC, and production Redis behavior need staging verification.
4. Cloud UI coverage is partial. POS actions such as refunds/reversals, split-bill settlement, full menu variants/add-ons, and several admin workflows remain incomplete.
5. Offline cloud mode queues order creation only. Payment, KOT, conflict recovery, and printer queues are not fully offline-first or validated through browser restart/quota failures.
6. Inventory/recipes/purchasing, reporting/GST exports, subscription plan gating, aggregator operations, and owner multi-outlet analytics are incomplete.
7. Rendered browser/accessibility/device QA and physical ESC/POS printer testing remain outstanding.
8. Tax prices are intended to be exclusive and multiple GST profiles are required, but the profile model and regime-specific rules are not implemented.

## Next engineering order

1. Run the historical ownership scan on a production-like data clone and verify the restricted runtime PostgreSQL role.
2. Run the GitHub CI workflow and build all three Docker targets in a clean Linux environment.
3. Finish tax-profile rules and document the accounting assumptions before changing invoice calculations.
4. Close POS settlement/refund and offline recovery gaps, then continue operations/reporting modules.
5. Complete staging, browser/accessibility, printer, load, backup/restore and incident rollback acceptance.

KORA remains in active development and must not be represented as production-ready until these blockers are completed and verified in the target deployment environment.
