# Changelog

## 2026-11-27

- Added a read-only tenant/outlet ownership audit command and separated migration credentials from runtime database credentials.
- Added standalone web output, production Docker targets for web/realtime/migrations, and GitHub Actions verification.
- Required Redis for production realtime fan-out and added realtime dependency readiness checks.
- Changed GST and service-charge rounding to exact `BigInt` basis-point arithmetic.
- Added per-outlet Indian financial-year invoice numbering, continuing from existing invoices in the active financial year.
- Tightened the mobile POS top bar so sync, role, and connect controls fit without hiding the sync label from assistive technology.
- Verified five local migrations, the production Next.js build, production dependency audit (0 advisories), and the live suite (48 tests passed at the time of this entry).
- Production Docker targets and the GitHub Actions workflow still need execution in a clean Linux/GitHub environment.
