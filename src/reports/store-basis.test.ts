/**
 * Underlaget för butikens bokföring i butiksrapporten: vem som betalar, avtalet och momsen.
 * Texterna här är de som står i rapporten (sidan, PDF:en, mejlet och butiksportalen).
 */

import { describe, expect, it } from "vitest";

import {
  AGREEMENT_FORM_LABEL,
  AGREEMENT_MISSING_LINE,
  AGREEMENT_MISSING_MESSAGE,
  BASIS_REV,
  agreementLine,
  agreementMissing,
  agreementText,
  asStoreBasis,
  basisNotes,
  basisGaps,
  basisText,
  brandOf,
  contractForPeriod,
  contractLine,
  invoiceEmptyText,
  invoiceRows,
  invoiceTitle,
  isRev2,
  normalizeVatNumber,
  ownerLine,
  payerLines,
  payerName,
  payerText,
  paymentNotes,
  recipientLines,
  recipientMissing,
  recipientParts,
  salesBasis,
  salesNote,
  salesVatLabel,
  suggestedVatNumber,
  vatRows,
  vatSentences,
  vmbStatement,
  withoutVmbStatement,
  type BasisContractRow,
  type StoreBasis,
} from "./store-basis";
import type { StoreReport } from "./store-report";

const NBSP = " ";

const BASIS: StoreBasis = {
  payer: {
    name: "Binderlab AB",
    legal: true,
    orgNumber: "559000-1234",
    address: "Storgatan 1, 111 22 Stockholm",
    vatNumber: "SE559000123401",
  },
  contract: { title: "Placeringsavtal", validFrom: "2026-11-03", signedOn: "2026-11-09" },
  vatMode: "added",
  vatRateBp: 2500,
};

const OCTOBER = { start: "2026-10-01", end: "2026-10-31" };

/**
 * En rapport för underlaget: perioden (standard november 2026), ersättningen och en automat.
 * `splits`: vinstdelningens andel per period (för betalningar som gäller en del av en månad).
 */
function rep(
  totalOre: number,
  extra: { termsText?: string } = {},
  opts: {
    period?: { start: string; end: string };
    splits?: { start: string; end: string; shareOre: number; profitOre?: number }[];
    commissionOre?: number;
    machines?: number;
  } = {},
): StoreReport {
  const period = opts.period ?? { start: "2026-11-01", end: "2026-11-30" };
  return {
    period,
    month: period.start.slice(0, 7),
    machines: Array.from({ length: opts.machines ?? 1 }, () => ({})),
    compensation: {
      totalOre,
      commissionOre: opts.commissionOre ?? 0,
      rentOre: 0,
      steps: [],
      splits: (opts.splits ?? []).map((x) => ({
        range: { start: x.start, end: x.end },
        storeShareOre: x.shareOre,
        profitOre: x.profitOre ?? x.shareOre * 2,
        pending: false,
      })),
      ...extra,
    },
  } as unknown as StoreReport;
}

function row(over: Partial<BasisContractRow>): BasisContractRow {
  return {
    title: "Placeringsavtal",
    validFrom: "2026-01-01",
    validTo: null,
    terminatedOn: null,
    template: "placering-v1",
    signedOn: "2025-12-20",
    ...over,
  };
}

describe("momsregistreringsnumret", () => {
  it("föreslås från organisationsnumret: SE + tio siffror + 01", () => {
    expect(suggestedVatNumber("559000-1234")).toBe("SE559000123401");
    expect(suggestedVatNumber("5590001234")).toBe("SE559000123401");
  });

  it("inget förslag utan ett helt organisationsnummer", () => {
    expect(suggestedVatNumber(null)).toBeNull();
    expect(suggestedVatNumber("")).toBeNull();
    expect(suggestedVatNumber("559000-12")).toBeNull();
  });

  it("tar emot numret med mellanslag och små bokstäver, men bara ett svenskt nummer", () => {
    expect(normalizeVatNumber("se 559000-1234 01")).toBe("SE559000123401");
    expect(normalizeVatNumber("SE559000123401")).toBe("SE559000123401");
    expect(normalizeVatNumber("559000123401")).toBeNull();
    expect(normalizeVatNumber("SE559000123402")).toBeNull();
    expect(normalizeVatNumber("DE123456789")).toBeNull();
  });
});

