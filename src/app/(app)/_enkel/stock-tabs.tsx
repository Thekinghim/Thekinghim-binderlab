import Link from "next/link";

import { STOCK_SUBTABS, type StockSubTabId } from "@/components/shell/simple-view";
import type { Messages } from "@/i18n";
import { cn } from "@/lib/cn";

/**
 * Lagrets tre underflikar i den enkla vyn: Lager, Inköpslista och Inköpspriser. Stora
 * knappar (minst 44 px) i en rad; en lång etikett bryts på två rader i stället för att
 * sidan blir bredare än skärmen.
 */
export function StockTabs({ active, t }: { active: StockSubTabId; t: Messages }) {
  const label: Record<StockSubTabId, string> = {
    stock: t.stock.tabStock,
    buy: t.stock.tabBuy,
    prices: t.stock.tabPrices,
  };
  return (
    <nav aria-label={t.stock.nav}>
      <ul className="grid grid-cols-3 gap-1 rounded-md border border-line-strong bg-surface p-1">
        {STOCK_SUBTABS.map((tab) => {
          const on = tab.id === active;
          return (
            <li key={tab.id} className="min-w-0">
              <Link
                href={tab.href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex min-h-11 w-full items-center justify-center rounded-sm px-1 py-1 text-center text-base leading-tight font-medium text-balance",
                  on ? "bg-inverse text-on-inverse" : "text-muted active:bg-hover",
                )}
              >
                {label[tab.id]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
