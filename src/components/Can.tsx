import type { ReactNode } from "react";
import { can } from "@/lib/permissions";

export function Can({
  permissions,
  permission,
  children,
  fallback = null,
}: {
  permissions: readonly string[];
  permission: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return can({ permissions }, permission) ? children : fallback;
}