describe("avtalet för perioden", () => {
  it("det undertecknade kontraktet som gällde under perioden", () => {
    expect(contractForPeriod([row({})], OCTOBER)).toEqual({
      title: "Placeringsavtal",
      validFrom: "2026-01-01",
      signedOn: "2025-12-20",
    });
  });

  it("ett kontrakt från mallen som inte är undertecknat räknas inte", () => {
    expect(contractForPeriod([row({ signedOn: null })], OCTOBER)).toBeNull();
  });

  it("ett kontrakt registrerat för hand räknas, utan dag för undertecknandet", () => {
    expect(contractForPeriod([row({ template: null, signedOn: null })], OCTOBER)).toEqual({
      title: "Placeringsavtal",
      validFrom: "2026-01-01",
      signedOn: null,
    });
  });

  it("kontrakt som slutat före perioden, eller börjar efter den, räknas inte", () => {
    expect(contractForPeriod([row({ validTo: "2026-09-30" })], OCTOBER)).toBeNull();
    expect(contractForPeriod([row({ terminatedOn: "2026-09-30" })], OCTOBER)).toBeNull();
    expect(contractForPeriod([row({ validFrom: "2026-11-01" })], OCTOBER)).toBeNull();
    // Sista dagen i perioden räcker.
    expect(contractForPeriod([row({ validFrom: "2026-10-31" })], OCTOBER)).not.toBeNull();
    expect(contractForPeriod([row({ validTo: "2026-10-01" })], OCTOBER)).not.toBeNull();
  });

  it("med flera gäller det senaste, och ett kontrakt utan namn heter Placeringsavtal", () => {
    const picked = contractForPeriod(
      [
        row({ title: "Gammalt avtal", validFrom: "2025-01-01" }),
        row({ title: "  ", validFrom: "2026-06-01", signedOn: "2026-05-28" }),
        row({ title: "Inte undertecknat", validFrom: "2026-09-01", signedOn: null }),
      ],
      OCTOBER,
    );
    expect(picked).toEqual({
      title: "Placeringsavtal",
      validFrom: "2026-06-01",
      signedOn: "2026-05-28",
    });
  });
});

describe("texterna i rapporten", () => {
  it("vem som betalar: namn, org.nr, adress och momsreg.nr", () => {
    expect(payerLines(BASIS)).toEqual([
      "Binderlab AB",
      "Org.nr 559000-1234",
      "Storgatan 1, 111 22 Stockholm",
      "Momsreg.nr SE559000123401",
    ]);
  });

  it("det som inte är ifyllt står inte med (momsreg.nr gissas aldrig)", () => {
    const bare: StoreBasis = {
      ...BASIS,
      payer: { name: "Binderlab", legal: false, orgNumber: null, address: null, vatNumber: null },
    };
    expect(payerLines(bare)).toEqual(["Binderlab"]);
    expect(basisGaps(bare)).toEqual(["företagsnamn", "organisationsnummer"]);
    expect(basisGaps(BASIS)).toEqual([]);
    expect(basisGaps({ ...BASIS, payer: { ...BASIS.payer, orgNumber: null } })).toEqual([
      "organisationsnummer",
    ]);
  });

  it("avtalsraden", () => {
    expect(contractLine(BASIS)).toBe(
      "Enligt Placeringsavtal från 3 november 2026, undertecknat 9 november 2026.",
    );
    expect(contractLine({ ...BASIS, contract: { ...BASIS.contract!, signedOn: null } })).toBe(
      "Enligt Placeringsavtal från 3 november 2026.",
    );
  });

  it("utan undertecknat avtal finns ingen rad (rapporten påstår inget)", () => {
    expect(contractLine({ ...BASIS, contract: null })).toBeNull();
    expect(
      basisText({ ...BASIS, contract: null }, rep(749_300), "Sega gubben").join("\n"),
    ).not.toMatch(/Enligt|avtal/i);
  });

  it("moms tillkommer: ersättningen, 25 % moms och beloppet att fakturera", () => {
    expect(vatRows(BASIS, 749_300)).toEqual([
      { key: "amount", label: "Ersättning exkl. moms", amountOre: 749_300 },
      { key: "vat", label: "Moms 25 %", amountOre: 187_325 },
      { key: "total", label: "Att fakturera", amountOre: 936_625, strong: true },
    ]);
    // Öresavrundning: halva ören uppåt.
    expect(vatRows(BASIS, 1_234_567).map((r) => r.amountOre)).toEqual([
      1_234_567, 308_642, 1_543_209,
    ]);
    expect(vatSentences(BASIS, 749_300)).toEqual([
      "Ersättningen är exklusive moms. Ni fakturerar Binderlab AB och lägger på svensk moms, 25 %.",
      "Binderlab AB är säljare av varorna i automaten.",
    ]);
  });

  it("ingen ersättning: inget att fakturera", () => {
    expect(vatRows(BASIS, 0)).toEqual([]);
    expect(vatRows(BASIS, -5_000)).toEqual([]);
    // Inget påstående om hur vi själva redovisar momsen, och inga ord som stoppas i butiksmejlet.
    for (const ore of [749_300, 0, -5_000])
      for (const mode of ["added", "none"] as const)
        expect(vatSentences({ ...BASIS, vatMode: mode }, ore).join(" ")).not.toMatch(
          /redovisar|vinst|marginal/i,
        );
    expect(vatSentences(BASIS, 0)).toEqual(["Binderlab AB är säljare av varorna i automaten."]);
  });

  it("Visa ingen momsrad: inga momsbelopp och inget påstående om moms", () => {
    const none: StoreBasis = { ...BASIS, vatMode: "none" };
    expect(vatRows(none, 749_300)).toEqual([]);
    expect(vatSentences(none, 749_300)).toEqual([
      "Binderlab AB är säljare av varorna i automaten.",
    ]);
    expect(basisText(none, rep(749_300), "Sega gubben").join("\n")).not.toMatch(/moms(?!reg)/i);
  });

  it("hela blocket som text (mejlets textdel)", () => {
    expect(basisText(BASIS, rep(749_300), "Sega gubben")).toEqual([
      "Ersättningen betalas av: Binderlab AB, Org.nr 559000-1234, Storgatan 1, 111 22 Stockholm, Momsreg.nr SE559000123401",
      "Mottagare: Sega gubben",
      `Ersättning exkl. moms: 7${NBSP}493,00${NBSP}kr`,
      `Moms 25 %: 1${NBSP}873,25${NBSP}kr`,
      `Att fakturera: 9${NBSP}366,25${NBSP}kr`,
      "Enligt Placeringsavtal från 3 november 2026, undertecknat 9 november 2026.",
      "Ersättningen är exklusive moms. Ni fakturerar Binderlab AB och lägger på svensk moms, 25 %.",
      "Binderlab AB är säljare av varorna i automaten.",
    ]);
  });
});

