# Plan quotas and outlet provisioning

KORA enforces the approved numeric quotas from the tenant's database plan:

| Plan | Outlets | Active tenant users | Price |
| --- | ---: | ---: | ---: |
| Free | 1 | 1 | Basic, no charge |
| Plus | 1 | 10 | ₹5,999/month |
| Pro | 10 | 50 | ₹8,999/month |

`src/lib/domain/plan-limits.ts` is the shared server-side quota source. Outlet creation is owner-only at `POST /api/outlets`; it reads `Tenant.plan` from PostgreSQL and never accepts a plan or tenant ID from the request as authority. Provisioning serializes on the tenant row before checking the outlet count, so concurrent requests cannot exceed the cap. Rejections return HTTP 409 with `code: PLAN_LIMIT_REACHED` and the resource and allowed limit.

Creating an outlet copies the active menu categories, menu items, variants, add-ons, happy-hour rules, outlet prices, station assignments, and active table layout from the selected outlet. It creates fresh outlet settings and stations, assigns the creator the tenant OWNER role at the new outlet, and writes an audit event. Stock, recipes, purchases, orders, shifts, and financial history are not copied; stock and recipes must be configured independently at the new location.

New tenant registration explicitly starts on Free and provisions its first user and outlet. Owners with `roles.manage` can invite staff from Team settings. `POST /api/admin/invitations` reads the plan from the database, serializes seat checks on the tenant row, and reserves one seat per distinct email with a valid pending invitation. Active accounts plus reserved invitations cannot exceed 1/10/50. Invitations expire after 72 hours; accepting one creates the account and outlet role atomically, records an audit event, issues the normal short-lived access token and HttpOnly rotating refresh cookie, and consumes the reservation. A reservation can be revoked to free the seat. When the email already belongs to an active account in the tenant, the owner-selected role is assigned directly without consuming a new seat.

The invitation token is 256-bit random, stored as a SHA-256 hash, shown once to the owner, and placed in the invite URL fragment so it is not sent in the initial HTTP request. The owner shares that link manually; KORA does not send or verify email. Public resolution and acceptance endpoints are same-origin guarded, IP/account-rate-limited, and do not accept tenant, outlet, user, or role identifiers from the invitee. The database trigger validates tenant ownership across the invitation's outlet, role, and creator. See the `staff_invitations` migration for the reversible schema addition.

There is also no subscription checkout, payment verification, renewal, delinquency, or plan-change workflow. Paid plans must not be self-selected by a client; plan changes currently require a trusted operator/database process. Feature-level entitlements have not been specified or implemented, so no arbitrary Plus/Pro feature matrix is enforced.

## Verification

- `tests/plan-limits.test.mjs` checks all six numeric caps and boundary inputs.
- `tests/outlets-api.test.mjs` covers Free rejection, Pro provisioning, copied menu/tables, fresh inventory, owner-only access, cross-tenant denial, and two concurrent requests at the Pro cap.
- `tests/staff-invitations.test.mjs` checks token shape, normalization, distinct seat reservations, and expiry/revocation behavior. `tests/staff-invitations-api.test.mjs` exercises Free rejection, one-time acceptance/replay, revocation, manager denial, cross-tenant denial, and a concurrent last-seat race against PostgreSQL and the running API.
