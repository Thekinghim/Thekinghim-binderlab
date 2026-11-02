/**
 * Chrome-tilläggets zip i public/downloads (länkas från Datakällor) är byggd från samma
 * källkod som ligger i extensions/awish-sync. Bygget är deterministiskt, så en ändrad
 * källfil utan nytt bygge (node scripts/extension/build.mjs) fångas här.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildExtension } from "../../../scripts/extension/build.mjs";

const ROOT = path.resolve(__dirname, "..", "..", "..");

describe("tilläggets zip", () => {
  it("public/downloads/binderlab-awish-sync.zip är byggd från extensions/awish-sync", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "binderlab-ext-"));
    const zip = path.join(dir, "ext.zip");
    const result = await buildExtension({ out: path.join(dir, "dist"), zip });
    expect(result.files).toEqual(
      expect.arrayContaining([
        "manifest.json",
        "background.js",
        "offscreen.html",
        "popup.html",
        "discover.js",
        "bridge.js",
      ]),
    );
    const committed = readFileSync(
      path.join(ROOT, "public", "downloads", "binderlab-awish-sync.zip"),
    );
    expect(
      Buffer.compare(readFileSync(zip), committed),
      "Zip-filen är inte uppdaterad: kör node scripts/extension/build.mjs",
    ).toBe(0);
  });

  it("manifestet: MV3, bara dash.awish.vip som fast behörighet, inga breda behörigheter", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(ROOT, "extensions", "awish-sync", "manifest.json"), "utf8"),
    );
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toEqual(["https://dash.awish.vip/*"]);
    // "scripting": reserven som läser den färdigritade orderlistan i en öppen Awish-flik
    // (bara flikar som host_permissions täcker, alltså dash.awish.vip).
    expect(manifest.permissions.sort()).toEqual(["alarms", "offscreen", "scripting", "storage"]);
    expect(manifest.background).toEqual({ service_worker: "background.js", type: "module" });
    expect(JSON.stringify(manifest)).not.toMatch(/<all_urls>|"tabs"|"cookies"|"webRequest"/);
  });

  it("ett testbygge mot en låtsas-Awish byter adress och behörigheter", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "binderlab-ext-"));
    const out = path.join(dir, "dist");
    await buildExtension({ out, zip: null, awishOrigin: "http://127.0.0.1:4555" });
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
    expect(readFileSync(path.join(out, "config.js"), "utf8")).toContain('"http://127.0.0.1:4555"');
  });
});
