import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PACK_IMAGES, packImageSrc, packInitials, packKey, type PackKey } from "./pack-image";

describe("packKey", () => {
  it.each([
    ["Prismatic Evolutions Booster", "prismatic-evolutions"],
    ["Black Bolt", "black-bolt"],
    ["Pokémon 151", "scarlet-violet-151"],
    ["Scarlet & Violet 151 Booster", "scarlet-violet-151"],
    ["151C Surprise (kinesisk)", "151c-surprise-cn"],
    ["Mystery Pack", "mystery-pack"],
    ["Mystery Pack Premium", "mystery-pack-premium"],
    ["OP13 JP", "op13-jp"],
    ["One Piece OP-13", "op13-en"],
    ["Mega Dream ex", "mega-dream-ex-jp"],
    ["30th Celebration", "30th-celebration"],
    ["Surging Sparks", "surging-sparks"],
    ["Destin Rivals", "destined-rivals"],
    ["White Flair", "white-flare"],
    ["Journey Together", "journey-together"],
    ["Obsidian Flames", "obsidian-flames"],
    ["Paldea Evolved", "paldea-evolved"],
    ["Paradox Rift", "paradox-rift"],
    ["Temporal Forces", "temporal-forces"],
    ["Twilight Masquerade", null],
  ] as const)("%s → %s", (title, key) => {
    expect(packKey(title)).toBe(key);
  });

  it("ingen bild för okända och tomma titlar", () => {
    expect(packKey("Okänd produkt")).toBeNull();
    expect(packKey("")).toBeNull();
    expect(packKey(null)).toBeNull();
    expect(packImageSrc("Okänd")).toBeNull();
    expect(packImageSrc("Black Bolt")).toBe("/packs/black-bolt.webp");
  });

  it("varje nyckel har en bild i public/packs", () => {
    for (const key of Object.keys(PACK_IMAGES) as PackKey[]) {
      expect(existsSync(path.join(process.cwd(), "public", "packs", `${key}.webp`))).toBe(true);
    }
  });

  it("initialer för plattan utan bild", () => {
    expect(packInitials("Journey Together")).toBe("JT");
    expect(packInitials("Lorcana: Into the Inklands")).toBe("LI");
    expect(packInitials("Okänd")).toBe("OK");
    expect(packInitials("")).toBe("");
  });
});
