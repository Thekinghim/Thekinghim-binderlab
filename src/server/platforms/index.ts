/**
 * Registret över automatplattformar (bara servern). Allt som ska bero på vilken plattform
 * en datakälla hör till går via `platformFor`, så att en ny plattform bara behöver en ny
 * fil här och en rad i registret. Se README.md i den här mappen.
 */

import "server-only";

import type { FetchResult } from "@/import/adapter";
import { ImportValidationError } from "@/import/errors";

import { awishPlatform } from "./awish";
import { platformIdOf, providerAcceptsFiles } from "./catalog";
import { manualCsvPlatform } from "./manual-csv";
import type { MachinePlatform, PlatformFileInput, PlatformId } from "./types";

export * from "./catalog";
export type * from "./types";

const PLATFORMS: Readonly<Record<PlatformId, MachinePlatform<never>>> = {
  awish: awishPlatform as MachinePlatform<never>,
  manual_csv: manualCsvPlatform,
};

/** Plattformen för en datakälla (data_sources.provider), eller null om den är okänd. */
export function platformFor(provider: string): MachinePlatform<never> | null {
  const id = platformIdOf(provider);
  return id === null ? null : PLATFORMS[id];
}

/** Alla plattformar, i visningsordning. */
export function allPlatforms(): MachinePlatform<never>[] {
  return Object.values(PLATFORMS);
}

/**
 * Tolkar en uppladdad fil med datakällans plattform. Kastar ImportValidationError om
 * datakällan inte tar emot filer (t.ex. Awish API-källan).
 */
export async function parsePlatformFile(input: PlatformFileInput): Promise<FetchResult> {
  const platform = platformFor(input.provider);
  if (!platform?.parseFile || !providerAcceptsFiles(input.provider)) {
    throw new ImportValidationError(
      `Datakällan (${input.provider}) tar inte emot filer. Välj en CSV-datakälla.`,
    );
  }
  return platform.parseFile(input);
}