describe("Vi säljer med vinstmarginalbeskattning (VMB)", () => {
  const vmb: StoreBasis = { ...BASIS, vmb: true };
  const STATEMENT =
    "Binderlab AB är säljare av varorna i automaten och redovisar momsen på den försäljningen enligt reglerna om vinstmarginalbeskattning (VMB). Den momsen berör inte butiken. Butikens ersättning är betalning för en tjänst och omfattas inte av VMB.";

  it("på: rapporten säger det, ord för ord", () => {
    expect(vmbStatement("Binderlab AB")).toBe(STATEMENT);
    expect(vatSentences(vmb, 749_300)).toEqual([
      "Ersättningen är exklusive moms. Ni fakturerar Binderlab AB och lägger på svensk moms, 25 %.",
      STATEMENT,
    ]);
    // Också utan momsrad och utan ersättning: det är vad bolaget säger om sin egen moms.
    expect(vatSentences({ ...vmb, vatMode: "none" }, 749_300)).toEqual([STATEMENT]);
    expect(vatSentences(vmb, 0)).toEqual([STATEMENT]);
    expect(basisText(vmb, rep(749_300), "Sega gubben").at(-1)).toBe(STATEMENT);
  });

  it("av (standard, och rapporter från före valet): bara att vi är säljare", () => {
    for (const b of [BASIS, { ...BASIS, vmb: false }])
      expect(vatSentences(b, 749_300).at(-1)).toBe(
        "Binderlab AB är säljare av varorna i automaten.",
      );
  });

  it("kontrollen undantar bara den fasta texten, och bara när valet är på", () => {
    const FORBIDDEN = /vinst|marginal/i;
    const all = basisText(vmb, rep(749_300), "Sega gubben").join(" ");
    expect(all).toMatch(FORBIDDEN);
    expect(withoutVmbStatement(all, vmb)).not.toMatch(FORBIDDEN);
    // Ordet någon annanstans stoppas som förut.
    for (const leak of [
      "Vinstmarginalbeskattning gäller.",
      "Er marginal var 12 %.",
      "Vår vinst blev 500 kr.",
      // Nästan den fasta texten (ett annat bolag, ett ord till) är inte den fasta texten.
      vmbStatement("Annat AB"),
      STATEMENT.replace("Den momsen", "Den vinstmarginalen"),
    ])
      expect(withoutVmbStatement(`${all} ${leak}`, vmb), leak).toMatch(FORBIDDEN);
    // Utan valet tas ingenting bort, inte ens den fasta texten.
    expect(withoutVmbStatement(STATEMENT, BASIS)).toBe(STATEMENT);
    expect(withoutVmbStatement(STATEMENT, null)).toBe(STATEMENT);
  });
});

