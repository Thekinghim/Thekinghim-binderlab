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
  // Drift
  {
    module: "@/app/(app)/drift/actions",
    name: "acknowledgeAlert",
    allowed: OP,
    args: (c) => [c.idsA.alerts],
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
  { module: "@/app/(app)/expansion/actions", name: "deleteGoal", allowed: OP, args: id("goals") },
  // Inköpspriser
  {
    module: "@/app/(app)/inkopspriser/actions",
    name: "addPurchasePrice",
    allowed: OP,
    args: (c) => [sink(c, { unitCostOre: 1, validFrom: "2025-06-01" })],
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
    name: "saveOwnerShares",
    allowed: ["owner"],
    args: () => [{ validFrom: "2025-06-01", shares: [{ holderName: "Rödteam", shareBp: 10000 }] }],
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
  // Inbjudan (auth)
  {
    module: "@/server/actions/auth",
    name: "createInvite",
    allowed: OP,
    args: (c) => [{ organizationId: c.A.orgId, email: "x-rodteam@example.se", role: "owner" }],
  },
];
