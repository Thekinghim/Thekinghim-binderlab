/**
 * Butiksrapporten får ALDRIG visa inköpskostnad, marginal, vinst eller andra butikers
 * siffror. Testet bygger en ögonblicksbild där en annan butik och inköpspriser finns i
 * underlaget, renderar PDF-sidan (samma komponent som /rapport/[id] skriver ut) och
 * mejlet (mallen i src/emails) och söker efter sådana värden i HTML och text.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { renderReportEmail } from "@/emails/report-email";
import { agreement, ord, placement, price, sources } from "@/reports/testing/fixtures";
import { reportEmailProps } from "@/server/reports/email";
import { buildSnapshot, type StoreSnapshot } from "@/server/reports/snapshot";

import { StoreReportDocument } from "./store-report";

const ORG = { id: "org", name: "Binderlab AB", orgNumber: null, timeZone: "Europe/Stockholm" };

function snapshot(): StoreSnapshot {
  const src = sources({
    placements: [
      placement("m-1", "s-1", "2025-01-01", null),
      placement("m-2", "s-2", "2025-01-01", null),
    ],
    orders: [
      ord("2026-09-12", { amountOre: 4900 }),
      ord("2026-10-03", { amountOre: 4900 }),
      ord("2026-10-04", { amountOre: 5900, titleId: "t-b" }),
      ord("2026-10-09", { amountOre: 4900, titleId: "t-c" }),
      // Andra butikens försäljning: 777 kr, ska aldrig synas.
      ord("2026-10-10", { amountOre: 77_700, machineId: "m-2" }),
    ],
    // Inköpspris 13,37 kr: ett belopp som inte kan uppstå på annat sätt.
    prices: [price("t-a", 1337, "2026-01-01"), price("t-b", 1337, "2026-01-01")],
    agreements: [
      agreement("s-1", "2026-01-01", null, { commissionBp: 1200, monthlyRentOre: 50_000 }),
      agreement("s-2", "2026-01-01", null, { monthlyRentOre: 99_900 }),
    ],
  });
  const snap = buildSnapshot({
    type: "butik",
    month: "2026-10",
    organization: ORG,
    sources: src,
    generatedAt: "2026-11-01T05:00:00.000Z",
    storeId: "s-1",
    greeting: "Tack för ett bra samarbete!",
  });
  if (snap.type !== "butik") throw new Error("fel typ");
  return snap;
}

/** Ord och belopp som aldrig får finnas i något som når butiken. */
const FORBIDDEN = [
  /inköp/i,
  /marginal/i,
  /vinst/i,
  /förlust/i,
  /lönsam/i,
  /Mobilia/,
  /Väla/,
  /13,37/,
  /777/,
  /999/,
];

function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#xA0;/g, " ")
    .replace(/\s+/g, " ");
}

describe("butiksrapporten läcker inget", () => {
  const snap = snapshot();

  it("räknar rätt underlag", () => {
    expect(snap.report.sales.revenueOre).toBe(4900 + 5900 + 4900);
    expect(snap.report.compensation.totalOre).toBe(588 + 708 + 588 + 50_000);
  });

  it("PDF-sidan visar ersättningen men inga förbjudna värden", () => {
    const html = renderToStaticMarkup(<StoreReportDocument snapshot={snap} />);
    const text = visibleText(html);
    expect(text).toContain("Nordstan");
    expect(text).toContain("Tack för ett bra samarbete!");
    expect(text).toContain("Er ersättning");
    for (const re of FORBIDDEN) expect(text, String(re)).not.toMatch(re);
  });

  it("mejlet (HTML och text) visar inga förbjudna värden", () => {
    const email = renderReportEmail(
      reportEmailProps(snap, {
        recipientName: "Maria",
        reportUrl: "https://app.test/rapport/x",
        followText: null,
        reportId: "R-TEST01",
        attachments: [{ name: "binderlab-butik-nordstan-2026-10.pdf", size: 120_000 }],
      }),
    );
    expect(email.text).toContain("Hej Maria,");
    expect(email.text).toContain("Nordstan");
    for (const body of [visibleText(email.html), email.text, email.subject, email.preheader]) {
      for (const re of FORBIDDEN) expect(body, String(re)).not.toMatch(re);
    }
  });
});
