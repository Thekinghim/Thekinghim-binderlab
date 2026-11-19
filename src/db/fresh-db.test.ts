/**
 * Anslutningen som bevisligen svarar (freshDbWith): en död anslutning efter att funktionen
 * legat fryst får inte hänga jobbet tills det dödas utan spår.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { freshDbWith } = await import("./client");

const never = () => new Promise<never>(() => {});

describe("freshDbWith", () => {
  it("en anslutning som svarar används som den är", async () => {
    const drop = vi.fn();
    const db = await freshDbWith({ get: () => "a", drop, ping: async () => 1, timeoutMs: 20 });
    expect(db).toBe("a");
    expect(drop).not.toHaveBeenCalled();
  });

  it("en anslutning som hänger byts ut mot en ny inom tidsgränsen", async () => {
    const pool = ["död", "ny"];
    let current = 0;
    const drop = vi.fn(() => {
      current = 1;
    });
    const started = Date.now();
    const db = await freshDbWith({
      get: () => pool[current]!,
      drop,
      ping: (x) => (x === "död" ? never() : Promise.resolve(1)),
      timeoutMs: 30,
    });
    expect(db).toBe("ny");
    expect(drop).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("en anslutning som kastar byts också ut", async () => {
    let current = "trasig";
    const db = await freshDbWith({
      get: () => current,
      drop: () => {
        current = "ny";
      },
      ping: (x) => (x === "trasig" ? Promise.reject(new Error("ECONNRESET")) : Promise.resolve(1)),
      timeoutMs: 30,
    });
    expect(db).toBe("ny");
  });

  it("svarar inte heller den nya blir det ett fel på en gång, inte en väntan", async () => {
    const started = Date.now();
    await expect(
      freshDbWith({ get: () => "x", drop: () => {}, ping: never, timeoutMs: 20 }),
    ).rejects.toThrow("Databasen svarar inte.");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