describe("juridiskt namn och namnet verksamheten kallas", () => {
  const rev2: StoreBasis = { ...BASIS, rev: 2, payer: { ...BASIS.payer, ownsMachines: true } };

  it("namnen skiljer sig: det juridiska namnet betalar, verksamhetens namn står en gång", () => {
    expect(brandOf("Kortautomater i Norden AB", "Binderlab")).toBe("Binderlab");
    const b: StoreBasis = {
      ...rev2,
      payer: {
        ...BASIS.payer,
        name: "Kortautomater i Norden AB",
        brand: "Binderlab",
        ownsMachines: true,
      },
    };
    expect(payerName(b)).toBe("Kortautomater i Norden AB (verksamheten kallas Binderlab)");
    expect(payerLines(b)).toEqual([
      "Kortautomater i Norden AB (verksamheten kallas Binderlab)",
      "Äger och driver automaten.",
      "Org.nr 559000-1234",
      "Storgatan 1, 111 22 Stockholm",
      "Momsreg.nr SE559000123401",
    ]);
    // Meningarna om momsen och avtalet använder det juridiska namnet, utan parentesen.
    const all = basisText(b, rep(749_300), "Sega gubben").join("\n");
    expect(all.match(/verksamheten kallas/g)).toHaveLength(1);
    expect(all).toContain("Ni fakturerar Kortautomater i Norden AB och lägger på svensk moms");
  });

  it("bolaget i löptext (mejlet): kommatecken och punkter på rätt ställen", () => {
    const b: StoreBasis = {
      ...rev2,
      payer: { ...rev2.payer, name: "Kortautomater i Norden AB", brand: "Binderlab" },
    };
    expect(payerText(b)).toBe(
      "Kortautomater i Norden AB (verksamheten kallas Binderlab), som äger och driver automaten. Org.nr 559000-1234, Storgatan 1, 111 22 Stockholm, Momsreg.nr SE559000123401.",
    );
    expect(basisText(b, rep(749_300), "Sega gubben")[0]).toBe(
      `Ersättningen betalas av: ${payerText(b)}`,
    );
    const plain: StoreBasis = { ...rev2, payer: { ...rev2.payer, ownsMachines: false } };
    expect(payerText(plain)).toBe(
      "Binderlab AB. Org.nr 559000-1234, Storgatan 1, 111 22 Stockholm, Momsreg.nr SE559000123401.",
    );
    expect(
      payerText({
        ...plain,
        payer: { name: "X AB", legal: true, orgNumber: null, address: null, vatNumber: null },
      }),
    ).toBe("X AB.");
  });

  it("vem som äger automaten sägs bara när ägaren har valt det", () => {
    const off: StoreBasis = { ...rev2, payer: { ...rev2.payer, ownsMachines: false } };
    expect(ownerLine(off)).toBeNull();
    const { ownsMachines: _o, ...payer } = rev2.payer;
    void _o;
    expect(ownerLine({ ...rev2, payer })).toBeNull();
    expect(payerLines(off).join(" ")).not.toContain("Äger");
  });

  it("samma namn (skiftläge och blanksteg räknas inte) eller inget juridiskt namn: ingen parentes", () => {
    expect(brandOf("Binderlab AB", "binderlab  ab ")).toBeNull();
    expect(brandOf(null, "Binderlab")).toBeNull();
    expect(brandOf("Binderlab AB", "")).toBeNull();
    expect(payerName(rev2)).toBe("Binderlab AB");
  });

  it("Äger och driver automaten: en automat eller flera", () => {
    expect(ownerLine(rev2)).toBe("Äger och driver automaten.");
    expect(ownerLine(rev2, 1)).toBe("Äger och driver automaten.");
    expect(ownerLine(rev2, 3)).toBe("Äger och driver automaterna.");
    expect(payerLines(rev2, 2)[1]).toBe("Äger och driver automaterna.");
  });

  it("en rapport från före ändringen har raderna som förut", () => {
    expect(ownerLine(BASIS)).toBeNull();
    expect(ownerLine({ ...BASIS, payer: { ...BASIS.payer, ownsMachines: true } })).toBeNull();
    expect(payerLines(BASIS)).toEqual([
      "Binderlab AB",
      "Org.nr 559000-1234",
      "Storgatan 1, 111 22 Stockholm",
      "Momsreg.nr SE559000123401",
    ]);
  });
});

