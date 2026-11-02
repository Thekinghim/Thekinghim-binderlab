/**
 * Seed-data för utveckling, demo och tester. Se src/seed/catalog.ts för
 * facit och scripts/db/seed.ts för hur seeden körs.
 *
 * run-seed.ts (databasdelen) exporteras inte härifrån, eftersom den drar in
 * importen (server-only). Importera den direkt.
 */

export * from "./catalog";
export * from "./random";
export * from "./orders";
export * from "./awish-csv";
export * from "./stock";
