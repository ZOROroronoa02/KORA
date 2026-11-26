# Phase 2: Kitchen Display System

## What shipped

- Full-screen, touch-first `/kds` board with FIFO and longest-wait sorting, station/order filters, search, keyboard shortcuts, elapsed/SLA states, rush/hold indicators, sound gating, and a 100-ticket initial render with progressive loading.
- Outlet-scoped KOT numbering and station routing. Existing tickets keep their station; new order lines create a follow-up KOT, including when added from an existing order.
- Item transitions, ticket start/hold/resume/bump/undo/recall, 86-item availability updates, audit events, and per-station/item prep, SLA, handoff, and hourly metrics.
- Dexie-backed ticket snapshots and an offline mutation queue. Mutations include a client idempotency key and expected item timestamp; reconnect replay stops on conflicts for operator review.
- Per-station KDS lane visibility and order in `OutletSettings.kdsColumnsByStation`. The `all` key is the fallback; an explicit station key overrides it. Only `QUEUED`, `PREPARING`, and `READY` lanes can be configured, with at least one lane visible.
- No new dependencies were added.

## Database and migration

Migration: `prisma/migrations/20261127100000_kds_phase2/migration.sql`.

It adds station routing, outlet KOT counters, ticket snapshots/status timestamps, item state/version timestamps, and the idempotent mutation ledger. Existing KOTs are backfilled to the `General` station and get an outlet sequence; existing menu outlet rows are routed to `General`. New demo/registered outlets get the seeded kitchen stations.

The migration has a reverse SQL note in `prisma/migrations/20261127100000_kds_phase2/rollback.sql`. Rollback drops the new KDS data/columns and therefore discards KDS state and station routing created after the migration. Back up the database before using it.

## Routes

All routes resolve the caller's outlet role server-side and scope reads and writes to the outlet/tenant.

| Route | Use | Permission |
| --- | --- | --- |
| `GET /api/kds?outletId=…` | Active tickets, stations, outlet display/SLA settings | `kds.view` |
| `GET /api/kds?outletId=…&includeServed=1` | Bumped tickets eligible for recall | `kds.view` |
| `POST /api/kds/actions` | Item/ticket transitions, hold/resume, 86, recall, undo | Action-specific KDS permission |
| `POST /api/kds/stations` | Create outlet station | `menu.edit` |
| `PATCH /api/kds/stations` | Assign menu item to outlet station | `menu.edit` |
| `GET /api/kds/metrics?outletId=…` | Rolling 14-day station/item and hourly metrics; capped at 5,000 tickets | `reports.view.kds_sla` |
| `GET /api/kds/tickets/:ticketId/reprint?outletId=…` | Audited ESC/POS bytes for a KOT | `kot.reprint` |
| `PATCH /api/outlet-settings` | Outlet settings, including station lane visibility/order | `settings.manage` |
| `POST /api/orders/:orderId/items` | Append items and create station-routed follow-up KOTs | Existing order-edit permission |

KOT reprint returns an `application/vnd.kora.escpos` binary download. This repository does not include a local printer bridge, so automatic USB/LAN printing still requires deployment of that bridge.

## Realtime events

The realtime service emits these outlet-room events with `serverTimestamp`:

- `connection:outlet-joined`
- `kot:created`
- `kot:item:updated`
- `kot:updated`
- `kot:recalled`
- `kot:86-item`
- Existing order events such as `order:new` and `order:updated` remain in use.

The browser reloads the outlet-scoped snapshot on a KOT event. When the socket is unavailable, the board polls while online and keeps its last IndexedDB snapshot visible.

## Verification checklist

- Create KOTs from a new order and an appended order line; confirm each station receives a separate ticket and outlet KOT numbers increment.
- Change a menu item's station; verify existing KOT station snapshots remain unchanged and future lines route to the new station.
- Configure and reorder lanes for `All stations` and one station; verify the station override and fallback after reload. Invalid, duplicate, empty, and cross-outlet station configuration must be rejected.
- Exercise item states, start, hold/resume, bump, five-second undo, recall within 30 minutes, and 86. Confirm audit records and order state only advances after all station tickets finish.
- Disconnect the socket/network, make an offline action, reconnect, and verify idempotent replay. Change the item on another client before replay and confirm the conflict remains visible for review.
- Verify cashier/waiter denial, chef/manager KDS access, outlet boundary denial, reprint permission, and metrics permission.
- Check the screen on a kitchen tablet and desktop, with keyboard navigation, reduced motion, muted/hidden-tab sound behavior, and narrow viewport.

## Known boundaries

- The POS currently renders the board directly in the web app. A dedicated printer bridge, Android device validation, and a Redis-backed multi-instance socket deployment require environment/infrastructure work outside this repository change.
- Boards progressively load tickets in 100-ticket pages; the DOM is bounded initially but does not use row virtualization.
- Browser storage can be cleared by the OS. Offline availability depends on the device retaining the IndexedDB snapshot and queue.
