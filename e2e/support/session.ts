/**
 * Inloggning och testdata för e2e-testerna. Fixturen kommer från e2e/global-setup.ts
 * (vitest provide/inject).
 */

import { inject } from "vitest";

import type { Page } from "./browser";
import type { E2eFixture } from "./fixture";

declare module "vitest" {
  export interface ProvidedContext {
    e2e: E2eFixture;
  }
}

export function e2e(): E2eFixture {
  return inject("e2e");
}

/** Fyller i inloggningen och skickar (utan att vänta på resultatet). */
export async function submitLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/logga-in");
  await page.getByLabel("E-postadress").fill(email);
  await page.getByLabel("Lösenord").fill(password);
  await page.getByRole("button", { name: "Logga in", exact: true }).click();
}

/** Lösenordet för en av fixturens användare. */
export function passwordFor(email: string): string {
  return email === e2e().users.refiller ? e2e().refillerPassword : e2e().password;
}

/** Loggar in och väntar tills appen har tagit över (bort från /logga-in). */
export async function login(page: Page, email: string): Promise<void> {
  await submitLogin(page, email, passwordFor(email));
  await page.waitForURL((url) => !url.pathname.startsWith("/logga-in"));
}
