import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Etikett och värde i rader (dl), för sammanfattningar som "Period 24 okt. – 22 nov." och
 * "Utan inköpspris 1 828 kr". Etiketten 13 px grå, värdet bläck med tabulära siffror och
 * högerställt. Står i ett Card (CardBody) eller fritt.
 *
 *   <KeyValues items={[{ label: "I dag", value: 2 }, { label: "Beräknat", value: "09:27" }]} />
 */
export function KeyValues({
  items,
  className,
}: {
  items: ReadonlyArray<{ label: ReactNode; value: ReactNode; key?: string }>;
  className?: string;
}) {
  return (
    <dl className={cn("v2-kv", className)}>
      {items.map((it, i) => (
        <div key={it.key ?? (typeof it.label === "string" ? it.label : i)}>
          <dt>{it.label}</dt>
          <dd>{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
