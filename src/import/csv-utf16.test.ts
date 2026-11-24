import { describe, expect, it } from "vitest";

import { decodeFile } from "./csv-table";

describe("UTF-16 (Excels Unicode-text)", () => {
  it("läser filer med BOM i båda byteordningarna", () => {
    const text = "Datum\tBelopp\n2026-11-13\t1 234,56 kr åäö\n";
    const le = new Uint8Array([0xff, 0xfe, ...Buffer.from(text, "utf16le")]);
    expect(decodeFile(le)).toEqual({ text, encoding: "utf-16le" });
    const be = Buffer.from(text, "utf16le");
    be.swap16();
    expect(decodeFile(new Uint8Array([0xfe, 0xff, ...be]))).toEqual({ text, encoding: "utf-16be" });
  });
});