describe("redan betalt", () => {
  const rev2: StoreBasis = { ...BASIS, rev: 2 };
  const paid = (payments: StoreBasis["payments"]): StoreBasis => ({ ...rev2, payments });

  it("butiken har fått ersättningen exklusive moms: kvar att betala är momsen", () => {
    const b = paid([{ paidOn: "2026-11-05", amountOre: 749_300 }]);
    expect(invoiceRows(b, rep(749_300))).toEqual([
      { key: "amount", label: "Ersättning exkl. moms", amountOre: 749_300 },
      { key: "vat", label: "Moms 25 %", amountOre: 187_325 },
      { key: "total", label: "Att fakturera", amountOre: 936_625, strong: true },
      { key: "paid-2026-11-05-", label: `Redan betalt 5 nov. 2026`, amountOre: 749_300 },
      { key: "left", label: "Kvar att betala", amountOre: 187_325, strong: true },
    ]);
    expect(invoiceTitle(b)).toBe("Er faktura");
    const text = basisText(b, rep(749_300), "Sega gubben");
    expect(text).toContain(`Redan betalt 5 nov. 2026: 7${NBSP}493,00${NBSP}kr`);
    expect(text).toContain(`Kvar att betala: 1${NBSP}873,25${NBSP}kr`);
  });

  it("inget betalt: blocket som förut", () => {
    for (const b of [rev2, paid([]), paid([{ paidOn: "2026-11-05", amountOre: 0 }])])
      expect(invoiceRows(b, rep(749_300))).toEqual(vatRows(b, 749_300));
  });

  it("två avräkningar (två månader): en rad per betaldag, samma dag läggs ihop", () => {
    const rows = invoiceRows(
      paid([
        { paidOn: "2026-12-02", amountOre: 300_000 },
        { paidOn: "2026-11-05", amountOre: 200_000 },
        { paidOn: "2026-11-05", amountOre: 100_000 },
      ]),
      rep(749_300),
    );
    // En rad per avräkning, äldst först.
    expect(rows.slice(3).map((r) => [r.key, r.amountOre])).toEqual([
      ["paid-2026-11-05-", 200_000],
      ["paid-2026-11-05-", 100_000],
      ["paid-2026-12-02-", 300_000],
      ["left", 936_625 - 600_000],
    ]);
  });

  it("allt betalt: kvar att betala 0 kr", () => {
    const rows = invoiceRows(paid([{ paidOn: "2026-11-05", amountOre: 936_625 }]), rep(749_300));
    expect(rows.at(-1)).toEqual({
      key: "left",
      label: "Kvar att betala",
      amountOre: 0,
      strong: true,
    });
  });

  it("mer betalt än rapportens belopp (avräkningen gäller mer än rapporten): visas inte", () => {
    const b = paid([{ paidOn: "2026-11-05", amountOre: 936_626 }]);
    expect(invoiceRows(b, rep(749_300))).toEqual(vatRows(b, 749_300));
  });

  it("utan momsrad: Er ersättning, redan betalt och kvar att betala", () => {
    const b: StoreBasis = {
      ...paid([{ paidOn: "2026-11-05", amountOre: 700_000 }]),
      vatMode: "none",
    };
    expect(invoiceRows(b, rep(749_300)).map((r) => [r.label, r.amountOre])).toEqual([
      ["Er ersättning", 749_300],
      ["Redan betalt 5 nov. 2026", 700_000],
      ["Kvar att betala", 49_300],
    ]);
    expect(invoiceTitle(b)).toBe("Betalning");
    // Utan betalning: inget block alls, som förut.
    expect(invoiceRows({ ...b, payments: [] }, rep(749_300))).toEqual([]);
  });

  it("ingen ersättning eller en rapport från före ändringen: inget om betalningar", () => {
    const b = paid([{ paidOn: "2026-11-05", amountOre: 100 }]);
    expect(invoiceRows(b, rep(0))).toEqual([]);
    const { rev: _rev, ...old } = b;
    void _rev;
    expect(invoiceRows(old, rep(749_300))).toEqual(vatRows(old, 749_300));
  });
});

describe("avtalets form", () => {
  const rev2: StoreBasis = { ...BASIS, rev: 2 };
  const TERMS = { termsText: "50 % av vinsten efter kostnader" };
  const WRITTEN = "Enligt Placeringsavtal från 3 november 2026, undertecknat 9 november 2026.";

  it("skriftligt avtal: säger skriftligt, kontraktet, parterna och villkoren", () => {
    expect(agreementLine({ ...rev2, agreementForm: "written" }, "Sega gubben", TERMS)).toBe(
      "Skriftligt avtal (Placeringsavtal) mellan Binderlab AB och Sega gubben från 3 november 2026, undertecknat 9 november 2026: 50 % av vinsten efter kostnader.",
    );
    expect(agreementMissing({ ...rev2, agreementForm: "written" }, "Sega gubben", TERMS)).toBe(
      false,
    );
  });

  it("skriftligt avtal registrerat för hand: påstår inte att det är undertecknat", () => {
    const b: StoreBasis = {
      ...rev2,
      agreementForm: "written",
      contract: { title: "Placeringsavtal", validFrom: "2026-10-01", signedOn: null },
    };
    expect(agreementLine(b, "Gallerian Väst", { termsText: "hyra 1 500 kr per månad" })).toBe(
      "Skriftligt avtal (Placeringsavtal) mellan Binderlab AB och Gallerian Väst från 1 oktober 2026: hyra 1 500 kr per månad.",
    );
  });

  it("muntligt avtal: bolaget, butiken och villkoren i klartext", () => {
    const oral: StoreBasis = { ...rev2, agreementForm: "oral", contract: null };
    expect(agreementLine(oral, "Sega gubben", TERMS)).toBe(
      "Muntligt avtal mellan Binderlab AB och Sega gubben: 50 % av vinsten efter kostnader.",
    );
    expect(agreementMissing(oral, "Sega gubben", TERMS)).toBe(false);
    expect(basisText(oral, rep(749_300, TERMS), "Sega gubben")).toContain(
      "Muntligt avtal mellan Binderlab AB och Sega gubben: 50 % av vinsten efter kostnader.",
    );
  });

  it("muntligt går före ett kontrakt som står som undertecknat", () => {
    // Också om kontraktet skulle ligga kvar i underlaget påstås inget skriftligt avtal.
    const line = agreementLine({ ...rev2, agreementForm: "oral" }, "Sega gubben", TERMS);
    expect(line).toMatch(/^Muntligt avtal/);
    expect(line).not.toMatch(/Enligt|undertecknat/);
  });

  it("inte valt: kontraktet om det finns, annars Avtal saknas och en varning", () => {
    expect(agreementLine({ ...rev2, agreementForm: null }, "Sega gubben", TERMS)).toBe(WRITTEN);
    const none: StoreBasis = { ...rev2, agreementForm: null, contract: null };
    expect(agreementLine(none, "Sega gubben", TERMS)).toBeNull();
    expect(agreementMissing(none, "Sega gubben", TERMS)).toBe(true);
    expect(AGREEMENT_MISSING_MESSAGE).toBe("Rapporten säger inte vilket avtal som gäller");
    // Rapporten tiger inte: den säger att avtalet saknas.
    expect(agreementText(none, "Sega gubben", TERMS)).toBe(AGREEMENT_MISSING_LINE);
    expect(basisText(none, rep(749_300, TERMS), "Sega gubben")).toContain(
      "Avtal saknas i underlaget.",
    );
  });

  it("skriftligt utan kontrakt i appen: ägarens val gäller, utan namn och datum", () => {
    const written: StoreBasis = { ...rev2, agreementForm: "written", contract: null };
    expect(agreementLine(written, "Sega gubben", TERMS)).toBe(
      "Skriftligt avtal mellan Binderlab AB och Sega gubben: 50 % av vinsten efter kostnader.",
    );
    expect(agreementMissing(written, "Sega gubben", TERMS)).toBe(false);
  });

  it("valt men utan avtal i perioden: ingen rad och en varning", () => {
    // Muntligt utan avtal i perioden (inga villkor att skriva).
    const oral: StoreBasis = { ...rev2, agreementForm: "oral", contract: null };
    expect(agreementLine(oral, "Sega gubben", {})).toBeNull();
    expect(agreementMissing(oral, "Sega gubben", {})).toBe(true);
  });

  it("en rapport från före valet varnar inte och visar kontraktet som förut", () => {
    expect(agreementLine(BASIS, "Sega gubben", {})).toBe(WRITTEN);
    expect(agreementMissing({ ...BASIS, contract: null }, "Sega gubben", {})).toBe(false);
    expect(agreementText({ ...BASIS, contract: null }, "Sega gubben", {})).toBeNull();
  });

  it("valen heter Skriftligt avtal och Muntligt avtal", () => {
    expect(AGREEMENT_FORM_LABEL).toEqual({ written: "Skriftligt avtal", oral: "Muntligt avtal" });
  });
});

