/**
 * Räknar ut vilka fack i Awish som ska uppdateras när Binderlab har registrerat en
 * påfyllning. Ren funktion: ingen nätverk, ingen databas.
 *
 * Varför: ägaren fyller på och registrerar bara i Binderlabs app. Binderlab vet då hur
 * många pack varje titel har i automaten (maskinens lagerplats). Awish vet inte om
 * påfyllningen förrän någon skriver in antalet där. Den här funktionen jämför Binderlabs
 * antal per titel med Awishs fack och säger vilka fack som ska sättas till vilket antal.
 *
 * Regler:
 *  - Vi HÖJER bara. Awishs antal sjunker av försäljning, och Awish äger försäljningen; vi
 *    skriver aldrig ner ett fack (då skulle vi kunna radera en försäljning som skett efter
 *    vår läsning). Behöver ett fack sänkas gör Awish det själv vid nästa köp.
 *  - En titel kan ligga i flera fack. Vi fyller facken i tur och ordning upp till varje
 *    facks kapacitet, så att summan blir Binderlabs antal (eller så nära det går om
 *    kapaciteten inte räcker).
 *  - Bara fack som har en vara (good) och vars antal faktiskt ändras tas med.
 *  - Titlar som inte finns som fack i Awish hoppas över och rapporteras som "okänt fack".
 *  - Mystery packs (`mystery`): ett mystery-fack fylls bara på när det är tomt (oddsen gäller
 *    per omgång). Packen läggs bara i fack med 0 pack i Awish; ett fack som har pack kvar
 *    rörs inte. Finns inget tomt fack hålls påfyllningen tillbaka och titeln rapporteras i
 *    `mysteryHeldBack` (dagliga kontrollen varnar då i stället för att larma).
 */

import { comparableText } from "@/import/adapter";

import type { AwishWebProduct } from "./web-client";

/** Binderlabs antal per titel i en automat (titelns namn + antal pack). */
export interface MachineTitleQuantity {
  readonly titleName: string;
  readonly quantity: number;
  /** Mystery pack: fylls bara i tomma fack. */
  readonly mystery?: boolean;
}

/** Ett fack som ska sättas till ett nytt antal i Awish. */
export interface AwishProductUpdate {
  readonly productId: number;
  readonly goodId: number | null;
  readonly status: boolean;
  readonly currentInventory: number;
  /** Fackets antal före ändringen (för loggning). */
  readonly previousInventory: number;
  readonly titleName: string;
}

export interface PushPlan {
  readonly updates: AwishProductUpdate[];
  /** Titlar i Binderlab som inte har något fack i Awish. */
  readonly titlesWithoutSlot: string[];
  /** Mystery packs vars påfyllning inte skickades: inget tomt fack i Awish. */
  readonly mysteryHeldBack: string[];
}

function key(name: string): string {
  return comparableText(name).toLowerCase();
}

/**
 * Planerar uppdateringarna. `wantByTitle` är Binderlabs antal per titel (efter påfyllning);
 * `products` är Awishs fack för automaten.
 */
export function planAwishPush(
  wantByTitle: readonly MachineTitleQuantity[],
  products: readonly AwishWebProduct[],
): PushPlan {
  // Fack per titelnyckel, i facknummer-ordning så fördelningen blir förutsägbar.
  const slotsByTitle = new Map<string, AwishWebProduct[]>();
  for (const p of products) {
    if (p.goodName == null) continue;
    const k = key(p.goodName);
    if (k === "") continue;
    const list = slotsByTitle.get(k) ?? [];
    list.push(p);
    slotsByTitle.set(k, list);
  }
  for (const list of slotsByTitle.values()) {
    list.sort((a, b) => a.id - b.id);
  }

  const updates: AwishProductUpdate[] = [];
  const titlesWithoutSlot: string[] = [];
  const mysteryHeldBack: string[] = [];

  for (const want of wantByTitle) {
    const k = key(want.titleName);
    const slots = slotsByTitle.get(k);
    if (!slots || slots.length === 0) {
      // En titel med 0 pack som automaten inte säljer är inget problem: rapportera bara
      // titlar som faktiskt har pack i Binderlab men inget fack i Awish.
      if (want.quantity > 0) titlesWithoutSlot.push(want.titleName);
      continue;
    }
    // Hur många pack saknas i Awish jämfört med Binderlab? Awishs antal sjunker av
    // försäljning, så vi lägger bara till skillnaden och rör aldrig ett fack neråt.
    const wanted = Math.max(0, Math.floor(want.quantity));
    const inAwish = slots.reduce((sum, s) => sum + Math.max(0, s.currentInventory), 0);
    let toAdd = wanted - inAwish;
    if (toAdd <= 0) continue;

    if (want.mystery) {
      // Bara tomma fack; ett mystery-fack med pack kvar fylls inte på.
      const empty = slots.filter((x) => Math.max(0, x.currentInventory) === 0);
      for (let i = 0; i < empty.length && toAdd > 0; i += 1) {
        const slot = empty[i]!;
        const isLast = i === empty.length - 1;
        const add =
          slot.capacity == null
            ? isLast
              ? toAdd
              : 0
            : Math.min(toAdd, Math.max(0, slot.capacity));
        if (add <= 0) continue;
        toAdd -= add;
        updates.push({
          productId: slot.id,
          goodId: slot.goodId,
          status: slot.status,
          currentInventory: add,
          previousInventory: slot.currentInventory,
          titleName: want.titleName,
        });
      }
      if (toAdd > 0) mysteryHeldBack.push(want.titleName);
      continue;
    }

    // Lägg packen i facken i tur och ordning, upp till ledig plats (kapacitet − antal).
    // Sista facket får resten även om kapaciteten är okänd, så inget pack tappas bort.
    for (let i = 0; i < slots.length && toAdd > 0; i += 1) {
      const slot = slots[i]!;
      const isLast = i === slots.length - 1;
      const free =
        slot.capacity == null
          ? toAdd
          : Math.max(0, slot.capacity - Math.max(0, slot.currentInventory));
      const add = isLast && slot.capacity == null ? toAdd : Math.min(toAdd, free);
      if (add <= 0) continue;
      const next = Math.max(0, slot.currentInventory) + add;
      toAdd -= add;
      updates.push({
        productId: slot.id,
        goodId: slot.goodId,
        status: slot.status,
        currentInventory: next,
        previousInventory: slot.currentInventory,
        titleName: want.titleName,
      });
    }
  }

  return { updates, titlesWithoutSlot, mysteryHeldBack };
}
