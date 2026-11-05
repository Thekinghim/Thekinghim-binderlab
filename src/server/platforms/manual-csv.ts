/**
 * "Annan automat (CSV)": plattformen för operatörer vars automater inte är Awish.
 * Ingen anslutning och ingen skrivning; försäljningen laddas upp som CSV under
 * Datakällor och går genom samma pipeline som Awish-orderna.
 */

import "server-only";

import { manualCsvAdapter } from "@/import/adapters/manual-csv";
import { ImportValidationError } from "@/import/errors";

import { PLATFORM_INFO } from "./catalog";
import type { MachinePlatform } from "./types";

export const manualCsvPlatform: MachinePlatform<never> = {
  ...PLATFORM_INFO.manual_csv,
  async parseFile(input) {
    if (input.provider !== "manual_csv") {
      throw new ImportValidationError(
        `Datakällan (${input.provider}) är inte en manuell CSV-källa.`,
      );
    }
    return manualCsvAdapter.fetch({
      context: input.context,
      file: input.file,
      mapping: input.mapping?.delimiter ? { delimiter: input.mapping.delimiter } : undefined,
    });
  },
};