describe("vad försäljningssiffran är", () => {
  const sales = (vatOre: number) => ({ revenueOre: 100_000 - vatOre, vatOre }) as never;
  const comp = (splits: number) =>
    ({ splits: Array.from({ length: splits }, () => ({})) }) as never;

  it("vinstdelning och momssats 0 %: det kunderna betalade, inklusive moms", () => {
    const r = { sales: sales(0), compensation: comp(1) };
    expect(salesNote(r, "Sega gubben")).toBe(
      "Försäljningen är kundernas köp i automater som stod i Sega gubben köpdagen, inklusive moms.",
    );
    expect(salesVatLabel(r)).toBe("Inkl. moms");
    expect(salesBasis(r)).toEqual({ kpi: "incl", splitInclVat: false });
  });

  it("provision eller hyra och momssats 0 %: det kunderna betalade, inget påstående om moms", () => {
    const r = { sales: sales(0), compensation: comp(0) };
    expect(salesNote(r, "Sega gubben")).toBe(
      "Försäljningen är kundernas köp i automater som stod i Sega gubben köpdagen.",
    );
    expect(salesVatLabel(r)).toBeNull();
    expect(salesBasis(r)).toEqual({ kpi: null, splitInclVat: false });
  });

  it("med momssats: nyckeltalet är exklusive moms, vinstdelningen räknar inklusive moms", () => {
    const provision = { sales: sales(20_000), compensation: comp(0) };
    expect(salesNote(provision, "Sega gubben")).toBe(
      "Försäljningen är kundernas köp i automater som stod i Sega gubben köpdagen, exklusive moms.",
    );
    expect(salesVatLabel(provision)).toBe("Exkl. moms");
    const split = { sales: sales(20_000), compensation: comp(2) };
    expect(salesNote(split, "Sega gubben")).toBe(
      "Försäljningen överst är kundernas köp i automater som stod i Sega gubben köpdagen, exklusive moms. I uträkningen räknas försäljningen inklusive moms.",
    );
    expect(salesBasis(split)).toEqual({ kpi: "excl", splitInclVat: true });
  });

  it("påstår aldrig att ingen moms tas ut", () => {
    for (const vat of [0, 20_000])
      for (const splits of [0, 1]) {
        const r = { sales: sales(vat), compensation: comp(splits) };
        expect(`${salesNote(r, "X")} ${salesVatLabel(r)}`).not.toMatch(/ingen moms|tas ut/i);
      }
  });

  it("utgåvan: bara rapporter sparade med utgåva 2 får den nya texten", () => {
    expect(BASIS_REV).toBe(2);
    expect(isRev2({ ...BASIS, rev: 2 })).toBe(true);
    expect(isRev2(BASIS)).toBe(false);
    expect(isRev2(null)).toBe(false);
  });
});

