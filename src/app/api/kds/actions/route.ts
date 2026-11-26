import { createHash } from "node:crypto";
import { KOTStatus, OrderStatus, Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { aggregateKdsTicketState, nextKdsItemState, validateHoldReason, type KdsItemState } from "@/lib/domain/kds";
import { requirePermission } from "@/lib/server-auth";
import { prisma } from "@/lib/prisma";
import { publishOutletEvent } from "@/lib/realtime";
import { readJsonObject, RequestInputError } from "@/lib/http";

export const runtime = "nodejs";
const safeJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry));
const permissionFor: Record<string, string> = {
  "item-cycle": "kds.bump", "item-86": "kds.86", "start-all": "kds.bump", "bump-ticket": "kds.bump",
  "undo-bump": "kds.bump", hold: "kds.hold", resume: "kds.hold", recall: "kds.recall",
};
const legacyStatus = (state: KdsItemState) => state === "QUEUED" ? KOTStatus.QUEUED : state === "COOKING" ? KOTStatus.PREPARING : state === "OUT_OF_STOCK" ? KOTStatus.CANCELLED : KOTStatus.READY;
const ticketStatus = (states: readonly KdsItemState[]) => aggregateKdsTicketState(states) as KOTStatus;
class KdsConflict extends Error { constructor(message: string) { super(message); this.name = "KdsConflict"; } }

