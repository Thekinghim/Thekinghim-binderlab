/**
 * Alla server actions i appen (grep '"use server"'), med vilka roller som får anropa dem
 * och ett anrop riktat mot organisationen A:s egna rader (id:n ur fixturen).
 *
 * `allowed` är rollerna i A som får göra ändringen enligt docs/miljoer.md och
 * menyns regler. Alla andra personer (andra roller, butiksanvändaren, en
 * utomstående, en inloggad utan medlemskap och en utloggad) ska nekas, och inget
 * i A får ändras.
 *
 * Anropen är "köksbänksobjekt": alla fält som någon action läser, med A:s id:n.
 * zod tar bort okända fält, så samma objekt passar de flesta actions. När en action
 * validerar före rollkontrollen ger `args` ett giltigt objekt.
 */

import type { Cast, PersonaName } from "./redteam-fas7-harness";

export interface ActionSpec {
  module: string;
  name: string;
  /** Roller i A som får anropa (positiv kontroll görs inte här). */
  allowed: PersonaName[];
  /** Läser bara (ändrar inget även när det lyckas). */
  readOnly?: boolean;
  args: (c: Cast) => unknown[];
}

const OP: PersonaName[] = ["owner", "admin"];
const FIELD: PersonaName[] = ["owner", "admin", "refiller"];
const MEMBERS: PersonaName[] = ["owner", "admin", "viewer", "refiller"];
const ECON: PersonaName[] = ["owner", "admin", "viewer"];

const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);

/** Formuläret "Ny produkt" (FormData med JSON och ev. fingeravtryck). */
function newProductForm(fingerprint?: string): FormData {
  const form = new FormData();
  form.set(
    "input",
    JSON.stringify({ name: "Rödteam", salePrice: "79", purchasePrice: "30", ownProduct: false }),
  );
  if (fingerprint) form.set("fingerprint", fingerprint);
  return form;
}

/** Ett objekt med alla fält som någon action läser, med A:s id:n. */
export function sink(c: Cast, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const a = c.idsA;
  return {
    storeId: c.A.storeId,
    machineId: c.A.machineId,
    titleId: c.A.titleId,
    contractId: c.A.contractId,
    agreementId: c.A.agreementId,
    dataSourceId: c.A.dataSourceId,
    sourceMachineId: c.A.sourceMachineId,
    importId: c.A.importId,
    orderId: c.A.orderIds[0],
    recipientId: a.report_recipients,
    reportId: a.reports,
    membershipId: a.memberships,
    invitationId: a.invitations,
    alertId: a.alerts,
    supplierId: a.suppliers,
    purchaseOrderId: a.purchase_orders,
    releaseId: a.releases,
    experimentId: a.price_experiments,
    leadId: a.expansion_leads,
    goalId: a.goals,
    baselineId: a.baselines,
    fromTitleId: c.A.secondTitleId,
    intoTitleId: c.A.titleId,
    uploadId: a.import_uploads,
    name: "Rödteam",
    code: "RT-1",
    email: "rodteam@example.se",
    note: "rödteam",
    quantity: 1,
    fromWarehouse: false,
    activeFrom: "2025-02-01",
    validFrom: TODAY,
    from: TODAY,
    month: "2025-01",
    archived: true,
    active: false,
    role: "owner",
    key: "rt7:nyckel",
    fingerprint: "rt7",
    ...extra,
  };
}

const id = (table: string) => (c: Cast) => [sink(c, { id: c.idsA[table] })];

