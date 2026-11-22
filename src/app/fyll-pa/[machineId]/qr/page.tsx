import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";

import { and, eq, gte, isNull, lte, or } from "drizzle-orm";

import * as s from "@/db/schema";
import { getServerEnv } from "@/lib/env";
import { withUserDbFor } from "@/server/access";
import { OPERATOR_ROLES, requireContextRole } from "@/server/data/core";
import { resolveAppBaseUrl } from "@/server/request-info";

import { currentViewer } from "@/app/(app)/lager/_lib/session";

import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "QR för påfyllning" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * QR-kod att sätta på automaten: kameran öppnar Fyll på för just den automaten
 * (/fyll-pa/<id>). Koden ritas på servern som SVG (paketet qrcode, MIT). Ägare och admin.
 */
export default async function QrPage({ params }: { params: Promise<{ machineId: string }> }) {
  const { machineId } = await params;
  if (!UUID.test(machineId)) notFound();
  const ctx = await requireContextRole(OPERATOR_ROLES);
  const viewer = await currentViewer();
  const machine = await withUserDbFor(viewer.user, async (tx) => {
    const [m] = await tx
      .select({ id: s.machines.id, code: s.machines.code, name: s.machines.name })
      .from(s.machines)
      .where(and(eq(s.machines.organizationId, ctx.organization.id), eq(s.machines.id, machineId)));
    if (!m) return null;
    const [store] = await tx
      .select({ name: s.stores.name })
      .from(s.machinePlacements)
      .innerJoin(
        s.stores,
        and(
          eq(s.stores.organizationId, s.machinePlacements.organizationId),
          eq(s.stores.id, s.machinePlacements.storeId),
        ),
      )
      .where(
        and(
          eq(s.machinePlacements.organizationId, ctx.organization.id),
          eq(s.machinePlacements.machineId, machineId),
          lte(s.machinePlacements.validFrom, ctx.today),
          or(isNull(s.machinePlacements.validTo), gte(s.machinePlacements.validTo, ctx.today)),
        ),
      )
      .limit(1);
    return { ...m, store: store?.name ?? null };
  });
  if (!machine) notFound();

  const url = `${resolveAppBaseUrl(getServerEnv(), await headers())}/fyll-pa/${machine.id}`;
  const svg = await QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" },
  });

  return (
    <div className="flex min-h-dvh flex-col items-center gap-6 px-4 pt-[calc(24px+env(safe-area-inset-top))] pb-10">
      <div className="flex w-full items-center justify-between print:hidden">
        <Link href="/automater" className="v2-btn quiet touch -ml-2.5 text-v2-mute">
          ← Automater
        </Link>
        <PrintButton />
      </div>
      {/* Alltid svart på vitt (skrivs ut och skannas), oavsett tema. */}
      <div
        className="flex w-full max-w-[360px] flex-col items-center gap-4 rounded-v2-lg p-6 shadow-[0_0_0_1px_var(--v2-line)] print:shadow-[0_0_0_1px_#e3e3e3]"
        style={{ background: "#ffffff", color: "#000000" }}
      >
        <p className="text-v2-sm font-[550]">Fyll på · Binderlab</p>
        <div
          className="w-full [&>svg]:h-auto [&>svg]:w-full"
          role="img"
          aria-label={`QR-kod till Fyll på för ${machine.code}`}
          // SVG:n kommer från qrcode-paketet och innehåller bara vår egen adress.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <p className="text-center text-v2-2xl font-[650]">{machine.store ?? machine.name}</p>
        <p className="tnum text-v2-md font-[550]">{machine.code}</p>
        <p className="text-center text-v2-md">Skanna med kameran och fyll på.</p>
      </div>
      <p className="max-w-[360px] text-center text-v2-xs break-all text-v2-mute print:hidden">
        {url}
      </p>
    </div>
  );
}
