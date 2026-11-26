type EscPosLine = { name: string; quantity: number; notes?: string | null; variant?: string | null };
type EscPosTicket = { kotNumber: number; orderType: string; tableLabel?: string | null; waiterName?: string | null; createdAt: Date | string; station?: string | null; notes?: string | null; items: EscPosLine[] };

const encoder = new TextEncoder();
const ESC = "\x1b";
const GS = "\x1d";
const safeText = (value: unknown) => String(value ?? "").normalize("NFKD").replace(/[^\x20-\x7E]/g, "?").replace(/[\x00-\x1F\x7F]/g, " ").slice(0, 120);

/** Plain ESC/POS receipt bytes; Indian-language glyph printing requires a configured printer code page. */
export function buildEscPosKot(ticket: EscPosTicket, width = 42) {
  const line = (value: unknown) => safeText(value).slice(0, width);
  const created = new Date(ticket.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
  const output = [
    ESC + "@", ESC + "a" + "\x01", ESC + "E" + "\x01", line("KORA KITCHEN"), ESC + "E" + "\x00", ESC + "a" + "\x00",
    line(`KOT #${ticket.kotNumber}  ${ticket.orderType.replaceAll("_", " ")}`),
    line([ticket.tableLabel ? `TABLE ${ticket.tableLabel}` : "", ticket.station ? `STATION ${ticket.station}` : ""].filter(Boolean).join(" · ")),
    line(`WAITER ${ticket.waiterName ?? "Staff"}`), line(created), "-".repeat(width),
    ...ticket.items.flatMap((item) => [line(`${item.quantity} x ${item.name}`), ...(item.variant ? [line(`  ${item.variant}`)] : []), ...(item.notes ? [line(`  NOTE: ${item.notes}`)] : [])]),
    ...(ticket.notes ? ["-".repeat(width), line(`NOTE: ${ticket.notes}`)] : []),
    "\n\n", GS + "V" + "\x00",
  ];
  const bytes = encoder.encode(output.join("\n"));
  return bytes;
}
