import type { Plan } from "@prisma/client";

export type PlanResource = "outlets" | "users";

export const PLAN_LIMITS: Record<Plan, Record<PlanResource, number>> = {
  FREE: { outlets: 1, users: 1 },
  PLUS: { outlets: 1, users: 10 },
  PRO: { outlets: 10, users: 50 },
};

export function planLimit(plan: Plan, resource: PlanResource) {
  return PLAN_LIMITS[plan][resource];
}

export function exceedsPlanLimit(plan: Plan, resource: PlanResource, currentCount: number) {
  return !Number.isSafeInteger(currentCount) || currentCount < 0 || currentCount >= planLimit(plan, resource);
}
