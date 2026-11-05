import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import { hideInDemo } from "@/server/demo/pages";
import { requireUser } from "@/server/session";

import { DesignSystemPage } from "./design-system-page";
import { parseThemeTokens } from "./tokens";

export const metadata: Metadata = { title: "Designsystem" };

const root = process.cwd();

async function countFiles(dir: string, skip: ReadonlyArray<string> = []): Promise<number> {
  try {
    const files = await readdir(path.join(root, dir));
    return files.filter((f) => f.endsWith(".tsx") && !f.includes(".test.") && !skip.includes(f))
      .length;
  } catch {
    return 0;
  }
}

/**
 * Serverdelen läser tokens.css och räknar komponenterna, så att
 * färgtabellen, kontrasterna och kolofonen alltid följer källan.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Bara för inloggade (även proxyn kräver det).
  await requireUser();
  // Internt: inte i en demo (Demo för kunder).
  await hideInDemo();
  // Sidan läser periodvalet ur URL:en, så den renderas per begäran.
  await searchParams;
  const css = await readFile(path.join(root, "src/styles/tokens.css"), "utf8");
  const tokens = parseThemeTokens(css);
  const components = await countFiles("src/components/ui");
  return <DesignSystemPage tokens={tokens} counts={{ components }} />;
}
