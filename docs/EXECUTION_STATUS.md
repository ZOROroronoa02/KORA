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
- Invoice numbers now use a compact `prefix-FYyymm-sequence` format such as `K-FY2627-000001`, allocated under the serializable order transaction and kept within GST's 16-character serial limit. On first use in a financial year, the allocator continues from the highest existing invoice suffix issued within that year.
- Cloud Settings now reads and updates the current outlet's name, GSTIN, FSSAI license, and address from PostgreSQL. The route enforces `settings.manage`, request-local tenant/outlet scoping, field validation, and an audit record with before/after values; the shared tenant business name is read-only.
- POS now treats a successful order API response as the committed sale even if the secondary order-list refresh fails, preventing the still-open cart from encouraging a second order. It inserts the accepted order immediately and surfaces refresh trouble in the sync status. IndexedDB queue-read failures now retain an explicit warning instead of setting the pending count to zero.
- Client logout now writes a pending-logout latch before attempting the network call. Offline startup checks that latch before restoring the cached outlet; new sign-in and restaurant registration flush the old logout first. Unit tests cover offline restore denial, storage denial, logout persistence, and logout-before-login ordering.
- Cloud inventory now supports outlet-scoped ingredient creation, integer-milli stock corrections, wastage, and a tenant-shared vendor directory. Mutations require `inventory.adjust`, write stock movements and audit snapshots transactionally, reject underflow and duplicate ingredient names, and use serializable transactions for concurrent changes. Vendor edits are tenant-scoped and audited. The purchase shortcut was removed because the vendor purchase ledger is not implemented yet.
- Recipe BOMs belong to an outlet/menu-item pair. Migrations safely backfill only unambiguous old recipes and abort on cross-outlet or ambiguous mappings; database triggers enforce menu and ingredient outlet ownership. The Inventory workspace supports audited recipe CRUD. Order creation and item additions now deduct recipe quantities atomically with order/KOT writes; outlet stock-shortage policy defaults to block and may explicitly allow audited negative stock. Sale movements snapshot recipe math so voids restore only explicitly queued/out-of-stock quantities using the original BOM, while cooking/ready/bumped and untracked lines remain consumed.
- Cloud sales reports now aggregate persisted bills, order-item lines, payment events, refund events, and stored GST buckets on the server. The date range is India-local and bounded to 93 days; outlet permission checks redact money and tax sections, and CSV export neutralizes spreadsheet formulas. See `docs/sales-reports.md`; it is a reconciliation report, not a GSTR-1 filing export.
- The approved Free/Plus/Pro numeric caps are centralized server-side (1/1, 1/10, and 10/50 outlets/active users). `POST /api/outlets` requires an owner, locks the tenant row for race-safe quota enforcement, creates fresh outlet state, copies the source menu/table layout, and audits creation. The user cap is not yet enforceable in a live path because there is no staff invitation/user creation API; subscription checkout and feature entitlements also remain absent. See `docs/plan-limits-and-outlets.md`.
- GST identity is now tenant-wide (one GSTIN shared by outlets) with `NOT_REGISTERED`, standard restaurant, specified premises, and composition profiles. New tenants default to no GST collection; registered profiles require a GSTIN and an invoice-ready outlet address/state match. Menu tax is inherited or explicitly overridden per item; bills snapshot document/profile/rate/supplier/service-charge data. Composition and unregistered profiles never add GST to the customer bill. See `docs/gst-profiles.md` for the legal assumptions and remaining invoice/return gaps.
- Tax-invoice menu lines now store HSN/SAC code snapshots, buyer GSTIN/address and place-of-supply snapshots. The outlet-scoped invoice API recomputes line totals from immutable snapshots before returning print data. POS includes browser print layouts for 58 mm and 80 mm receipt stock and displays the composition-person notice on Bills of Supply.
- Tax-invoiced packaged-goods deliveries require a destination address; cross-state deliveries are rejected until inter-state tax treatment is implemented. This prevents the current local CGST/SGST calculation from being used for a potential IGST supply.
- Inventory cloud UI now shows exact quantity/value formatting and offers ingredient creation, stock corrections, wastage, and vendor management to users with the matching permission. Contract and remaining inventory gaps are documented in `docs/inventory-stock-workflow.md`.
- SQL migration history includes `20261127153000_invoice_financial_year_sequence` after the tenant ownership guard migration.
- Production start launches `.next/standalone/server.js`, matching `output: "standalone"`. The build copies `.next/static` and `public` into the standalone runtime; this fixes missing CSS/JavaScript asset 404s that made the local production UI unstyled and noninteractive.
- `/api/health` now reports liveness and links to the liveness/readiness probes without falsely describing the cloud platform as a browser-local demo.
- Local preview is available at `http://localhost:3000`; `/` and `/api/health/live` returned 200. `/api/health/ready` returned 503 because local Redis is unavailable, as production readiness requires Redis.
- The current manual-testing preview runs Next.js development mode on port 3000 with the realtime development service on port 4000; the cloud POS order-to-invoice flow passed against this running preview. Production mode remains unready without Redis.

