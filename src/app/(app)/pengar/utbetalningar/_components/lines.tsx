import { Button } from "@/components/v2/button";
import { Notice } from "@/components/v2/notice";
import type { LineView, PayoutView, RecipientRow } from "@/server/payouts/balances";
import { ButtonLink } from "@/components/v2/button";

import { kr, krExact, monthName } from "../../_components/fmt";
import { storeComponentText, type WarningView } from "../_lib/model";
import { PaySheet } from "./pay-sheet";

const pct = (bp: number) => `${Math.round(bp) / 100} %`.replace(".", ",");

/** "Att betala just nu": en rad per mottagare med Betala. */
export function RecipientList({
  recipients,
  ownerLeftOre,
  ownerLineIds,
  today,
}: {
  recipients: readonly RecipientRow[];
  ownerLeftOre: number;
  ownerLineIds: readonly string[];
  today: string;
}) {
  return (
    <div className="ut-rows" data-testid="recipients">
      {recipients.map((r) => (
        <div key={r.key} className="ut-row" data-recipient={r.name}>
          <div>
            <div className="nm">{r.name}</div>
            <div className="sm">
              {r.kind === "partner" && r.partnerParts
                ? `inköp ${kr(r.partnerParts.reimbOre)} + vinst ${kr(r.partnerParts.profitOre)}`
                : r.kind === "vat_reserve"
                  ? "Lägg undan till momsen"
                  : `Nayax ${[...new Set(r.periodTexts)].join(", ")}`}
            </div>
          </div>
          <div className="am">{krExact(r.leftOre)}</div>
          <div className="go">
            <PaySheet
              name={r.name}
              lineIds={r.lineIds}
              leftOre={r.leftOre}
              today={today}
              verb={r.kind === "vat_reserve" ? "sparad" : "betald"}
              trigger={
                <Button size="md" variant="act" touch data-testid={`pay-${r.kind}`}>
                  {r.kind === "vat_reserve" ? "Lagt undan" : "Betala"}
                </Button>
              }
            />
          </div>
        </div>
      ))}
      {ownerLeftOre !== 0 ? (
        <div className="ut-row" data-recipient="Kvar till dig">
          <div>
            <div className="nm">{ownerLeftOre < 0 ? "Du behöver lägga till" : "Kvar till dig"}</div>
            <div className="sm">
              {ownerLeftOre < 0
                ? "Pengarna från Nayax räckte inte till allt."
                : "Din del av vinsten. Dina egna kostnader betalas härifrån."}
            </div>
          </div>
          <div className={ownerLeftOre < 0 ? "am neg" : "am"}>
            {krExact(Math.abs(ownerLeftOre))}
          </div>
          {ownerLeftOre > 0 && ownerLineIds.length > 0 ? (
            <div className="go">
              <PaySheet
                name="dig"
                lineIds={ownerLineIds}
                leftOre={ownerLeftOre}
                today={today}
                verb="uttaget"
                trigger={
                  <Button size="md" touch>
                    Markera som uttaget
                  </Button>
                }
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Why({ line, payout }: { line: LineView; payout: PayoutView }) {
  const items: { label: string; detail?: string; amount: string }[] = [];
  if (line.stores.length > 0) {
    const many = new Set(line.stores.map((c) => c.storeId)).size > 1;
    for (const c of line.stores) {
      const t = storeComponentText(c);
      items.push({
        label: many ? `${c.storeName}, ${t.label}` : t.label,
        detail: c.settledElsewhere ? `${t.detail} Redan betald under Butiker.` : t.detail,
        amount: t.amount,
      });
    }
  }
  if (line.partner) {
    const p = line.partner;
    items.push({
      label: "Inköpet tillbaka",
      detail: `${p.packs} sålda paket, vårt inköpspris`,
      amount: krExact(p.reimbOre),
    });
    for (const s of p.segments) {
      if (s.agreementId === null) continue;
      items.push({
        label: `${pct(s.bp)} av vinsten`,
        detail: `Vinsten ${krExact(s.profitOre)} efter butikerna, inköpet och momsen`,
        amount: krExact(s.shareOre),
      });
    }
    if (p.carryInOre < 0) {
      items.push({ label: "Förlust från förra gången", amount: krExact(p.carryInOre) });
    }
    if (p.adjustOre) {
      items.push({
        label: "Rättelse från tidigare utbetalningar",
        detail: "Ett inköpspris ändrades efter att de betalats",
        amount: `${p.adjustOre > 0 ? "+" : "−"}${krExact(Math.abs(p.adjustOre))}`,
      });
    }
  }
  if (line.vat) {
    for (const m of line.vat.months) {
      items.push({
        label: `Moms på vinsten, ${monthName(m.month)}`,
        detail:
          line.vat.mode === "vmb"
            ? `20 % av vinsten på paketen (${krExact(m.marginOre)})`
            : `Momsen i försäljningen (${krExact(m.marginOre)})`,
        amount: krExact(m.vatOre),
      });
    }
    if (line.vat.carryInOre > 0) {
      items.push({
        label: "Förlust tidigare",
        detail: "Dras från vinsten innan momsen räknas",
        amount: krExact(-line.vat.carryInOre),
      });
    }
    if (line.vat.adjustOre) {
      items.push({
        label: "Rättelse från tidigare utbetalningar",
        amount: `${line.vat.adjustOre > 0 ? "+" : "−"}${krExact(Math.abs(line.vat.adjustOre))}`,
      });
    }
    if (line.vat.months.length === 0 && !line.vat.adjustOre) {
      items.push({ label: "Ingen moms att spara", amount: "0 kr" });
    }
  }
  if (line.owner) {
    items.push({
      label: "Vinsten",
      detail: "Pengar in − butikerna − inköpet − momsen − det du betalat tillbaka till kunder",
      amount: krExact(line.owner.profitOre),
    });
    if (line.owner.partnerShareOre !== 0) {
      items.push({
        label: "Partnerns del av vinsten",
        amount: krExact(-line.owner.partnerShareOre),
      });
    }
  }
  if (payout.basis === "inferred" && payout.inferredNote && line.kind === "owner") {
    items.push({ label: "Dagarna", detail: payout.inferredNote, amount: "" });
  }
  if (items.length === 0) return null;
  return (
    <details className="ut-why">
      <summary>Varför?</summary>
      {items.map((i, n) => (
        <div key={n} className="ln">
          <span>
            {i.label}
            {i.detail ? <small>{i.detail}</small> : null}
          </span>
          <b>{i.amount}</b>
        </div>
      ))}
    </details>
  );
}

/** "Betala så här": raderna för en utbetalning med Varför? och Markera som betald. */
export function PayoutLines({ payout, today }: { payout: PayoutView; today: string }) {
  const sum = payout.lines.reduce((a, l) => a + l.amountOre, 0);
  return (
    <div className="ut-rows" data-testid="payout-lines">
      {payout.lines.map((l) => {
        const done = l.kind !== "owner" && l.leftOre <= 0;
        const sub =
          l.kind === "partner" && l.partner
            ? `inköp ${kr(l.partner.reimbOre)} + vinst ${kr(l.partner.profitShareOre)}`
            : l.kind === "vat_reserve"
              ? "Lägg undan till momsen"
              : l.kind === "owner"
                ? l.amountOre < 0
                  ? "Du behöver lägga till"
                  : "Kvar till dig"
                : l.kind === "store_owner"
                  ? `${new Set(l.stores.map((c) => c.storeId)).size} butiker`
                  : "Butikens andel";
        return (
          <div key={l.id} className={done ? "ut-row done" : "ut-row"} data-line={l.name}>
            <div>
              <div className="nm">{l.name}</div>
              <div className="sm">
                {sub}
                {done && l.amountOre > 0 ? " · betalt" : ""}
                {l.paidOre > 0 && l.leftOre > 0 ? ` · ${krExact(l.paidOre)} betalt` : ""}
              </div>
            </div>
            <div className={l.amountOre < 0 ? "am neg" : "am"}>{krExact(l.amountOre)}</div>
            <div className="go">
              {l.leftOre > 0 ? (
                <PaySheet
                  name={l.kind === "owner" ? "dig" : l.name}
                  lineIds={[l.id]}
                  leftOre={l.leftOre}
                  today={today}
                  verb={
                    l.kind === "owner" ? "uttaget" : l.kind === "vat_reserve" ? "sparad" : "betald"
                  }
                  trigger={
                    <Button size="md" variant={l.kind === "owner" ? "default" : "act"} touch>
                      {l.kind === "owner" ? "Markera som uttaget" : "Markera som betald"}
                    </Button>
                  }
                />
              ) : null}
            </div>
            <Why line={l} payout={payout} />
          </div>
        );
      })}
      <div className="ut-row sum">
        <div className="nm">Summa</div>
        <div className="am" data-testid="payout-sum">
          {krExact(sum)} {sum === payout.amountOre ? "✓" : ""}
        </div>
      </div>
    </div>
  );
}

export function Warnings({ items }: { items: readonly WarningView[] }) {
  if (items.length === 0) return null;
  return (
    <div className="ut-warns">
      {items.map((w) => (
        <Notice
          key={w.key}
          tone={w.tone}
          action={
            w.action ? (
              <ButtonLink href={w.action.href} size="sm">
                {w.action.label}
              </ButtonLink>
            ) : undefined
          }
        >
          {w.text}
        </Notice>
      ))}
    </div>
  );
}
