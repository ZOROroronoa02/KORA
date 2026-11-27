# Changelog

## 2026-11-27

- Replaced hardcoded cloud restaurant settings with an outlet profile editor backed by outlet name, GSTIN, FSSAI license, and structured address fields; server-side `settings.manage` checks, outlet scoping, format validation, and before/after audit logging are covered by a live API integration test.
- Made accepted cloud POS orders independent of the follow-up list refresh: the API response is shown immediately, refresh failures surface as sync attention, and IndexedDB queue read failures no longer appear as an empty/synced queue.
- Persisted offline logout intent before network logout, blocked cached workspace restoration while sign-out is pending, and require that pending logout to flush before a new sign-in or restaurant registration.
- Added a read-only tenant/outlet ownership audit command and separated migration credentials from runtime database credentials.
- Added standalone web output, production Docker targets for web/realtime/migrations, and GitHub Actions verification.
- Required Redis for production realtime fan-out and added realtime dependency readiness checks.
- Changed GST and service-charge rounding to exact `BigInt` basis-point arithmetic.
- Included service charge in the GST taxable base, allocated it across contributing lines, and applied each line's GST rate; added unit and cloud-invoice regression coverage. See [CBIC FAQ 142](https://cbic-gst.gov.in/hindi/faq.html).
- Added per-outlet Indian financial-year invoice numbering, continuing from existing invoices in the active financial year.
- Added tenant-scoped append-only payment and refund ledgers, idempotent partial refunds, net bill status, paid-order void gating, and cash refund reconciliation.
- Added per-item HSN/SAC classification and immutable order/bill snapshots for supplier, buyer, and place-of-supply details; added a tenant/outlet-scoped invoice-data endpoint and 58 mm/80 mm browser print layouts for receipts, tax invoices, and Bills of Supply.
- Scoped recipe BOMs to an outlet/menu-item pair, added migration-time ambiguity checks, outlet guards, and a composite FK that cleans up recipes when menu availability is removed. Built audited recipe CRUD with paginated outlet menu choices and deterministic integer-milli deduction calculation; sales integration remains gated on low-stock and reversal rules.
- Connected recipe BOMs to order creation and order item additions with atomic, row-locked stock deduction. New outlets block shortages by default; explicitly allowed negative stock is audited. Sale movement rows snapshot the original recipe quantities and rounding offset. Voids restore only queued/out-of-stock KOT quantities; prepared or untracked quantities stay consumed, with reversal movements and audit detail.
- Added server-aggregated cloud sales reports for bill totals, daily totals, item performance, payment/refund activity, and stored GST buckets. Date filters use inclusive IST calendar days with a 93-day bound; report and CSV fields are permission-filtered, tenant/outlet-scoped, and formula-safe. See `docs/sales-reports.md`.
- Kept newly issued GST serials within 16 characters, fail-closed cross-state packaged-goods delivery until IGST treatment is supported, and blocked printing of overlength historical tax-document numbers instead of rewriting them.
- Added tenant predicates to raw SQL row locks and financial-year invoice scans; cash refunds now fail if the cashier shift closes before its row lock is acquired.
- Normalized Prisma serialization/deadlock failures from raw SQL locks into retryable 409 conflicts instead of internal-server errors.
- Made the Orders “New order” action open POS only for roles with `orders.create`, and changed the production start command to launch the configured standalone server.
- Tightened the mobile POS top bar so sync, role, and connect controls fit without hiding the sync label from assistive technology.
- Verified thirteen local migrations, the production Next.js build, and the live suite (74 passed, 0 failed, 0 skipped). Realtime security ran against the development in-memory adapter; production Redis fan-out remains unverified. Production dependency audit reported 0 advisories.
- Production Docker targets and the GitHub Actions workflow still need execution in a clean Linux/GitHub environment.