## Latest verification

- Current migrations: 13 found and applied; Prisma reports the schema up to date. `npx prisma format`, `npx prisma generate`, and typecheck passed after the stock ledger changes.
- Full PostgreSQL-backed API/domain/realtime suite: 77 passed, 0 failed, 0 skipped. This run set both security test URLs and used local PostgreSQL, the Next.js development API, and Socket.IO development service. Coverage includes GST, billing, tenant isolation, RBAC, refunds, KDS, inventory, sale-time recipe deduction/reversal, report permissions/aggregates/CSV safety, plus Free-plan outlet rejection, Pro outlet cloning, owner authorization, cross-tenant denial, and concurrent capacity enforcement. Socket fan-out used the development in-memory adapter; production Redis multi-instance behavior remains unverified.
- `npm audit --omit=dev --audit-level=high`: zero production dependency advisories.
- `npm run build`: passed with Next.js 16.4.6; all App Router routes compiled and standalone static assets copied successfully.
- Latest standalone production smoke on `http://localhost:3001`: `/` and `/api/health/live` returned 200; unauthenticated `POST /api/outlets` returned 401; `/api/health/ready` returned 503 because Redis is unavailable locally, correctly keeping the service unready. The development preview on port 3000 remains available.
- Browser QA signed into a disposable local Pro tenant, created a new outlet through the owner dialog, verified it became selected, and confirmed the copied menu had all 10 items and 5 categories. The disposable tenant was deleted after the check.
- A production-mode registration attempt returned 503 (`Account setup is temporarily unavailable`) while local Redis was down; the auth path fails closed, so the order-to-invoice flow was verified against the development API rather than by bypassing production auth controls.
- GST bill creation and invoice print-data retrieval passed live assertions for tax profiles, buyer snapshots, HSN/SAC snapshots, tax grouping, invoice reconciliation, the 16-character serial limit, and wrong-outlet denial. Browser printer rendering, physical ESC/POS output and GST reporting/export remain unverified.
- `npm run db:audit-tenant-ownership` reported zero ownership mismatches in the local database; this does not verify production customer data.

## Production blockers

1. Production data has not yet been scanned with `npm run db:audit-tenant-ownership`; the local zero-mismatch result does not say anything about customer production data.
2. CI and production container targets exist, but the workflow has not yet run on GitHub and no production deployment manifest exists. Runtime and migration role separation still needs staging verification. Docker was unavailable on the local host.
3. Backups, restore, rollback, observability, TLS, trusted-edge HMAC, and production Redis behavior need staging verification.
4. Cloud UI coverage is partial. Refund recording is implemented but does not initiate provider transfers; split-bill settlement, full menu variants/add-ons, and several admin workflows remain incomplete. The cloud refund UI path still needs browser verification.
5. Offline cloud mode queues order creation only. Payment, KOT, conflict recovery, and printer queues are not fully offline-first or validated through browser restart/quota failures.
6. Recipe-linked sale/void stock handling, single-outlet sales reports, and outlet count gating are active. Vendor purchasing, HSN/SAC-wise GST return exports, shift reports, subscription checkout/plan changes, paid-tier feature entitlements, aggregator operations, and owner multi-outlet analytics remain incomplete. No staff invitation/user-creation endpoint exists yet, so the agreed user limit has no creation path to enforce.
7. Full browser/accessibility/device QA and physical ESC/POS printer testing remain outstanding; the local demo POS flow was only smoke-tested on desktop Chrome.
8. GST invoice printing is implemented as a browser dialog template but has not been approved by an accountant or tested on physical 58/80mm hardware. HSN/SAC syntax is checked but not mapped to tax law; GSTIN status/checksum is not verified against GSTN. Cross-state packaged-goods delivery is blocked, and there is no GSTR-1 or composition-turnover export. Historical bills backfill current supplier identity, and old overlength serials are blocked from tax-document printing; review historical bills before migration/use.

## Next engineering order

1. Run the historical ownership scan on a production-like data clone and verify the restricted runtime PostgreSQL role.
2. Run the GitHub CI workflow and build all three Docker targets in a clean Linux environment.
3. Accountant-review the receipt/tax-invoice/Bill-of-Supply output and complete GST reporting/export, inter-state goods tax, and physical printer verification.
4. Close POS settlement/refund and offline recovery gaps, then continue operations/reporting modules.
5. Complete vendor purchasing, stock adjustments/returns policy, unit conversions, cost reporting, and remaining operations modules. Add staff invitation/user provisioning with the approved user quota, then implement subscription lifecycle and only the paid-tier entitlements the product owner approves.
6. Complete staging, browser/accessibility, printer, load, backup/restore and incident rollback acceptance.

KORA remains in active development and must not be represented as production-ready until these blockers are completed and verified in the target deployment environment.
