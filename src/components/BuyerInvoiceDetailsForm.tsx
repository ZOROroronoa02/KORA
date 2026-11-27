import type { Dispatch, SetStateAction } from "react";

export type BuyerInvoiceDraft = {
  name: string;
  gstin: string;
  address: { line1: string; line2: string; city: string; state: string; pincode: string };
};

export function BuyerInvoiceDetailsForm({
  details,
  setDetails,
  open,
  setOpen,
}: {
  details: BuyerInvoiceDraft;
  setDetails: Dispatch<SetStateAction<BuyerInvoiceDraft>>;
  open: boolean;
  setOpen: (value: boolean) => void;
}) {
  const updateAddress = (field: keyof BuyerInvoiceDraft["address"], value: string) => {
    setDetails((current) => ({ ...current, address: { ...current.address, [field]: value } }));
  };

  return (
    <div className="buyer-invoice-form">
      <button className="buyer-invoice-toggle" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Add"} buyer GST invoice details
      </button>
      {open && <div className="buyer-invoice-fields">
        <p>Optional for ordinary walk-in bills. Buyer name and address are required for a registered GSTIN, or taxable invoices of ₹50,000 and above. For packaged-goods delivery, enter the destination address here. Cross-state packaged-goods deliveries are currently blocked.</p>
        <label>Billing name<input maxLength={150} autoComplete="name" value={details.name} onChange={(event) => setDetails((current) => ({ ...current, name: event.target.value }))} /></label>
        <label>Buyer GSTIN (if registered)<input autoCapitalize="characters" maxLength={15} value={details.gstin} onChange={(event) => setDetails((current) => ({ ...current, gstin: event.target.value.toUpperCase() }))} /></label>
        <label>Address line 1<input maxLength={120} autoComplete="address-line1" value={details.address.line1} onChange={(event) => updateAddress("line1", event.target.value)} /></label>
        <label>Address line 2<input maxLength={120} autoComplete="address-line2" value={details.address.line2} onChange={(event) => updateAddress("line2", event.target.value)} /></label>
        <div className="buyer-invoice-address-row">
          <label>City<input maxLength={80} autoComplete="address-level2" value={details.address.city} onChange={(event) => updateAddress("city", event.target.value)} /></label>
          <label>State<input maxLength={80} autoComplete="address-level1" value={details.address.state} onChange={(event) => updateAddress("state", event.target.value)} /></label>
          <label>PIN code<input inputMode="numeric" maxLength={6} autoComplete="postal-code" value={details.address.pincode} onChange={(event) => updateAddress("pincode", event.target.value.replace(/\D/g, ""))} /></label>
        </div>
      </div>}
    </div>
  );
}