export async function POST(request: NextRequest) {
  let replayContext: { outletId: string; userId: string; clientMutationId: string; requestHash: string } | undefined;
  try {
    const body = await readJsonObject(request, 16 * 1024);
    const outletId = typeof body.outletId === "string" ? body.outletId : "";
    const ticketId = typeof body.ticketId === "string" ? body.ticketId : "";
    const action = typeof body.action === "string" ? body.action : "";
    const clientMutationId = typeof body.clientMutationId === "string" ? body.clientMutationId.trim() : "";
    const permission = permissionFor[action];
    if (!outletId || !ticketId || !permission || !/^[\w-]{16,100}$/.test(clientMutationId)) return NextResponse.json({ error: "A valid outlet, ticket, action, and clientMutationId are required." }, { status: 400 });
    const access = await requirePermission(request, outletId, permission);
    if ("error" in access) return NextResponse.json({ error: access.error }, { status: access.error === "Unauthenticated" ? 401 : 403 });
    const itemId = typeof body.itemId === "string" ? body.itemId : "";
    const reason = body.reason;
    if (action === "hold" && !validateHoldReason(reason)) return NextResponse.json({ error: "A hold reason from 3 to 240 characters is required." }, { status: 400 });
    if ((action === "item-cycle" || action === "item-86") && !itemId) return NextResponse.json({ error: "An itemId is required for this action." }, { status: 400 });
    const expectedUpdatedAt = typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : undefined;
    if (expectedUpdatedAt && !Number.isFinite(Date.parse(expectedUpdatedAt))) return NextResponse.json({ error: "expectedUpdatedAt must be an ISO timestamp." }, { status: 400 });
    const requestValue = { action, ticketId, itemId: itemId || null, expectedUpdatedAt: expectedUpdatedAt ?? null, reason: action === "hold" ? String(reason).trim() : null };
    const requestHash = createHash("sha256").update(JSON.stringify(requestValue)).digest("hex");
    replayContext = { outletId, userId: access.user.id, clientMutationId, requestHash };
    const prior = await prisma.kOTMutation.findUnique({ where: { outletId_clientMutationId: { outletId, clientMutationId } } });
    if (prior) {
      if (prior.userId !== access.user.id || prior.requestHash !== requestHash) return NextResponse.json({ error: "clientMutationId was already used for a different request." }, { status: 409 });
      return NextResponse.json({ ...(prior.response as Record<string, unknown> ?? {}), replayed: true });
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const ticket = await tx.kOT.findFirst({ where: { id: ticketId, outletId, order: { tenantId: access.tenantId } }, include: { items: { include: { orderItem: { select: { menuItemId: true } } } } } });
      if (!ticket) throw new KdsConflict("Kitchen ticket not found in this outlet.");
      if ((ticket.status === KOTStatus.SERVED || ticket.status === KOTStatus.CANCELLED) && action !== "undo-bump" && action !== "recall") throw new KdsConflict("This kitchen ticket is already complete.");
      if (ticket.heldAt && action !== "resume" && action !== "recall") throw new KdsConflict("Ticket is on hold. Resume it before changing its items.");
      let updatedItemId: string | undefined;
      let event = "kot:updated";
      let auditAction = `KDS_${action.replaceAll("-", "_").toUpperCase()}`;

      if (action === "item-cycle" || action === "item-86") {
        const item = await tx.kOTItem.findFirst({ where: { id: itemId, kotId: ticketId, kot: { outletId, order: { tenantId: access.tenantId } } }, include: { orderItem: { select: { menuItemId: true, nameSnapshot: true } } } });
        if (!item) throw new KdsConflict("Kitchen item not found in this outlet ticket.");
        if (expectedUpdatedAt && item.updatedAt.toISOString() !== new Date(expectedUpdatedAt).toISOString()) throw new KdsConflict("Kitchen item changed on another screen. Refresh before retrying.");
        const state: KdsItemState = action === "item-86" ? "OUT_OF_STOCK" : nextKdsItemState(item.state as KdsItemState) ?? (() => { throw new KdsConflict("This kitchen item is already in its final state."); })();
        const changed = await tx.kOTItem.updateMany({ where: { id: item.id, updatedAt: item.updatedAt }, data: { state, status: legacyStatus(state) } });
        if (changed.count !== 1) throw new KdsConflict("Kitchen item changed on another screen. Refresh before retrying.");
        updatedItemId = item.id;
        event = action === "item-86" ? "kot:86-item" : "kot:item:updated";
        if (action === "item-86" && item.orderItem.menuItemId) {
          await tx.outletMenuItem.updateMany({ where: { outletId, menuItemId: item.orderItem.menuItemId }, data: { available: false } });
        }
        const states = (await tx.kOTItem.findMany({ where: { kotId: ticketId }, select: { state: true } })).map((line) => line.state as KdsItemState);
        const status = ticketStatus(states);
        await tx.kOT.update({ where: { id: ticketId }, data: {
          status,
          ...(status === KOTStatus.PREPARING && !ticket.startedAt ? { startedAt: new Date() } : {}),
          ...(status === KOTStatus.READY ? { readyAt: new Date() } : {}),
          ...(status === KOTStatus.SERVED || status === KOTStatus.CANCELLED ? { servedAt: new Date() } : {}),
          ...(status === KOTStatus.SERVED ? { undoBumpUntil: new Date(Date.now() + 5_000) } : {}),
          ...(status !== KOTStatus.SERVED && status !== KOTStatus.CANCELLED ? { servedAt: null, undoBumpUntil: null } : {}),
        } });
        if (action === "item-cycle" || action === "item-86") await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: auditAction, entityType: "KOTItem", entityId: item.id, before: { state: item.state }, after: { state, menuItemId: item.orderItem.menuItemId, itemName: item.orderItem.nameSnapshot } } });
      } else if (action === "start-all") {
        if (ticket.status === KOTStatus.SERVED || ticket.status === KOTStatus.CANCELLED || !ticket.items.some((line) => line.state === "QUEUED")) throw new KdsConflict("This ticket has no queued items to start.");
        await tx.kOTItem.updateMany({ where: { kotId: ticketId, state: "QUEUED" }, data: { state: "COOKING", status: KOTStatus.PREPARING } });
        await tx.kOT.update({ where: { id: ticketId }, data: { status: KOTStatus.PREPARING, startedAt: ticket.startedAt ?? new Date() } });
      } else if (action === "bump-ticket") {
        if (ticket.heldAt) throw new KdsConflict("Resume this ticket before bumping it.");
        if (ticket.status === KOTStatus.SERVED || ticket.status === KOTStatus.CANCELLED) throw new KdsConflict("This kitchen ticket is already complete.");
        const states = ticket.items.map((line) => line.state as KdsItemState);
        if (!states.some((state) => state === "READY" || state === "BUMPED") || states.some((state) => state !== "READY" && state !== "BUMPED" && state !== "OUT_OF_STOCK")) throw new KdsConflict("Every active item must be ready before bumping this ticket.");
        await tx.kOTItem.updateMany({ where: { kotId: ticketId, state: "READY" }, data: { state: "BUMPED", status: KOTStatus.READY } });
        await tx.kOT.update({ where: { id: ticketId }, data: { status: KOTStatus.SERVED, servedAt: new Date(), undoBumpUntil: new Date(Date.now() + 5_000) } });
      } else if (action === "undo-bump") {
        if (!ticket.undoBumpUntil || ticket.undoBumpUntil < new Date() || ticket.status !== KOTStatus.SERVED) throw new KdsConflict("The 5-second undo window has expired.");
        await tx.kOTItem.updateMany({ where: { kotId: ticketId, state: "BUMPED" }, data: { state: "READY", status: KOTStatus.READY } });
        await tx.kOT.update({ where: { id: ticketId }, data: { status: KOTStatus.READY, servedAt: null, undoBumpUntil: null } });
      } else if (action === "hold") {
        if (ticket.status === KOTStatus.SERVED || ticket.status === KOTStatus.CANCELLED || ticket.heldAt) throw new KdsConflict("This ticket cannot be put on hold in its current state.");
        await tx.kOT.update({ where: { id: ticketId }, data: { heldAt: new Date(), holdReason: String(reason).trim() } });
      } else if (action === "resume") {
        if (!ticket.heldAt) throw new KdsConflict("This ticket is not on hold.");
        const elapsed = Math.max(0, Math.floor((Date.now() - ticket.heldAt.getTime()) / 1000));
        await tx.kOT.update({ where: { id: ticketId }, data: { heldAt: null, holdReason: null, holdDurationSeconds: { increment: elapsed } } });
      } else if (action === "recall") {
        if (ticket.status !== KOTStatus.SERVED || !ticket.servedAt || ticket.servedAt < new Date(Date.now() - 30 * 60_000)) throw new KdsConflict("Only tickets bumped in the last 30 minutes can be recalled.");
        await tx.kOTItem.updateMany({ where: { kotId: ticketId, state: "BUMPED" }, data: { state: "READY", status: KOTStatus.READY } });
        await tx.kOT.update({ where: { id: ticketId }, data: { status: KOTStatus.READY, servedAt: null, undoBumpUntil: null } });
        event = "kot:recalled";
      }

      if (!["hold", "resume"].includes(action)) {
        const orderTickets = await tx.kOT.findMany({ where: { orderId: ticket.orderId, outletId }, select: { status: true } });
        const terminal = orderTickets.every((entry) => entry.status === KOTStatus.SERVED || entry.status === KOTStatus.CANCELLED);
        const ready = orderTickets.every((entry) => entry.status === KOTStatus.READY || entry.status === KOTStatus.SERVED || entry.status === KOTStatus.CANCELLED);
        const orderStatus = terminal && orderTickets.some((entry) => entry.status === KOTStatus.SERVED)
          ? OrderStatus.SERVED
          : ready && orderTickets.some((entry) => entry.status === KOTStatus.READY || entry.status === KOTStatus.SERVED)
            ? OrderStatus.READY : OrderStatus.PREPARING;
        await tx.order.updateMany({ where: { id: ticket.orderId, outletId, tenantId: access.tenantId, status: { notIn: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } }, data: { status: orderStatus } });
      }
      if (action !== "item-cycle" && action !== "item-86") await tx.auditLog.create({ data: { tenantId: access.tenantId, outletId, userId: access.user.id, action: auditAction, entityType: "KOT", entityId: ticketId, after: { action, itemId: updatedItemId, reason: action === "hold" ? String(reason).trim() : undefined } } });
      const savedTicket = await tx.kOT.findFirstOrThrow({ where: { id: ticketId, outletId }, include: { items: { select: { id: true, state: true, updatedAt: true } } } });
      const response = safeJson({ ticketId, status: savedTicket.status, heldAt: savedTicket.heldAt, undoBumpUntil: savedTicket.undoBumpUntil, items: savedTicket.items });
      await tx.kOTMutation.create({ data: { outletId, ticketId, userId: access.user.id, clientMutationId, action, requestHash, response } });
    return { response, event, orderId: ticket.orderId };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    void publishOutletEvent(access.tenantId, outletId, outcome.event, { ticketId, action, itemId: itemId || undefined });
    void publishOutletEvent(access.tenantId, outletId, "order:updated", { orderId: outcome.orderId, action: "kds-updated" });
    if (action === "item-86") void publishOutletEvent(access.tenantId, outletId, "menu:updated", { itemId, action: "out-of-stock" });
    return NextResponse.json({ ...outcome.response as Record<string, unknown>, replayed: false });
  } catch (error) {
    if (error instanceof KdsConflict) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof RequestInputError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      if (replayContext) {
        const prior = await prisma.kOTMutation.findUnique({ where: { outletId_clientMutationId: { outletId: replayContext.outletId, clientMutationId: replayContext.clientMutationId } } }).catch(() => null);
        if (prior?.userId === replayContext.userId && prior.requestHash === replayContext.requestHash) return NextResponse.json({ ...(prior.response as Record<string, unknown> ?? {}), replayed: true });
      }
      return NextResponse.json({ error: "A matching kitchen action was submitted already. Refresh the ticket." }, { status: 409 });
    }
    if (typeof error === "object" && error && "code" in error && error.code === "P2034") return NextResponse.json({ error: "Ticket changed while this action was saving. Refresh and retry." }, { status: 409 });
    console.error("KORA KDS action failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Could not update kitchen ticket." }, { status: 500 });
  }
}