describe("sparat värde", () => {
  it("läses tillbaka, och ett saknat eller trasigt värde ger inget block", () => {
    expect(asStoreBasis(JSON.parse(JSON.stringify(BASIS)))).toEqual(BASIS);
    expect(asStoreBasis(undefined)).toBeNull();
    expect(asStoreBasis(null)).toBeNull();
    expect(asStoreBasis({ payer: { name: "X" } })).toBeNull();
    expect(asStoreBasis({ ...BASIS, vatMode: "annat" })).toBeNull();
  });
});

describe("betalningen gäller en avräkningsmånad", () => {
  const rev2: StoreBasis = { ...BASIS, rev: 2 };
  // Ägarens fall: rapporten 14 okt.–14 nov., oktober betald 5 nov. för hela månaden.
  const CASE = rep(
    1_008_525,
    {},
    {
      period: { start: "2026-10-14", end: "2026-11-14" },
      splits: [
        { start: "2026-10-14", end: "2026-10-31", shareOre: 598_775 },
        { start: "2026-11-01", end: "2026-11-14", shareOre: 409_750 },
      ],
    },
  );
  const paidOct = (amountOre: number): StoreBasis => ({
    ...rev2,
    payments: [{ paidOn: "2026-11-05", amountOre, month: "2026-10" }],
  });

  it("del av månaden: bara rapportens dagar räknas av, och resten sägs", () => {
    const b = paidOct(618_075);
    const rows = invoiceRows(b, CASE);
    expect(rows.slice(3).map((r) => [r.label, r.amountOre])).toEqual([
      ["Redan betalt 5 nov. 2026 (avräkning oktober 2026)", 598_775],
      ["Kvar att betala", 1_260_656 - 598_775],
    ]);
    expect(paymentNotes(b, CASE)).toEqual([
      `Avräkningen för oktober 2026 betalades 5 nov. 2026 med 6${NBSP}180,75${NBSP}kr och gällde hela månaden. Av den räknas 5${NBSP}987,75${NBSP}kr av här, för 14–31 okt. 2026. Resten, 193,00${NBSP}kr, gäller dagar utanför rapporten.`,
    ]);
  });

  it("hela månaden i rapporten: hela beloppet räknas av", () => {
    const whole = rep(
      1_028_025,
      {},
      {
        period: { start: "2026-10-01", end: "2026-11-14" },
        splits: [
          { start: "2026-10-01", end: "2026-10-31", shareOre: 618_075 },
          { start: "2026-11-01", end: "2026-11-14", shareOre: 409_750 },
        ],
      },
    );
    const b = paidOct(618_075);
    expect(invoiceRows(b, whole).at(-2)).toEqual({
      key: "paid-2026-11-05-2026-10",
      label: "Redan betalt 5 nov. 2026 (avräkning oktober 2026)",
      amountOre: 618_075,
    });
    expect(paymentNotes(b, whole)).toEqual([]);
    // Ett annat belopp än rapportens för månaden: räknas av, och skillnaden sägs.
    expect(paymentNotes(paidOct(600_000), whole)).toEqual([
      `Avräkningen för oktober 2026 betalades 5 nov. 2026 med 6${NBSP}000,00${NBSP}kr. Rapportens belopp för oktober 2026 är 6${NBSP}180,75${NBSP}kr.`,
    ]);
  });

  it("del av månaden med provision eller hyra: går inte att dela, räknas inte av", () => {
    const mixed = rep(
      1_008_525,
      {},
      {
        period: { start: "2026-10-14", end: "2026-11-14" },
        commissionOre: 10_000,
        splits: [{ start: "2026-10-14", end: "2026-10-31", shareOre: 598_775 }],
      },
    );
    const b = paidOct(618_075);
    expect(invoiceRows(b, mixed)).toEqual(vatRows(b, 1_008_525));
    expect(paymentNotes(b, mixed)).toEqual([
      `Avräkningen för oktober 2026 betalades 5 nov. 2026 med 6${NBSP}180,75${NBSP}kr. Den gäller hela oktober 2026, också dagar utanför rapporten, och räknas inte av här.`,
    ]);
  });

  it("mer betalt än att fakturera: inget räknas av, och det sägs", () => {
    const b = paidOct(2_000_000);
    const whole = rep(
      500_000,
      {},
      {
        period: { start: "2026-10-01", end: "2026-10-31" },
        splits: [{ start: "2026-10-01", end: "2026-10-31", shareOre: 500_000 }],
      },
    );
    expect(invoiceRows(b, whole)).toEqual(vatRows(b, 500_000));
    expect(paymentNotes(b, whole).at(-1)).toMatch(/är mer än beloppet att betala/);
  });

  it("en rapport från före ändringen: inga meningar om betalningar", () => {
    expect(paymentNotes({ ...paidOct(618_075), rev: undefined }, CASE)).toEqual([]);
  });
});

