export const gstProfileDefaults = {
  NOT_REGISTERED: { rateBps: 0, documentType: "RECEIPT", registered: false },
  STANDARD_RESTAURANT: { rateBps: 500, documentType: "TAX_INVOICE", registered: true },
  SPECIFIED_PREMISES: { rateBps: 1800, documentType: "TAX_INVOICE", registered: true },
  COMPOSITION: { rateBps: 0, documentType: "BILL_OF_SUPPLY", registered: true },
} as const;

export type GstProfile = keyof typeof gstProfileDefaults;
export type InvoiceDocumentType = typeof gstProfileDefaults[GstProfile]["documentType"];
export type TaxCodeKind = "HSN" | "SAC";

const gstinPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;

const stateCodes: Record<string, string[]> = {
  "01": ["jammuandkashmir", "jammuandkashmirunionterritory", "jk"],
  "02": ["himachalpradesh", "hp"],
  "03": ["punjab", "pb"],
  "04": ["chandigarh", "ch"],
  "05": ["uttarakhand", "uk"],
  "06": ["haryana", "hr"],
  "07": ["delhi", "nctofdelhi", "dl"],
  "08": ["rajasthan", "rj"],
  "09": ["uttarpradesh", "up"],
  "10": ["bihar", "br"],
  "11": ["sikkim", "sk"],
  "12": ["arunachalpradesh", "arunachal", "ar"],
  "13": ["nagaland", "nl"],
  "14": ["manipur", "mn"],
  "15": ["mizoram", "mz"],
  "16": ["tripura", "tr"],
  "17": ["meghalaya", "ml"],
  "18": ["assam", "as"],
  "19": ["westbengal", "wb"],
  "20": ["jharkhand", "jh"],
  "21": ["odisha", "orissa", "od"],
  "22": ["chhattisgarh", "cg"],
  "23": ["madhyapradesh", "mp"],
  "24": ["gujarat", "gj"],
  "25": ["damananddiu", "dd"],
  "26": ["dadraandnagarhavelianddamanddiu", "dnhdd"],
  "27": ["maharashtra", "mh"],
  "28": ["andhrapradesh"],
  "29": ["karnataka", "ka"],
  "30": ["goa", "ga"],
  "31": ["lakshadweep", "ld"],
  "32": ["kerala", "kl"],
  "33": ["tamilnadu", "tn"],
  "34": ["puducherry", "pondicherry", "py"],
  "35": ["andamanandnicobarislands", "andamanandnicobar", "an"],
  "36": ["telangana", "ts"],
  "37": ["andhrapradesh", "ap"],
  "38": ["ladakh", "la"],
  "97": ["otherterritory"],
};

const normalizeState = (state: string) => state.toLowerCase().replace(/[^a-z0-9]/g, "");

export function gstStateCodeForName(state: string): string | null {
  const normalized = normalizeState(state);
  return Object.entries(stateCodes).find(([, aliases]) => aliases.includes(normalized))?.[0] ?? null;
}

export function isValidGstin(value: string) {
  return gstinPattern.test(value.trim().toUpperCase());
}

export function gstinStateMatchesAddress(gstin: string, state: string) {
  return gstStateCodeForName(state) === gstin.slice(0, 2);
}

export function gstRateForItem(profile: GstProfile, configuredRateBps: number, itemOverrideBps?: number | null) {
  if (!Object.hasOwn(gstProfileDefaults, profile)) throw new RangeError("Unknown GST profile");
  if (!Number.isSafeInteger(configuredRateBps) || configuredRateBps < 0 || configuredRateBps > 10_000) throw new RangeError("Configured GST rate must be between 0 and 10000 basis points");
  if (profile === "NOT_REGISTERED" || profile === "COMPOSITION") return 0;
  if (itemOverrideBps === undefined || itemOverrideBps === null) return configuredRateBps;
  if (!Number.isSafeInteger(itemOverrideBps) || itemOverrideBps < 0 || itemOverrideBps > 10_000) throw new RangeError("Item GST rate must be between 0 and 10000 basis points");
  return itemOverrideBps;
}

