#!/usr/bin/env node
/**
 * Licenserna för produktionsberoendena, ur node_modules.
 *
 * Vilka paket som är produktionsberoenden (inte bara för utveckling) läses ur
 * package-lock.json (posterna utan "dev": true). Licensen läses ur paketets egen
 * package.json i node_modules ("license", eller den äldre "licenses"); saknas paketet
 * (en plattformsbinär för en annan plattform) används licensen i package-lock.json.
 * Copyleft (GPL, LGPL, AGPL, MPL, EPL, CDDL, EUPL, OSL, CC-BY-SA) och paket utan licens
 * flaggas.
 *
 *   node scripts/granskning/licenser.mjs            # Markdown till stdout
 *   node scripts/granskning/licenser.mjs --json     # JSON
 *
 * Används för docs/granskning/licenser.md. Kör om efter varje ändring av beroendena.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));

const COPYLEFT = /\b(A?GPL|LGPL|MPL|EPL|CDDL|EUPL|OSL|CC-BY-SA)/i;

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => (typeof l === "string" ? l : l.type)).join(" OR ");
  }
  return null;
}

const rows = [];
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (key === "" || !key.includes("node_modules/")) continue;
  if (entry.dev || entry.link) continue;
  const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  const file = path.join(root, key, "package.json");
  let license = null;
  let version = entry.version ?? "";
  let installed = false;
  if (existsSync(file)) {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    license = licenseOf(pkg);
    version = pkg.version ?? version;
    installed = true;
  }
  license ??= entry.license ?? null;
  rows.push({
    name,
    version,
    license: license ?? "SAKNAS",
    installed,
    optional: Boolean(entry.optional || entry.devOptional),
    flag: license === null ? "ingen licens" : COPYLEFT.test(license) ? "copyleft" : null,
  });
}
rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  process.exit(0);
}

const byLicense = new Map();
for (const r of rows) byLicense.set(r.license, (byLicense.get(r.license) ?? 0) + 1);
const summary = [...byLicense.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const flagged = rows.filter((r) => r.flag);

const out = [];
out.push(
  `Produktionsberoenden: ${rows.length} paket (${rows.filter((r) => r.installed).length} installerade här, resten plattformsbinärer för andra plattformar).`,
);
out.push("");
out.push("| Licens | Paket |");
out.push("| --- | --- |");
for (const [license, n] of summary) out.push(`| ${license} | ${n} |`);
out.push("");
out.push("Flaggade (copyleft eller ingen licens):");
out.push("");
out.push("| Paket | Version | Licens | Flagga | Installerat här |");
out.push("| --- | --- | --- | --- | --- |");
for (const r of flagged) {
  out.push(
    `| \`${r.name}\` | ${r.version} | ${r.license} | ${r.flag} | ${r.installed ? "ja" : "nej"} |`,
  );
}
out.push("");
out.push("Alla paket:");
out.push("");
out.push("| Paket | Version | Licens |");
out.push("| --- | --- | --- |");
for (const r of rows) out.push(`| \`${r.name}\` | ${r.version} | ${r.license} |`);
process.stdout.write(`${out.join("\n")}\n`);
