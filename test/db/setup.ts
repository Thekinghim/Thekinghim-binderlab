/**
 * globalSetup för test:db: återställer binderlab_test (drop/create, auth-shim,
 * alla migreringar) en gång innan testfilerna körs.
 */

import { config } from "dotenv";

import { resetDatabase } from "../../src/db/migrator";

export default async function setup(): Promise<void> {
  config({ path: [".env.local", ".env"], quiet: true });
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error("DATABASE_URL_TEST saknas.");
  }
  await resetDatabase(url);
}
