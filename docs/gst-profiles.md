# Tenant GST profiles

Updated: 2026-11-27.

## Scope and data model

- One GSTIN belongs to a tenant and is shared by its outlets. Outlet branch address remains outlet-specific.
- New tenants start as `NOT_REGISTERED` with a zero GST rate. A GST-registered profile requires a structurally valid GSTIN; registered sales also require a complete outlet address whose state matches the GSTIN state code.
- `Tenant.gstProfile` and `Tenant.gstRateBps` select the active profile and configurable inherited rate. `MenuItem.gstBps = NULL` inherits that rate; a non-null value is an explicit per-item override.
- `NOT_REGISTERED` and `COMPOSITION` never add GST to customer bills. Composition orders use `BILL_OF_SUPPLY`; unregistered orders use `RECEIPT`. Regular profiles use `TAX_INVOICE`.
- Bills snapshot document type, GST profile, configured rate, GSTIN, supplier name/address, buyer name/GSTIN/address, place of supply, and service-charge rate. Order lines snapshot the effective GST basis-point rate and HSN/SAC classification used for the sale.
- Profile changes require `tax.profile.manage` (Owner only). Per-item rate edits require `menu.tax_edit` (Owner only). Both are audited. Other outlet details remain under `settings.manage`.

## Built-in templates

| Profile | Default rate | Bill behavior |
| --- | ---: | --- |
| Not GST registered | 0% | Receipt; no GST added |
| Standard restaurant | 5% | Tax Invoice; default 2.5% CGST + 2.5% SGST; input tax credit restrictions apply |
| Specified premises | 18% | Tax Invoice; default 9% CGST + 9% SGST; eligibility and input tax credit rules apply |
| Composition | 0% on customer bill | Bill of Supply; KORA does not compute composition levy per order |

Standard and specified-premises rates may be configured in basis points. Menu item overrides take precedence under these regular profiles. The configured defaults are templates, not eligibility decisions. Confirm the registration, premises status, rate, and input tax credit treatment with the restaurant's accountant before use. The current CBIC rate schedule lists restaurant service outside specified premises at 5% subject to the stated input-credit condition and restaurant service at specified premises at 18%. The GST Council record notes that the revised specified-premises definition took effect on 1 April 2025. CBIC's composition guidance describes restaurant composition levy at 5% of turnover and requires a Bill of Supply; it is not tax to add to each bill. [CBIC GST rate schedule](https://cbic-gst.gov.in/hindi/gst-goods-services-rates.html), [GST Council specified-premises record](https://gstcouncil.gov.in/sites/default/files/Minutes/56th_meeting_of_gstc_agenda-2.pdf), [CBIC composition FAQ](https://cbic-gst.gov.in/pdf/faq-manual/faq-composition-levy-revised.pdf), [CBIC composition rules](https://cbic-gst.gov.in/composition-rules.html).

## API and migration behavior

- `GET/PATCH /api/outlet-profile?outletId=...` reads outlet details plus tenant-shared GST settings. The server enforces outlet assignment, tenant scoping, GST profile permission, GSTIN format, profile/rate invariants, and recognized state-code matching.
- `GET /api/menu?outletId=...` returns effective GST rates and HSN/SAC codes for POS display. `POST/PATCH /api/menu` accepts an optional per-item `gstBps` override and HSN/SAC code; `null` clears the rate or classification. `menu.tax_edit` is required to change either. Code-shape checks do not confirm that an HSN/SAC is appropriate for the item.
- `POST /api/orders` ignores client price/tax claims, resolves tenant profile and menu rates server-side, calculates in paise, and persists tax/document/supplier/buyer snapshots with the bill transaction. Tax-invoice lines require an HSN/SAC classification. Buyer GSTIN and address are checked and snapshotted; a high-value B2C tax invoice requires buyer name and address. Added order items use the original bill's profile/rate/service-charge snapshots.
- `GET /api/bills/{billId}/invoice?outletId=...` returns an outlet-scoped, no-store print model after verifying the immutable line snapshots reconcile with bill totals. The POS renders a print preview with 58 mm and 80 mm page layouts, buyer/supplier identity, HSN/SAC, line tax, tax groups, tendered amount and balance due. Bill of Supply displays the required composition-person notice. Printing uses the browser print dialog; physical ESC/POS hardware has not been verified.
- New invoice serials use a compact financial-year series such as `K-FY2627-000001`, within the 16-character maximum in [CBIC invoice rules](https://cbic-gst.gov.in/hindi/gst-invoice-rules.html). Historical issued bill numbers are never rewritten; overlength historical tax documents are blocked from printing for review.
- Registered tax-invoiced packaged-goods deliveries require a destination address. Cross-state packaged-goods deliveries are rejected until KORA implements and verifies the applicable inter-state tax treatment. Restaurant-service lines continue to use the outlet registration state. This is a deliberate fail-closed limitation.
- Migration `20261127190000_tenant_gst_profiles` moves outlet GSTIN to Tenant, fails before changing data if a tenant has conflicting outlet GSTINs or a GSTIN is assigned to multiple tenants, makes menu tax overrides nullable, and snapshots best-available current supplier details on existing bills. Existing tenants retain the previous 5% default. New tenants default to no GST collection.
- Migration `20261127200000_gst_role_permissions` grants the two new permissions to existing tenant owners. New tenant role seeding includes those permissions automatically.
- Manual rollback notes are in each migration file. Review owner-permission customization and already-issued bills before rollback.

## Not completed by this change

- The renderer has not been reviewed or approved by the restaurant's accountant and has not been validated on real 58 mm or 80 mm printers. It opens the browser print dialog; direct ESC/POS output and offline print queueing are separate work.
- KORA validates HSN/SAC syntax, not the classification/rate mapping, GSTIN checksum or active registration status. Users must have an accountant confirm these values before registered billing.
- Inter-state packaged-goods delivery is blocked; no IGST calculation or ship-to/bill-to distinction is implemented. Other supplies that can have a distinct place of supply need tax review before activation.
- The profile stores one GSTIN per tenant by design; chains operating in multiple GST registration states need separate tenants until a registration-group model is approved.
- GSTIN validation checks structure and registration state prefix only; it does not verify GSTIN checksum/status against GSTN.
- There is no GSTR-1 export, composition-turnover computation, GST return filing, or accountant-approved regime workflow.
- Historic bills receive current tenant/outlet identity as a best-available snapshot because those fields were not captured when the old bills were issued. Review historic invoice data separately before production migration.
