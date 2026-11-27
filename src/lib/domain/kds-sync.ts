export type KdsSyncAction = {
  clientMutationId: string;
  itemId?: string;
  expectedUpdatedAt?: string;
  lastError?: string;
  waitingForPrevious?: boolean;
};

export type KdsSyncResponse =
  | { ok: true; items?: Array<{ id: string; updatedAt: string }> }
  | { ok: false; error: string };

export async function reconcileKdsActionQueue<T extends KdsSyncAction>(
  queued: T[],
  dependencies: {
    send: (action: T) => Promise<KdsSyncResponse>;
    remove: (clientMutationId: string) => Promise<void>;
    prepare: (action: T) => Promise<void>;
    recordError: (clientMutationId: string, message: string) => Promise<void>;
    isBlocked?: (clientMutationId: string) => boolean;
  },
) {
  const unresolved: T[] = [];
  const committedIds: string[] = [];
  const latestItemVersion = new Map<string, string>();
  let completed = 0;
  let statusWriteFailedFor: string | null = null;

  const waitForPrevious = (actions: T[]) => actions.map((action) => ({
    ...action,
    lastError: "Waiting for the previous kitchen action to be reviewed.",
    waitingForPrevious: true,
  }));

  for (let index = 0; index < queued.length; index++) {
    const action = queued[index];
    if (action.lastError || dependencies.isBlocked?.(action.clientMutationId)) {
      unresolved.push(...queued.slice(0, index));
      unresolved.push({ ...action, lastError: action.lastError ?? "Sync status could not be saved. Retry or discard this action.", waitingForPrevious: false });
      unresolved.push(...waitForPrevious(queued.slice(index + 1)));
      break;
    }

    const versionedAction = action.itemId && latestItemVersion.has(action.itemId)
      ? { ...action, expectedUpdatedAt: latestItemVersion.get(action.itemId) }
      : action;
    if (versionedAction.expectedUpdatedAt !== action.expectedUpdatedAt) {
      try { await dependencies.prepare(versionedAction as T); }
      catch {
        statusWriteFailedFor = action.clientMutationId;
        unresolved.push(...queued.slice(0, index));
        unresolved.push({ ...action, lastError: "The next kitchen action version could not be saved locally. Retry after device storage recovers.", waitingForPrevious: false });
        unresolved.push(...waitForPrevious(queued.slice(index + 1)));
        break;
      }
    }
    try {
      const response = await dependencies.send(versionedAction as T);
      if (response.ok) {
        for (const item of response.items ?? []) latestItemVersion.set(item.id, item.updatedAt);
        committedIds.push(action.clientMutationId);
        completed++;
        continue;
      }

      try { await dependencies.recordError(action.clientMutationId, response.error); }
      catch { statusWriteFailedFor = action.clientMutationId; }
      unresolved.push({ ...action, lastError: response.error, waitingForPrevious: false });
      unresolved.unshift(...queued.slice(0, index));
      unresolved.push(...waitForPrevious(queued.slice(index + 1)));
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection interrupted before sync.";
      try { await dependencies.recordError(action.clientMutationId, message); }
      catch { statusWriteFailedFor = action.clientMutationId; }
      unresolved.push({ ...action, lastError: message, waitingForPrevious: false });
      unresolved.unshift(...queued.slice(0, index));
      unresolved.push(...waitForPrevious(queued.slice(index + 1)));
      break;
    }
  }

  if (unresolved.length === 0) {
    for (let index = 0; index < committedIds.length; index++) {
      try { await dependencies.remove(committedIds[index]); }
      catch {
        statusWriteFailedFor = committedIds[index];
        unresolved.push(...queued.slice(index));
        break;
      }
    }
  }

  return { unresolved, completed, statusWriteFailedFor };
}
