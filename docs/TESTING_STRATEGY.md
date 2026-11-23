# KORA Testing Strategy

## Layers

- **Unit:** paise parsing, tax, discounts, payment state, order transitions, allocation, stock changes, permissions and sync conflict policies.
- **PostgreSQL integration:** migrations, tenant/outlet isolation, registration, order/payment transactions, concurrent idempotency, KOT transitions, shifts, bill splits, inventory and audit history.
- **Playwright E2E:** registration through first order, dine-in/takeaway/delivery, payment/refund, KOT, shift close, reports and permission restrictions.
- **Offline E2E:** airplane mode, browser refresh/restart, outbox retry, duplicate acknowledgement, conflict, quota failure and manual retry.
- **Quality:** accessibility scan, keyboard-only journey, 360/390/700/768/1024/desktop viewports, dependency audit, load and query profiling.

## Acceptance evidence

Record command, environment, dataset size and result for each suite. A successful build is not product acceptance. Tests requiring PostgreSQL, Redis, printer hardware or provider credentials must be marked blocked until run against those dependencies; never replace those tests with mocks and label them end-to-end.

## Current baseline

At discovery, `npm test` ran 13 unit tests; `npm run lint` was only TypeScript checking. Build and Prisma schema validation passed. No PostgreSQL integration, Playwright, accessibility, concurrency or load suite existed.
