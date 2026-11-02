import { describe, expect, it } from "vitest";

import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  parsePasswordHash,
  validateNewPassword,
  verifyPassword,
} from "./password";

describe("lösenordshash (scrypt)", () => {
  it("har formatet scrypt$N$r$p$salt$hash med 64 byte nyckel", async () => {
    const hash = await hashPassword("rätt häftigt lösenord");
    const parts = hash.split("$");
    expect(parts.slice(0, 4)).toEqual(["scrypt", "16384", "8", "1"]);
    expect(Buffer.from(parts[4] ?? "", "base64")).toHaveLength(16);
    expect(Buffer.from(parts[5] ?? "", "base64")).toHaveLength(64);
  });

  it("verifierar rätt lösenord och nekar fel", async () => {
    const hash = await hashPassword("rätt häftigt lösenord");
    expect(await verifyPassword("rätt häftigt lösenord", hash)).toBe(true);
    expect(await verifyPassword("rätt häftigt lösenorD", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("använder nytt salt varje gång", async () => {
    const a = await hashPassword("samma lösenord här");
    const b = await hashPassword("samma lösenord här");
    expect(a).not.toBe(b);
    expect(await verifyPassword("samma lösenord här", a)).toBe(true);
    expect(await verifyPassword("samma lösenord här", b)).toBe(true);
  });

  it("nekar okänd användare (null) och manipulerade hashar", async () => {
    const hash = await hashPassword("ett bra lösenord");
    expect(await verifyPassword("ett bra lösenord", null)).toBe(false);
    const parts = hash.split("$");
    const flipped = Buffer.from(parts[5] ?? "", "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const tampered = [...parts.slice(0, 5), flipped.toString("base64")].join("$");
    expect(await verifyPassword("ett bra lösenord", tampered)).toBe(false);
    for (const bad of [
      "",
      "bcrypt$x",
      hash.replace("scrypt$", "SCRYPT$"),
      hash.replace("$16384$", "$16383$"), // inte en tvåpotens
      hash.replace("$16384$", "$2097152$"), // för stort N (DoS)
      hash.replace("$8$1$", "$99$1$"), // för stort r
      `${hash}$extra`,
      parts.slice(0, 5).join("$") + "$" + Buffer.alloc(32).toString("base64"), // fel längd
    ]) {
      expect(parsePasswordHash(bad)).toBeNull();
      expect(await verifyPassword("ett bra lösenord", bad)).toBe(false);
    }
  });

  it("kontrollerar nya lösenord", () => {
    expect(validateNewPassword("kort")).toMatch(`minst ${MIN_PASSWORD_LENGTH} tecken`);
    expect(validateNewPassword(" ".repeat(20))).toMatch(/mellanslag/);
    expect(validateNewPassword("x".repeat(2000))).toMatch(/för långt/);
    expect(validateNewPassword("ett tillräckligt långt lösenord")).toBeNull();
  });
});