export const ACTIONS: ActionSpec[] = [
  // Att göra
  {
    module: "@/app/(app)/att-gora/actions",
    name: "dismissTodo",
    allowed: FIELD,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/att-gora/actions",
    name: "undoDismissTodo",
    allowed: FIELD,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/att-gora/actions",
    name: "registerRefill",
    allowed: FIELD,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/att-gora/actions",
    name: "mergeTitles",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  // Vem gör vad (managerpaket): ansvarig per automat och tilldelning i Att göra
  {
    module: "@/app/(app)/_team/actions",
    name: "setMachineResponsible",
    allowed: OP,
    args: (c) => [sink(c, { userId: "" })],
  },
  {
    module: "@/app/(app)/_team/actions",
    name: "assignTodo",
    allowed: FIELD,
    args: (c) => [sink(c, { key: `refill:${c.A.machineId}:${c.A.titleId}`, userId: "" })],
  },
  // Nya automater från Awish och guiden "Ny butik" (managerpaket 7): ägare och admin
  {
    module: "@/app/(app)/_nya-automater/actions",
    name: "connectNewMachine",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/_nya-automater/actions",
    name: "ignoreNewMachine",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/_nya-automater/actions",
    name: "unignoreNewMachine",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/_nya-automater/actions",
    name: "createStoreGuide",
    allowed: OP,
    args: () => [
      { store: { name: "Rödteam" }, terms: { preset: "split" }, machine: { kind: "new" } },
    ],
  },
  // Assistent: rådgivarens förslag (ägare och admin)
  {
    module: "@/app/(app)/assistent/actions",
    name: "setSuggestionStatus",
    allowed: OP,
    args: (c) => [sink(c, { id: "00000000-0000-4000-8000-000000000000", status: "done" })],
  },
  {
    module: "@/app/(app)/assistent/actions",
    name: "generateSuggestions",
    allowed: OP,
    args: () => [],
  },
  // Automater
  {
    module: "@/app/(app)/automater/actions",
    name: "createMachine",
    allowed: OP,
    args: (c) => [sink(c, { code: "RT-9" })],
  },
  {
    module: "@/app/(app)/automater/actions",
    name: "updateMachine",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/automater/actions",
    name: "moveMachine",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/automater/actions",
    name: "decommissionMachine",
    allowed: OP,
    args: (c) => [sink(c, { activeTo: TODAY })],
  },
  {
    module: "@/app/(app)/automater/actions",
    name: "reactivateMachine",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/automater/enhetsekonomi/actions",
    name: "saveInvestment",
    allowed: OP,
    args: id("machine_investments"),
  },
  // Avtal
  { module: "@/app/(app)/avtal/actions", name: "saveContract", allowed: OP, args: id("contracts") },
  {
    module: "@/app/(app)/avtal/actions",
    name: "archiveContract",
    allowed: OP,
    args: id("contracts"),
  },
  {
    module: "@/app/(app)/avtal/actions",
    name: "createContract",
    allowed: OP,
    args: (c) => [
      sink(c, { target: `store:${c.idsA.stores}`, validFrom: "2099-01-01", confirmHistory: true }),
    ],
  },
  {
    module: "@/app/(app)/avtal/actions",
    name: "setContractStatus",
    allowed: OP,
    args: (c) => [sink(c, { id: c.idsA.contracts, status: "sent" })],
  },
  // Butiker
  // Ny butik, sista steget: kontraktet (städrundan)
  {
    module: "@/app/(app)/butiker/ny/actions",
    name: "finishStoreGuide",
    allowed: OP,
    args: (c) => [
      {
        storeId: c.A.storeId,
        leadId: null,
        terms: { share: "50", base: "profit_after_costs", loss: "zero", vmbBeforeSplit: false },
      },
    ],
  },
  {
    module: "@/app/(app)/butiker/actions",
    name: "createStore",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/butiker/actions",
    name: "updateStore",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/butiker/actions",
    name: "setStoreArchived",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/butiker/actions",
    name: "createAgreement",
    allowed: OP,
    args: (c) => [sink(c, { commission: "10", confirmHistory: true })],
  },
  {
    module: "@/app/(app)/butiker/actions",
    name: "updateAgreement",
    allowed: OP,
    args: (c) => [sink(c, { commission: "10", confirmHistory: true })],
  },
  {
    module: "@/app/(app)/butiker/actions",
    name: "createStoreRecipient",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/butiker/actions",
    name: "updateStoreRecipient",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/butiker/actions",
    name: "deleteStoreRecipient",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  // Datakällor
  {
    module: "@/app/(app)/datakallor/actions",
    name: "createDataSource",
    allowed: OP,
    args: (c) => [sink(c, { provider: "awish_csv" })],
  },
  {
    module: "@/app/(app)/datakallor/actions",
    name: "updateDataSource",
    allowed: OP,
    args: (c) => [sink(c, { id: c.A.dataSourceId })],
  },
  {
    module: "@/app/(app)/datakallor/actions",
    name: "mapSourceMachine",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/datakallor/actions",
    name: "startUpload",
    allowed: OP,
    args: (c) => [sink(c, { fileName: "a.csv", size: 10, sha256: "0".repeat(64) })],
  },
  {
    module: "@/app/(app)/datakallor/actions",
    name: "previewUpload",
    allowed: OP,
    readOnly: true,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/datakallor/actions",
    name: "commitUpload",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/datakallor/actions",
    name: "discardUpload",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  // Datakällor → Awish (gRPC-API): uppgifterna i Vault, test och synk.
  {
    module: "@/app/(app)/datakallor/actions",
    name: "saveAwishCredentials",
    allowed: OP,
    args: (c) => [
      sink(c, { appId: "rodteam-app", appSecret: "rodteam-secret", appKey: "rodteam-key" }),
    ],
  },
  {
    module: "@/app/(app)/datakallor/actions",
    name: "testAwishConnection",
    allowed: OP,
    readOnly: true,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/datakallor/actions",
    name: "syncAwishNow",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  // Datakällor → Awish webbpanel: inloggning i Vault, test och push på/av.
  {
    module: "@/app/(app)/datakallor/actions",
    name: "saveAwishWebCredentials",
    allowed: OP,
    args: (c) => [sink(c, { email: "rodteam@example.com", password: "rodteam-losen" })],
  },
  {
    module: "@/app/(app)/datakallor/actions",
    name: "testAwishWebLogin",
    allowed: OP,
    readOnly: true,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/datakallor/actions",
    name: "previewAwishPush",
    allowed: OP,
    readOnly: true,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/datakallor/actions",
    name: "pushAwishNow",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/datakallor/actions",
    name: "setAwishWebPush",
    allowed: OP,
    args: () => [false],
  },
  // Inköpspriser → Ny produkt: skapar varor och byter vara i fack i Awish (ägare och admin).
  {
    module: "@/app/(app)/inkopspriser/ny-produkt/actions",
    name: "previewNewProduct",
    allowed: OP,
    readOnly: true,
    args: () => [newProductForm()],
  },
  {
    module: "@/app/(app)/inkopspriser/ny-produkt/actions",
    name: "createNewProduct",
    allowed: OP,
    args: () => [newProductForm("0123456789abcdef0123456789abcdef")],
  },
  {
    module: "@/app/(app)/inkopspriser/ny-produkt/actions",
    name: "loadSlotChoices",
    allowed: OP,
    readOnly: true,
    args: (c) => [c.A.machineId],
  },
  {
    module: "@/app/(app)/inkopspriser/ny-produkt/actions",
    name: "previewSlotChange",
    allowed: OP,
    readOnly: true,
    args: (c) => [{ machineId: c.A.machineId, productId: 1, goodId: 1, count: 1 }],
  },
  {
    module: "@/app/(app)/inkopspriser/ny-produkt/actions",
    name: "applySlotChange",
    allowed: OP,
    args: (c) => [
      {
        machineId: c.A.machineId,
        productId: 1,
        goodId: 1,
        count: 1,
        fingerprint: "0123456789abcdef0123456789abcdef",
        confirmed: true,
      },
    ],
  },
  // Drift
  {
    module: "@/app/(app)/drift/actions",
    name: "acknowledgeAlert",
    allowed: OP,
    args: (c) => [c.idsA.alerts],
  },
  // Notiser i mobilen (managerpaket 8): var och en sin egen rad
  {
    module: "@/app/(app)/drift/larm/notice-actions",
    name: "saveNotices",
    allowed: MEMBERS,
    args: () => [{ on: true }],
  },
  {
    module: "@/app/(app)/drift/larm/notice-actions",
    name: "sendTestNotice",
    allowed: MEMBERS,
    args: () => [],
  },
  // Ångra en påfyllning (städrundan): bara egna, inom 30 minuter
  {
    module: "@/app/(app)/drift/actions",
    name: "undoRefills",
    allowed: FIELD,
    args: () => [[crypto.randomUUID()]],
  },
  {
    module: "@/app/(app)/drift/actions",
    name: "removePushDevice",
    allowed: MEMBERS,
    args: (c) => [c.idsA.push_subscriptions],
  },
  {
    module: "@/app/(app)/drift/actions",
    name: "syncRefills",
    allowed: FIELD,
    args: (c) => [
      [
        {
          clientId: crypto.randomUUID(),
          machineId: c.A.machineId,
          titleId: c.A.titleId,
          quantity: 1,
          fromWarehouse: false,
          occurredAt: NOW,
        },
      ],
    ],
  },
  // Effekt
  {
    module: "@/app/(app)/effekt/actions",
    name: "saveBaseline",
    allowed: OP,
    args: id("baselines"),
  },
  {
    module: "@/app/(app)/effekt/actions",
    name: "deleteBaseline",
    allowed: OP,
    args: id("baselines"),
  },
  {
    module: "@/app/(app)/effekt/actions",
    name: "saveMeasurement",
    allowed: OP,
    args: id("effect_measurements"),
  },
  {
    module: "@/app/(app)/effekt/actions",
    name: "deleteMeasurement",
    allowed: OP,
    args: id("effect_measurements"),
  },
  {
    module: "@/app/(app)/effekt/actions",
    name: "saveEffectSettings",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  // Ekonomi
  {
    module: "@/app/(app)/ekonomi/actions",
    name: "reviewDeviation",
    allowed: OP,
    args: (c) => [sink(c, { start: "2025-01-01", end: "2025-01-31", action: "investigated" })],
  },
  {
    module: "@/app/(app)/ekonomi/actions",
    name: "deliverVouchers",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/ekonomi/actions",
    name: "archivePayout",
    allowed: OP,
    args: id("payouts"),
  },
  {
    module: "@/app/(app)/ekonomi/actions",
    name: "saveFixedCost",
    allowed: OP,
    args: id("fixed_costs"),
  },
  {
    module: "@/app/(app)/ekonomi/actions",
    name: "archiveFixedCost",
    allowed: OP,
    args: id("fixed_costs"),
  },
  // Ekonomi → Bokföring (månadspaket, ingen automatisk bokföring)
  {
    module: "@/app/(app)/ekonomi/bokforing-actions",
    name: "saveBokforingSettings",
    allowed: OP,
    args: (c) => [
      sink(c, {
        plan: {
          settlement: "1580",
          sales: "3000",
          sales_vmb: "3211",
          vat_vmb: "2616",
          card_fees: "6040",
          store_share: "6090",
          rent: "5010",
          store_payable: "2990",
        },
        series: "A",
        orgNumber: "",
        purchaseBasis: "cost_of_goods",
        openingCarryOre: 0,
      }),
    ],
  },
  {
    module: "@/app/(app)/ekonomi/bokforing-actions",
    name: "setBokforingVmb",
    allowed: OP,
    args: () => [{ enabled: false }],
  },
  {
    module: "@/app/(app)/ekonomi/bokforing-actions",
    name: "setMonthSent",
    allowed: OP,
    args: (c) => [sink(c, { month: "2025-03", sent: true })],
  },
  {
    module: "@/app/(app)/ekonomi/bokforing-actions",
    name: "uploadReceipts",
    allowed: OP,
    args: () => {
      const form = new FormData();
      form.set("month", "2025-03");
      form.append("file", new File([new TextEncoder().encode("%PDF-1.4\n")], "k.pdf"));
      return [form];
    },
  },
  {
    module: "@/app/(app)/ekonomi/bokforing-actions",
    name: "archiveReceipt",
    allowed: OP,
    args: id("bookkeeping_receipts"),
  },
  // Expansion
  {
    module: "@/app/(app)/expansion/actions",
    name: "saveStoreProfile",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/expansion/actions",
    name: "saveLead",
    allowed: OP,
    args: id("expansion_leads"),
  },
  {
    module: "@/app/(app)/expansion/actions",
    name: "setLeadStage",
    allowed: OP,
    args: id("expansion_leads"),
  },
  {
    module: "@/app/(app)/expansion/actions",
    name: "setLeadArchived",
    allowed: OP,
    args: id("expansion_leads"),
  },
  {
    module: "@/app/(app)/expansion/actions",
    name: "deleteLead",
    allowed: OP,
    args: id("expansion_leads"),
  },
  { module: "@/app/(app)/expansion/actions", name: "saveGoal", allowed: OP, args: id("goals") },
  {
    module: "@/app/(app)/expansion/actions",
    name: "saveGrowthPlan",
    allowed: OP,
    args: () => [{ targetMachines: "25", people: "2", hoursPerPersonWeek: "10" }],
  },
  { module: "@/app/(app)/expansion/actions", name: "deleteGoal", allowed: OP, args: id("goals") },
  // Inköpspriser
  {
    module: "@/app/(app)/inkopspriser/actions",
    name: "addPurchasePrice",
    allowed: OP,
    args: (c) => [sink(c, { unitCostOre: 1, validFrom: "2025-06-01" })],
  },
  {
    module: "@/app/(app)/inkopspriser/actions",
    name: "correctPurchasePrice",
    allowed: OP,
    args: (c) => [sink(c, { unitCostOre: 1 })],
  },
  {
    module: "@/app/(app)/inkopspriser/actions",
    name: "previewPriceSplit",
    allowed: OP,
    readOnly: true,
    args: (c) => [{ titleId: c.A.titleId, unitCostOre: 100, query: "" }],
  },
  // Egen produkt (städrundan)
  {
    module: "@/app/(app)/inkopspriser/actions",
    name: "setOwnProduct",
    allowed: OP,
    args: (c) => [{ titleId: c.A.titleId, ownProduct: true }],
  },
  // Inkorg
  {
    module: "@/app/(app)/inkorg/actions",
    name: "saveIncident",
    allowed: OP,
    args: id("incidents"),
  },
  {
    module: "@/app/(app)/inkorg/actions",
    name: "findOrders",
    allowed: OP,
    readOnly: true,
    args: (c) => [c.A.machineId, "2025-03-01T12:00"],
  },
  // Inställningar
  {
    module: "@/app/(app)/installningar/_actions/settings",
    name: "updateSettings",
    allowed: OP,
    args: () => [{ cardFeeBp: 999, vatRateBp: 2500, fiscalYearStartMonth: 1 }],
  },
  {
    module: "@/app/(app)/installningar/_actions/settings",
    name: "updateCompanyDetails",
    allowed: OP,
    args: () => [
      {
        companyName: "Rödteam AB",
        orgNumber: "559000-0000",
        companyAddress: "Rödgatan 1",
        contactName: "Rödteam",
        contactEmail: "rodteam@example.se",
        contactPhone: "070-000 00 00",
      },
    ],
  },
  {
    module: "@/app/(app)/installningar/_actions/settings",
    name: "saveOwnerShares",
    allowed: ["owner"],
    args: () => [{ validFrom: "2025-06-01", shares: [{ holderName: "Rödteam", shareBp: 10000 }] }],
  },
  // Plattformen (abonnemang): bara plattformsoperatörer, ingen roll i A (test/db/abonnemang.test.ts).
  {
    module: "@/app/plattform/actions",
    name: "savePlan",
    allowed: [],
    args: (c) => [
      {
        organizationId: c.A.orgId,
        effectiveFrom: TODAY,
        status: "active",
        price: "0",
        currency: "SEK",
        trialEndsOn: "",
        countryCode: "SE",
        vatNumber: "",
        note: "Rödteam",
      },
    ],
  },
  {
    module: "@/app/(app)/installningar/anvandare/actions",
    name: "inviteMember",
    allowed: OP,
    args: () => [{ email: "ny-rodteam@example.se", role: "viewer" }],
  },
  {
    module: "@/app/(app)/installningar/anvandare/actions",
    name: "changeMemberRole",
    allowed: OP,
    args: (c) => [sink(c, { role: "viewer" })],
  },
  {
    module: "@/app/(app)/installningar/anvandare/actions",
    name: "removeMember",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/installningar/anvandare/actions",
    name: "revokeInvitation",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/installningar/anvandare/actions",
    name: "resendInvitation",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  // Lager
  {
    module: "@/app/(app)/lager/actions",
    name: "registerRefill",
    allowed: FIELD,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/lager/actions",
    name: "registerCount",
    allowed: FIELD,
    args: (c) => [sink(c, { counted: 1, locationId: c.A.machineLocationId })],
  },
  {
    module: "@/app/(app)/lager/actions",
    name: "registerWaste",
    allowed: FIELD,
    args: (c) => [sink(c, { quantity: 1, note: "Rödteam" })],
  },
  {
    module: "@/app/(app)/lager/actions",
    name: "setSlotAlert",
    allowed: OP,
    args: (c) => [sink(c, { alertAtUnits: 3 })],
  },
  // Vårt lager
  {
    module: "@/app/(app)/vart-lager/actions",
    name: "setHomeCount",
    allowed: OP,
    args: (c) => [sink(c, { counted: 7 })],
  },
  {
    module: "@/app/(app)/vart-lager/actions",
    name: "addReceipt",
    allowed: OP,
    args: (c) => [sink(c, { quantity: 2 })],
  },
  // Vårt lager: flera lager (Hemma, Kontoret …)
  {
    module: "@/app/(app)/vart-lager/actions",
    name: "moveStock",
    allowed: OP,
    args: (c) => [sink(c, { from: c.A.centralLocationId, to: c.A.machineLocationId, quantity: 1 })],
  },
  {
    module: "@/app/(app)/vart-lager/actions",
    name: "undoMove",
    allowed: OP,
    args: (c) => [sink(c, { transferId: c.A.centralLocationId })],
  },
  {
    module: "@/app/(app)/vart-lager/actions",
    name: "createPlace",
    allowed: OP,
    args: (c) => [sink(c, { name: "Rödteamets lager" })],
  },
  {
    module: "@/app/(app)/vart-lager/actions",
    name: "renamePlace",
    allowed: OP,
    args: (c) => [sink(c, { id: c.A.centralLocationId, name: "Rödteam" })],
  },
  {
    module: "@/app/(app)/vart-lager/actions",
    name: "archivePlace",
    allowed: OP,
    args: (c) => [sink(c, { id: c.A.centralLocationId, archived: true })],
  },
  {
    module: "@/app/(app)/vart-lager/actions",
    name: "setRefillSource",
    allowed: OP,
    args: (c) => [{ machineId: c.A.machineId, placeId: c.A.centralLocationId }],
  },
  // Marknad
  {
    module: "@/app/(app)/marknad/actions",
    name: "createRelease",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/marknad/actions",
    name: "updateRelease",
    allowed: OP,
    args: id("releases"),
  },
  {
    module: "@/app/(app)/marknad/actions",
    name: "deleteRelease",
    allowed: OP,
    args: id("releases"),
  },
  {
    module: "@/app/(app)/marknad/actions",
    name: "lockReleasePlan",
    allowed: OP,
    args: id("releases"),
  },
  {
    module: "@/app/(app)/marknad/actions",
    name: "unlockReleasePlan",
    allowed: OP,
    args: id("releases"),
  },
  {
    module: "@/app/(app)/marknad/actions",
    name: "createQuote",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/marknad/actions",
    name: "deleteQuote",
    allowed: OP,
    args: id("supplier_price_quotes"),
  },
  {
    module: "@/app/(app)/marknad/actions",
    name: "saveSlots",
    allowed: OP,
    args: (c) => [sink(c, { slots: [] })],
  },
  {
    module: "@/app/(app)/marknad/actions",
    name: "implementAssortment",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/marknad/actions",
    name: "startExperiment",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/marknad/actions",
    name: "stopExperiment",
    allowed: OP,
    args: id("price_experiments"),
  },
  // Order (läsning)
  {
    module: "@/app/(app)/order/actions",
    name: "loadMoreOrders",
    allowed: ECON,
    readOnly: true,
    args: () => ["period=allt", { offset: 0, afterId: null }],
  },
  {
    module: "@/app/(app)/order/actions",
    name: "getOrderDetail",
    allowed: ECON,
    readOnly: true,
    args: (c) => [c.A.orderIds[0]],
  },
  // Order: markera som testköp och ångra (ägare, admin; 20261105070000_testkop.sql)
  {
    module: "@/app/(app)/order/actions",
    name: "setTestPurchase",
    allowed: OP,
    args: (c) => [c.A.orderIds[0], true],
  },
  // Prognos och inköp
  {
    module: "@/app/(app)/prognos/actions",
    name: "createSupplier",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/prognos/actions",
    name: "updateSupplier",
    allowed: OP,
    args: id("suppliers"),
  },
  {
    module: "@/app/(app)/prognos/actions",
    name: "archiveSupplier",
    allowed: OP,
    args: id("suppliers"),
  },
  {
    module: "@/app/(app)/prognos/actions",
    name: "saveSupplierItem",
    allowed: OP,
    args: id("supplier_items"),
  },
  {
    module: "@/app/(app)/prognos/actions",
    name: "deleteSupplierItem",
    allowed: OP,
    args: id("supplier_items"),
  },
  {
    module: "@/app/(app)/prognos/actions",
    name: "createPurchaseOrder",
    allowed: OP,
    args: (c) => [sink(c, { lines: [{ titleId: c.A.titleId, quantity: 1 }] })],
  },
  {
    module: "@/app/(app)/prognos/actions",
    name: "markPurchaseOrderOrdered",
    allowed: OP,
    args: id("purchase_orders"),
  },
  {
    module: "@/app/(app)/prognos/actions",
    name: "cancelPurchaseOrder",
    allowed: OP,
    args: id("purchase_orders"),
  },
  {
    module: "@/app/(app)/prognos/actions",
    name: "receivePurchaseOrder",
    allowed: OP,
    args: id("purchase_orders"),
  },
  {
    module: "@/app/(app)/prognos/actions",
    name: "closePurchaseOrder",
    allowed: OP,
    args: id("purchase_orders"),
  },
  // Rapporter
  {
    module: "@/app/(app)/rapporter/actions",
    name: "createReport",
    allowed: OP,
    args: (c) => [sink(c, { type: "bokforing" })],
  },
  {
    module: "@/app/(app)/rapporter/actions",
    name: "approveReport",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/app/(app)/rapporter/actions",
    name: "sendReport",
    allowed: OP,
    args: (c) => [sink(c, { recipientIds: [c.idsA.report_recipients] })],
  },
  {
    module: "@/app/(app)/rapporter/actions",
    name: "createRecipient",
    allowed: OP,
    args: (c) => [sink(c, { kind: "accountant" })],
  },
  {
    module: "@/app/(app)/rapporter/actions",
    name: "setRecipientActive",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  // Butiksportalen (från appen)
  {
    module: "@/server/portal/actions",
    name: "inviteStoreUser",
    allowed: OP,
    args: (c) => [sink(c, { email: "butik-rodteam@example.se" })],
  },
  {
    module: "@/server/portal/actions",
    name: "removeStoreUser",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  {
    module: "@/server/portal/actions",
    name: "revokeStoreInvitation",
    allowed: OP,
    args: (c) => [sink(c)],
  },
  // Kampanjer och gratis-pack (skriver till Awish efter bekräftelse; bara ägare och admin)
  {
    module: "@/app/(app)/kampanjer/actions",
    name: "createCampaign",
    allowed: OP,
    args: () => {
      const form = new FormData();
      form.set(
        "input",
        JSON.stringify({
          title: "Rödteam",
          machineIds: [],
          startsOn: null,
          endsOn: TODAY,
          titleId: null,
          reuseImageFrom: null,
        }),
      );
      return [form];
    },
  },
  {
    module: "@/app/(app)/kampanjer/actions",
    name: "stopCampaign",
    allowed: OP,
    args: (c) => [c.idsA.campaigns],
  },
  {
    module: "@/app/(app)/kampanjer/actions",
    name: "retryCampaign",
    allowed: OP,
    args: (c) => [c.idsA.campaigns],
  },
  {
    module: "@/app/(app)/kampanjer/actions",
    name: "loadFreePackChoices",
    allowed: OP,
    readOnly: true,
    args: (c) => [c.A.machineId],
  },
  {
    module: "@/app/(app)/kampanjer/actions",
    name: "createFreePacks",
    allowed: OP,
    args: (c) => [
      {
        machineId: c.A.machineId,
        productId: "1",
        quantity: 1,
        days: 7,
        reason: "giveaway",
        recipient: null,
        note: null,
      },
    ],
  },
  // Månadsavräkning per butik (Butiker → Butiksportal; bara ägare och admin)
  {
    module: "@/app/(app)/butiker/settlement-actions",
    name: "markSettlementPaid",
    allowed: OP,
    args: (c) => [c.idsA.store_settlements, TODAY, 0],
  },
  {
    module: "@/app/(app)/butiker/settlement-actions",
    name: "createMissingSettlements",
    allowed: OP,
    args: () => [],
  },
  {
    module: "@/app/(app)/butiker/settlement-actions",
    name: "undoSettlementPaid",
    allowed: OP,
    args: (c) => [c.idsA.store_settlements],
  },
  {
    module: "@/app/(app)/butiker/settlement-actions",
    name: "recomputeSettlement",
    allowed: OP,
    args: (c) => [c.idsA.store_settlements],
  },
  // Signering på plats: engångslänk till avtalets PDF (bara ägare och admin)
  {
    module: "@/app/(app)/avtal/actions",
    name: "createSigningLink",
    allowed: OP,
    args: (c) => [c.idsA.contracts],
  },
  // Inbjudan (auth)
  {
    module: "@/server/actions/auth",
    name: "createInvite",
    allowed: OP,
    args: (c) => [{ organizationId: c.A.orgId, email: "x-rodteam@example.se", role: "owner" }],
  },
];
