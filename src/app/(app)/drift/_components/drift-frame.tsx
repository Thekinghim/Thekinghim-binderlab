import type { ReactNode } from "react";

import { V2Page, headerDate } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import type { Role } from "@/components/shell/nav";

import { DriftNav } from "./drift-nav";
import "./ops.css";

/**
 * Sidramen för Drifts undersidor (Status, Besök, Påfyllning, Notiser, en automat): V2Page med
 * Automaters underflikar (SubNav) och Drifts egna fyra som segment. Innehållet står i kort med
 * 14 px mellanrum (.v2-stack).
 */
export function DriftFrame({
  ctx,
  title = "Drift",
  sub,
  tools,
  children,
}: {
  ctx: { now: string | number | Date; timeZone: string; role: Role };
  title?: ReactNode;
  sub?: ReactNode;
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <V2Page
      title={title}
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      sub={sub}
      tools={tools}
    >
      <SubNav />
      <div className="v2-stack">
        <DriftNav canRefill={["owner", "admin", "refiller"].includes(ctx.role)} />
        {children}
      </div>
    </V2Page>
  );
}
