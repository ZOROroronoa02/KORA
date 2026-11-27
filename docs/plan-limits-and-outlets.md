# Plan quotas and outlet provisioning

KORA enforces the approved numeric quotas from the tenant's database plan:

| Plan | Outlets | Active tenant users | Price |
| --- | ---: | ---: | ---: |
| Free | 1 | 1 | Basic, no charge |
| Plus | 1 | 10 | ₹5,999/month |
| Pro | 10 | 50 | ₹8,999/month |

`src/lib/domain/plan-limits.ts` is the shared server-side quota source. Outlet creation is owner-only at `POST /api/outlets`; it reads `Tenant.plan` from PostgreSQL and never accepts a plan or tenant ID from the request as authority. Provisioning serializes on the tenant row before checking the outlet count, so concurrent requests cannot exceed the cap. Rejections return HTTP 409 with `code: PLAN_LIMIT_REACHED` and the resource and allowed limit.

Creating an outlet copies the active menu categories, menu items, variants, add-ons, happy-hour rules, outlet prices, station assignments, and active table layout from the selected outlet. It creates fresh outlet settings and stations, assigns the creator the tenant OWNER role at the new outlet, and writes an audit event. Stock, recipes, purchases, orders, shifts, and financial history are not copied; stock and recipes must be configured independently at the new location.

New tenant registration explicitly starts on Free and provisions its first user and outlet. There is currently no staff invitation/user-creation API, so no live user-provisioning path exists where the 1/10/50 user caps can be checked. `exceedsPlanLimit` supports the user quota, but the quota must be invoked transactionally when invitation/provisioning is implemented. Do not interpret outlet limits as a substitute for user limits.

There is also no subscription checkout, payment verification, renewal, delinquency, or plan-change workflow. Paid plans must not be self-selected by a client; plan changes currently require a trusted operator/database process. Feature-level entitlements have not been specified or implemented, so no arbitrary Plus/Pro feature matrix is enforced.

## Verification

- `tests/plan-limits.test.mjs` checks all six numeric caps and boundary inputs.
- `tests/outlets-api.test.mjs` covers Free rejection, Pro provisioning, copied menu/tables, fresh inventory, owner-only access, cross-tenant denial, and two concurrent requests at the Pro cap.
