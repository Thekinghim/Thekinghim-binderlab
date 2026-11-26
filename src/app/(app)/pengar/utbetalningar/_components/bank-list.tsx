"use client";

import { Button } from "@/components/v2/button";
import { Sheet } from "@/components/v2/sheet";
import { toastV2 } from "@/components/v2/toast";

import { krExact } from "../../_components/fmt";

export type BankRow = {
  name: string;
  orgNumber: string;
  bankgiro: string;
  amountOre: number;
  message: string;
};

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toastV2(`${what} kopierat`, { tone: "success" });
  } catch {
    toastV2("Kunde inte kopiera", { tone: "critical" });
  }
}

/** Ett värde med en kopieraknapp (bankgiro, belopp, meddelande). */
function CopyValue({
  label,
  value,
  copyText,
}: {
  label: string;
  value: string;
  /** Texten som kopieras (standard: value). null: inget att kopiera. */
  copyText?: string | null;
}) {
  if (!value) return null;
  const text = copyText === undefined ? value : copyText;
  return (
    <div className="ut-bank-v">
      <span>
        <small>{label}</small>
        <b>{value}</b>
      </span>
      {text ? (
        <Button size="sm" touch onClick={() => void copy(text, label)}>
          Kopiera
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Betallistan i appen (telefonen): samma rader som CSV-filen för banken, med kopieraknappar
 * för bankgiro, belopp och meddelande, så att man kan betala i bankappen utan en fil.
 */
export function BankList({ rows }: { rows: readonly BankRow[] }) {
  return (
    <Sheet
      title="Betallista"
      description={`${rows.length} att betala`}
      trigger={
        <Button size="lg" data-testid="bank-list">
          Visa betallista
        </Button>
      }
    >
      <ul className="ut-bank">
        {rows.map((r) => (
          <li key={`${r.name}-${r.bankgiro}-${r.message}`}>
            <div className="ut-bank-h">
              <b>{r.name}</b>
              {r.orgNumber ? <small>{r.orgNumber}</small> : null}
            </div>
            <CopyValue
              label="Bankgiro"
              value={r.bankgiro || "Saknas"}
              copyText={r.bankgiro || null}
            />
            <CopyValue
              label="Belopp"
              value={krExact(r.amountOre)}
              // Bankappen vill ha talet utan "kr" och mellanslag.
              copyText={(r.amountOre / 100).toFixed(2).replace(".", ",")}
            />
            <CopyValue label="Meddelande" value={r.message} />
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
