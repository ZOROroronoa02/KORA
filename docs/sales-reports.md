# Cloud sales reports

Updated: 2026-11-27.

## Endpoint

- `GET /api/reports/sales?outletId=...&from=YYYY-MM-DD&to=YYYY-MM-DD` returns outlet sales aggregates for inclusive calendar dates interpreted in `Asia/Kolkata`.
- Omit both dates to report today. The maximum range is 93 days. Invalid calendar dates, reversed ranges, and longer ranges return `400`.
- `format=csv` exports the same permission-filtered aggregate as an attachment. CSV text fields are escaped and spreadsheet formula prefixes are neutralized.
- The report never trusts tenant identity from the query. The server resolves tenant and outlet access from the session and scopes every Prisma/SQL read by both tenant and outlet.
- `GET /api/reports/shifts?outletId=...&from=...&to=...` returns a paginated shift reconciliation view for shifts opened in the same India-local date range. The default page is 50 rows; the maximum is 100. The opaque cursor is accepted only when it belongs to the authorized outlet and selected date range.
- `format=csv` exports the current shift page. Text fields neutralize spreadsheet formula prefixes; the UI's export includes only rows currently loaded and labels that scope.

## Permissions and data definitions

- Any of `reports.view.sales`, `reports.view.financial`, or `reports.view.gst` can open the endpoint.
- `reports.view.sales` exposes bill counts, daily bill counts, and item quantities. Monetary fields, payment/refund activity, and item values require `reports.view.financial`.
- The GST section requires `reports.view.gst` and groups the saved bill tax buckets by document type and GST profile.
- Bill summaries and daily billed totals use `Bill.issuedAt` in the selected period and exclude cancelled orders. Their stored amounts include the saved discounts, tax, and service charge.
- Payment and refund activity use each ledger event's own `recordedAt` timestamp. They are shown separately; a refund does not rewrite the original bill-period sales totals.
- Item sales use saved `OrderItem.totalPaise`, which is after allocated discounts and before GST and service charge. Top items are limited to ten rows.
- GST totals reconcile stored bill taxable/C-GST/S-GST/I-GST buckets. The page and CSV label them as a reconciliation aid, not a GSTR-1 filing export; HSN/SAC-wise return output still needs accountant review.
- Shift reports require both `reports.view.financial` and `reports.view.staff_performance`. Expected cash is opening float plus shift-linked cash captures minus shift-linked cash refunds. Open shifts use the current ledger; closed shifts preserve their stored close amount and flag if later shift-linked activity differs. Other payment modes are shown by captured method. Refunds with no shift link remain in outlet-level payment activity instead of being assigned to a cashier shift after the fact.

## UI states

The cloud page has date filters, loading and error states, explicit empty states, permission-filtered money fields, and CSV downloads. Shift history includes bounded cursor pagination, visible-row export, and a reconciliation warning. It does not invent previous-period comparisons when those aggregates are not requested.

## Verification

`tests/reports-api.test.mjs` covers tenant/outlet isolation, cancellation filtering, persisted bill/payment/refund/tax aggregates, financial redaction, permission denial, date validation, range limits, and formula-safe CSV export. `tests/shift-reports-api.test.mjs` covers dual-permission enforcement, outlet and tenant denial, shift-specific payment/refund reconciliation, bounded cursor pagination, range validation, and formula-safe CSV export.
