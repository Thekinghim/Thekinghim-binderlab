/**
 * Bygger Chrome-tillägget i extensions/awish-sync (docs/awish-tillagg.md):
 *
 *   node scripts/extension/build.mjs
 *     → extensions/awish-sync/dist/ (mappen som läses in okomprimerat i Chrome)
 *     → public/downloads/binderlab-awish-sync.zip (länkas från Datakällor)
 *
 * Flaggor:
 *   --out <mapp>            annan utmapp
 *   --zip <fil> | --no-zip  annan zip-fil, eller ingen
 *   --awish-origin <url>    BARA för tester: läs en låtsas-Awish i stället för
 *                           https://dash.awish.vip (behörigheter och adress byts)
 *
 * TypeScript-filerna i src/ översätts en och en (typescript.transpileModule, inga
 * beroenden utöver projektets). Zip-filen skrivs här (deflate, fasta tidsstämplar), så
 * att samma källkod ger samma fil.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_DIR = path.join(ROOT, "extensions", "awish-sync");
const DEFAULT_AWISH = "https://dash.awish.vip";
/** Innehållsskript är klassiska skript, inte moduler. */
const CLASSIC_SCRIPTS = new Set(["discover.ts", "bridge.ts"]);
const STATIC_FILES = [
  "manifest.json",
  "popup.html",
  "popup.css",
  "offscreen.html",
  "icons/icon-192.png",
];

function parseArgs(argv) {
  const out = {
    out: path.join(SRC_DIR, "dist"),
    zip: path.join(ROOT, "public", "downloads", "binderlab-awish-sync.zip"),
    awishOrigin: DEFAULT_AWISH,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (!v) throw new Error(`${arg} saknar värde.`);
      i += 1;
      return v;
    };
    if (arg === "--out") out.out = path.resolve(value());
    else if (arg === "--zip") out.zip = path.resolve(value());
    else if (arg === "--no-zip") out.zip = null;
    else if (arg === "--awish-origin") out.awishOrigin = new URL(value()).origin;
    else throw new Error(`Okänd flagga: ${arg}`);
  }
  return out;
}

function transpile(file, source, awishOrigin) {
  let code = source;
  if (file === "config.ts" && awishOrigin !== DEFAULT_AWISH) {
    code = code.replace(`"${DEFAULT_AWISH}"`, JSON.stringify(awishOrigin));
    if (code === source) throw new Error("AWISH_ORIGIN hittades inte i config.ts.");
  }
  const result = ts.transpileModule(code, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
      removeComments: false,
      sourceMap: false,
    },
  });
  const errors = (result.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(errors[0].messageText, "\n")}`);
  }
  let js = result.outputText;
  if (CLASSIC_SCRIPTS.has(file)) {
    js = js.replace(/^export \{\};\s*$/m, "");
    if (/^\s*(import|export)\s/m.test(js)) throw new Error(`${file} får inte ha import/export.`);
  }
  return js;
}

function manifestFor(source, awishOrigin) {
  const manifest = JSON.parse(source);
  if (awishOrigin !== DEFAULT_AWISH) {
    const pattern = `${awishOrigin.replace(/:\d+$/, "")}/*`;
    manifest.host_permissions = [pattern];
    for (const script of manifest.content_scripts ?? []) script.matches = [pattern];
    manifest.name = `${manifest.name} (test)`;
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Zip (PKZIP 2.0, deflate). Fasta tidsstämplar: 2 nov. 2026 00:00.
// ---------------------------------------------------------------------------

const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 2;

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8-namn
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export async function buildExtension(options) {
  const { out, zip: zipPath, awishOrigin } = { ...parseArgs([]), ...options };
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const files = new Map();

  const srcFiles = (await readdir(path.join(SRC_DIR, "src")))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort();
  for (const file of srcFiles) {
    const source = await readFile(path.join(SRC_DIR, "src", file), "utf8");
    files.set(
      file.replace(/\.ts$/, ".js"),
      Buffer.from(transpile(file, source, awishOrigin), "utf8"),
    );
  }
  for (const file of STATIC_FILES) {
    const full = path.join(SRC_DIR, file);
    await stat(full);
    const data = await readFile(full);
    files.set(
      file,
      file === "manifest.json"
        ? Buffer.from(manifestFor(data.toString("utf8"), awishOrigin), "utf8")
        : data,
    );
  }

  const entries = [...files.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, data]) => ({ name, data }));
  for (const { name, data } of entries) {
    const target = path.join(out, ...name.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  if (zipPath) {
    await mkdir(path.dirname(zipPath), { recursive: true });
    await writeFile(zipPath, zip(entries));
  }
  return { out, zip: zipPath, files: entries.map((e) => e.name) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildExtension(parseArgs(process.argv.slice(2)))
    .then((r) => {
      console.log(`Tillägget byggt: ${path.relative(ROOT, r.out)} (${r.files.length} filer)`);
      if (r.zip) console.log(`Zip: ${path.relative(ROOT, r.zip)}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
