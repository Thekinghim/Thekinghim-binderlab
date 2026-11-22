/**
 * Fyll på i V2 (ägarens val A): facken är rutor. Ett tryck fyller facket, ett tryck på en vald
 * ruta öppnar arket med stegaren ("En mindre …"), Töm och "Fel antal i automaten?".
 */

import type { Locator, Page } from "./browser";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rutan för en titel: knappen vars namn är "<titel>, 4 av 10 i automaten…". */
export function fillTile(page: Page, title: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^${escape(title)}, `) });
}

/** Antalet på Klar ("Klar · 6 pack" / "Done · 6 packs"), ur knappens namn. */
export async function doneCount(page: Page, name: RegExp = /^Klar/): Promise<number> {
  const button = page.getByRole("button", { name });
  const label = (await button.getAttribute("aria-label")) ?? (await button.innerText());
  return Number(label.replace(/\D/g, "") || "0");
}

/** Stänger arket för ett fack (knappen Stäng nederst i arket). */
export async function closeSlotSheet(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Stäng", exact: true }).last().click();
  await dialog.waitFor({ state: "hidden" });
}

/**
 * Stegarens fält i arket för en titel. Arket (dialogen) heter som titeln, så fältet söks
 * inne i arket.
 */
export function sheetInput(page: Page, title: string): Locator {
  return page.getByRole("dialog").getByLabel(title, { exact: true });
}

/**
 * Väljer ett antal i första rutan som går: ett tryck fyller facket, eller (när trycket öppnar
 * arket, t.ex. inget i lagret) ett till med + i arket. Svarar med rutans namn.
 */
export async function fillFirstTile(page: Page): Promise<string> {
  const tiles = page.locator("button.tile");
  await tiles.first().waitFor();
  const n = await tiles.count();
  for (let i = 0; i < n; i++) {
    const tile = tiles.nth(i);
    if ((await tile.getAttribute("aria-pressed")) === "true") continue;
    await tile.click();
    const dialog = page.getByRole("dialog");
    // Antingen blir rutan vald, eller så öppnas arket (inget att fylla).
    for (let t = 0; t < 40; t++) {
      if (await dialog.isVisible()) {
        // Inget att fylla med ett tryck (fullt, inget i lagret): ett till med + i arket.
        const more = dialog.getByRole("button", { name: /^En till / });
        if ((await more.getAttribute("disabled")) === null) {
          await more.click();
          await closeSlotSheet(page);
          if ((await tile.getAttribute("aria-pressed")) === "true") {
            return (await tile.getAttribute("aria-label")) ?? "";
          }
        } else {
          await closeSlotSheet(page);
        }
        break;
      }
      if ((await tile.getAttribute("aria-pressed")) === "true") {
        return (await tile.getAttribute("aria-label")) ?? "";
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("Ingen ruta gick att fylla.");
}