export function validateGstConfiguration(input: { profile: GstProfile; rateBps: number; gstin: string }) {
  if (!Object.hasOwn(gstProfileDefaults, input.profile)) return "Select a supported GST profile.";
  const template = gstProfileDefaults[input.profile];
  if (!Number.isSafeInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 10_000) return "GST rate must be between 0 and 10000 basis points.";
  if ((input.profile === "NOT_REGISTERED" || input.profile === "COMPOSITION") && input.rateBps !== 0) return "This profile does not collect GST on customer bills; its bill rate must be zero.";
  if (template.registered && !isValidGstin(input.gstin)) return "A valid tenant GSTIN is required for the selected GST profile.";
  if (!template.registered && input.gstin) return "Clear the GSTIN before selecting the unregistered profile.";
  return null;
}

export function hasInvoiceAddress(value: unknown): value is Record<string, unknown> & { line1: string; city: string; state: string; pincode: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const address = value as Record<string, unknown>;
  return [address.line1, address.city, address.state].every((field) => typeof field === "string" && field.trim().length > 0)
    && typeof address.pincode === "string" && /^\d{6}$/.test(address.pincode);
}

export function validateTaxCode(input: { kind: unknown; code: unknown }) {
  if (input.kind === null && input.code === null) return null;
  if (input.kind !== "HSN" && input.kind !== "SAC") return "Select HSN or SAC for the menu item's tax code.";
  if (typeof input.code !== "string") return "Enter the menu item's HSN/SAC code.";
  const code = input.code.trim();
  const valid = input.kind === "HSN" ? /^\d{2,8}$/.test(code) : /^\d{6}$/.test(code);
  if (!valid) return input.kind === "HSN" ? "HSN must contain 2–8 digits." : "SAC must contain 6 digits.";
  return null;
}

export type RecipientInvoiceDetails = {
  name: string | null;
  gstin: string | null;
  address: { line1: string; line2: string; city: string; state: string; pincode: string } | null;
};

/** Validate optional buyer details and Rule 46's recipient details for high-value B2C invoices. */
export function validateRecipientInvoiceDetails(input: unknown, taxablePaise: number): { value?: RecipientInvoiceDetails; error?: string } {
  if (!Number.isSafeInteger(taxablePaise) || taxablePaise < 0) return { error: "Taxable value is invalid." };
  if (input === undefined || input === null) input = {};
  if (typeof input !== "object" || Array.isArray(input)) return { error: "Buyer billing details must be an object." };
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const gstin = typeof raw.gstin === "string" ? raw.gstin.trim().toUpperCase() : "";
  if (raw.name !== undefined && typeof raw.name !== "string") return { error: "Buyer name is invalid." };
  if (name.length > 150) return { error: "Buyer name must be 150 characters or fewer." };
  if (raw.gstin !== undefined && typeof raw.gstin !== "string") return { error: "Buyer GSTIN is invalid." };
  if (gstin && !isValidGstin(gstin)) return { error: "Buyer GSTIN must contain a valid 15-character format." };

  let address: RecipientInvoiceDetails["address"] = null;
  if (raw.address !== undefined && raw.address !== null) {
    if (typeof raw.address !== "object" || Array.isArray(raw.address)) return { error: "Buyer address is invalid." };
    const source = raw.address as Record<string, unknown>;
    const keys = ["line1", "line2", "city", "state", "pincode"] as const;
    if (keys.some((key) => source[key] !== undefined && typeof source[key] !== "string")) return { error: "Buyer address fields must be text." };
    const value = Object.fromEntries(keys.map((key) => [key, typeof source[key] === "string" ? (source[key] as string).trim() : ""])) as Record<(typeof keys)[number], string>;
    if (Object.values(value).some(Boolean)) {
      if (value.line1.length > 120 || value.line2.length > 120 || value.city.length > 80 || value.state.length > 80 || !/^\d{6}$/.test(value.pincode)) return { error: "Complete the buyer address and enter a 6-digit PIN code." };
      if (!gstStateCodeForName(value.state)) return { error: "Enter a recognized Indian State or Union Territory in the buyer address." };
      address = value;
    }
  }
  if (gstin && (!name || !address)) return { error: "Buyer name and complete billing address are required when a GSTIN is entered." };
  if (gstin && address && !gstinStateMatchesAddress(gstin, address.state)) return { error: "Buyer address state does not match the GSTIN registration state." };
  if (!gstin && taxablePaise >= 5_000_000 && (!name || !address)) return { error: "Buyer name and complete billing address are required for taxable supplies of ₹50,000 or more." };
  return { value: { name: name || null, gstin: gstin || null, address } };
}