describe("inget att fakturera, mottagaren och platsen för automaten", () => {
  const rev2: StoreBasis = { ...BASIS, rev: 2 };

  it("ingen vinst: blocket säger att inget ska faktureras och varför", () => {
    const loss = rep(
      0,
      {},
      {
        period: { start: "2026-11-01", end: "2026-11-18" },
        splits: [{ start: "2026-11-01", end: "2026-11-18", shareOre: 0, profitOre: -219_850 }],
      },
    );
    expect(invoiceRows(rev2, loss)).toEqual([]);
    expect(invoiceEmptyText(rev2, loss)).toBe(
      "Inget att fakturera för 1–18 nov. 2026 (ingen vinst, andelen blir 0 kr).",
    );
    expect(invoiceEmptyText(rev2, rep(0))).toBe("Inget att fakturera för november 2026.");
    expect(invoiceEmptyText(rev2, rep(100))).toBeNull();
    expect(invoiceEmptyText(BASIS, loss)).toBeNull();
  });

  it("mottagaren med butikens adress (utgåva 2)", () => {
    expect(
      recipientLines({ ...rev2, recipientAddress: "Torget 2, 411 01 Göteborg" }, "Sega gubben"),
    ).toEqual(["Sega gubben", "Torget 2, 411 01 Göteborg"]);
    expect(recipientLines({ ...rev2, recipientAddress: null }, "Sega gubben")).toEqual([
      "Sega gubben",
    ]);
    expect(recipientLines({ ...BASIS, recipientAddress: "Torget 2" }, "Sega gubben")).toEqual([
      "Sega gubben",
    ]);
  });

  it("mottagaren är butikens ägare när butiken har en", () => {
    const owned: StoreBasis = {
      ...rev2,
      recipientAddress: "Torget 2, 411 01 Exempelstad",
      recipient: {
        name: "Godisbolaget Väst AB",
        orgNumber: "559900-1236",
        vatNumber: "SE559900123601",
        address: "Exempelgatan 4, 411 01 Exempelstad",
      },
    };
    expect(recipientLines(owned, "Kiosken Stationen")).toEqual([
      "Godisbolaget Väst AB",
      "För butiken Kiosken Stationen",
      "Org.nr 559900-1236",
      "Exempelgatan 4, 411 01 Exempelstad",
      "Momsreg.nr SE559900123601",
    ]);
    expect(recipientMissing(owned)).toBe(false);
    // Bolaget heter som butiken: ingen rad om butiken. Utan ägarens adress: butikens.
    const same: StoreBasis = {
      ...owned,
      recipient: {
        name: "Kiosken Stationen",
        orgNumber: "559900-1236",
        vatNumber: null,
        address: null,
      },
    };
    expect(recipientLines(same, "kiosken  stationen")).toEqual([
      "Kiosken Stationen",
      "Org.nr 559900-1236",
      "Torget 2, 411 01 Exempelstad",
    ]);
    expect(recipientParts(owned, "Kiosken Stationen").storeLine).toBe(
      "För butiken Kiosken Stationen",
    );
    // Avtalsraden nämner bolaget, inte butikens namn.
    expect(
      agreementLine({ ...owned, agreementForm: "oral" }, "Kiosken Stationen", {
        termsText: "hyra 1 500 kr per månad",
      }),
    ).toContain("mellan Binderlab AB och Godisbolaget Väst AB");
    // Utgåva 1 visar aldrig bolaget (rapporten visas som den visades då).
    expect(recipientLines({ ...owned, rev: undefined }, "Kiosken Stationen")).toEqual([
      "Kiosken Stationen",
    ]);
  });

  it("utan ägare saknas butikens bolag (utgåva 2), aldrig i en äldre rapport", () => {
    expect(recipientMissing(rev2)).toBe(true);
    expect(recipientMissing(BASIS)).toBe(false);
    expect(recipientMissing(null)).toBe(false);
  });

  it("momsen: ersättningen gäller platsen, en tjänst med 25 % moms, inte lokalhyra", () => {
    expect(vatSentences(rev2, 749_300)).toEqual([
      "Ersättningen är exklusive moms. Ni fakturerar Binderlab AB och lägger på svensk moms, 25 %.",
      "Ersättningen gäller platsen för automaten i butiken. Det är en tjänst med 25 % moms, inte uthyrning av lokal.",
      "Binderlab AB är säljare av varorna i automaten.",
    ]);
    expect(vatSentences({ ...rev2, vatMode: "none" }, 749_300).join(" ")).not.toContain("lokal");
    expect(vatSentences(BASIS, 749_300).join(" ")).not.toContain("lokal");
  });

  it("meningarna under underlaget i ordning: avtalet, betalningarna, momsen", () => {
    const b: StoreBasis = { ...rev2, agreementForm: "oral", contract: null };
    const notes = basisNotes(
      b,
      rep(749_300, { termsText: "hyra 1 500 kr per månad" }),
      "Sega gubben",
    );
    expect(notes[0]).toBe(
      "Muntligt avtal mellan Binderlab AB och Sega gubben: hyra 1 500 kr per månad.",
    );
    expect(notes.at(-1)).toBe("Binderlab AB är säljare av varorna i automaten.");
  });
});
