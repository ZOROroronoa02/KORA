# Cloud sales reports

Updated: 2026-11-27.

## Endpoint

- `GET /api/reports/sales?outletId=...&from=YYYY-MM-DD&to=YYYY-MM-DD` returns outlet sales aggregates for inclusive calendar dates interpreted in `Asia/Kolkata`.
- Omit both dates to report today. The maximum range is 93 days. Invalid calendar dates, reversed ranges, and longer ranges return `400`.
- `format=csv` exports the same permission-filtered aggregate as an attachment. CSV text fields are escaped and spreadsheet formula prefixes are neutralized.
- The report never trusts tenant identity from the query. The server resolves tenant and outlet access from the session and scopes every Prisma/SQL read by both tenant and outlet.

## Permissions and data definitions

- Any of `reports.view.sales`, `reports.view.financial`, or `reports.view.gst` can open the endpoint.
- `reports.view.sales` exposes bill counts, daily bill counts, and item quantities. Monetary fields, payment/refund activity, and item values require `reports.view.financial`.
- The GST section requires `reports.view.gst` and groups the saved bill tax buckets by document type and GST profile.
- Bill summaries and daily billed totals use `Bill.issuedAt` in the selected period and exclude cancelled orders. Their stored amounts include the saved discounts, tax, and service charge.
- Payment and refund activity use each ledger event's own `recordedAt` timestamp. They are shown separately; a refund does not rewrite the original bill-period sales totals.
- Item sales use saved `OrderItem.totalPaise`, which is after allocated discounts and before GST and service charge. Top items are limited to ten rows.
- GST totals reconcile stored bill taxable/C-GST/S-GST/I-GST buckets. The page and CSV label them as a reconciliation aid, not a GSTR-1 filing export; HSN/SAC-wise return output still needs accountant review.

## UI states

The cloud page has date filters, loading and error states, an explicit no-bills empty state, permission-filtered money fields, and a CSV download. It does not invent previous-period comparisons when those aggregates are not requested.

## Verification

`tests/reports-api.test.mjs` covers tenant/outlet isolation, cancellation filtering, persisted bill/payment/refund/tax aggregates, financial redaction, permission denial, date validation, range limits, and formula-safe CSV export.
