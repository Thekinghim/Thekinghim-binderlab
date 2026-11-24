/**
 * Kontraktet för styrningen via Awishs gRPC-API v1.2.41 (de nya anropen). P2 (Styr
 * automaten) och P3 (katalog och medlemmar) bygger mot de här typerna; ändras de ska det
 * meddelas. Klienten finns i ./client.ts, skyddet runt varje skrivning i ./guard.ts.
 *
 * Id är text (uint64 i proto-filen). Belopp är text som Awish skickar dem ("79.00").
 */

import type { AwishPage } from "../grpc-client";

export type { AwishPage };

/** SuccessResponse från en skrivning (code 0 eller 2xx). data = Struct som vanligt objekt. */
export interface AwishControlWriteResult {
  code: number;
  message: string;
  requestId: string | null;
  data: Record<string, unknown> | null;
}

export interface AwishMerchantDetail {
  id: string;
  title: string;
  expiredAt: string | null;
  timezone: string | null;
  whitelistIp: string | null;
  taxEnabled: boolean | null;
}

export interface AwishMachineConfig {
  volume: number | null;
  brightness: number | null;
  language: string | null;
  appVersion: string | null;
  standbyAdsAutoplay: boolean;
  standbyAdsEnabled: boolean;
  standbyAdsSwitchInterval: number;
  carouselAdsEnabled: boolean;
  carouselAdsSwitchInterval: number;
  temperature: string | null;
  uptimeMinutesToday: number | null;
}

export interface AwishMachineDetail {
  id: string;
  name: string;
  machineNo: string;
  isOnline: boolean;
  status: string;
  config: AwishMachineConfig | null;
}

export interface AwishChannelInfo {
  id: string;
  name: string;
  addr: string;
  motorId: string;
  floorType: number;
  total: number;
}

export interface AwishProductDetail {
  id: string;
  machineId: string;
  status: boolean;
  floorStatus: string | null;
  lockStatus: string | null;
  currentInventory: number;
  capacity: number;
  goodId: string | null;
  goodName: string | null;
  channel: AwishChannelInfo | null;
}

export interface AwishCategory {
  id: string;
  title: string;
}

export interface AwishCurrencyInfo {
  id: string;
  name: string;
  code: string;
  symbol: string;
}

/** En medlem som Awish skickar den (tel och e-post är redan maskade av Awish). */
export interface AwishMember {
  id: string;
  name: string;
  telMasked: string;
  emailMasked: string;
  memberNo: string;
  machineId: string | null;
  principalBalance: string;
  bonusBalance: string;
  totalBalance: string;
  points: number;
  levelId: number;
  status: number;
  registeredAt: string;
  remark: string | null;
}

export interface AwishGoodPriceInput {
  /** "0" = nytt pris. */
  id?: string;
  /** "79.00" */
  price: string;
  currencyId: string;
  originalPrice?: string;
  memberPrice?: string;
  costPrice?: string;
}

export interface AwishGoodInput {
  name: string;
  description: string;
  prices: AwishGoodPriceInput[];
  thumb?: string;
  media?: string[];
  content?: string;
  barcode?: string;
  ageVerificationEnabled?: boolean;
  ageVerificationMin?: number;
  isTaxExempt?: boolean;
  taxRate?: string;
  isReturnable?: boolean;
  categoryId?: string;
}

export type AwishPowerMethod = "REBOOT" | "SHUTDOWN";

/** Mån..Sön, 1 = på. */
export type Weekdays = readonly [0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1];

export interface AwishShipmentInput {
  machineId: string;
  addr: string;
  code?: string;
  motorIds: string[];
  floorType?: number;
  isLp?: boolean;
  isDc?: boolean;
}

export interface AwishMachineConfigInput {
  machineId: string;
  standbyAdsAutoplay?: boolean;
  standbyAdsEnabled?: boolean;
  carouselAdsEnabled?: boolean;
  carouselAdsSwitchInterval?: number;
  standbyAdsSwitchInterval?: number;
}

export interface AwishMemberInput {
  name: string;
  tel?: string;
  email?: string;
  memberNo?: string;
  machineId?: string;
  levelId?: number;
  status?: 0 | 1 | 2;
  remark?: string;
}

/** Aldrig saldo eller lösenord från Binderlab. */
export type AwishMemberPatch = Partial<AwishMemberInput>;

export interface AwishControlApi {
  /** Version (osignerad läsning). */
  version(): Promise<string>;
  merchantDetail(): Promise<AwishMerchantDetail>;
  machineDetail(awishMachineId: string): Promise<AwishMachineDetail>;
  productDetails(awishMachineId: string): Promise<AwishProductDetail[]>;
  categories(): Promise<AwishCategory[]>;
  currencies(): Promise<AwishCurrencyInfo[]>;
  members(page: { currentPage: number; perPage: number }): Promise<AwishPage<AwishMember>>;
  /** Skickar BARA {timezone}; aldrig config (där ligger appid och nycklar). */
  updateMerchantTimezone(timezone: string): Promise<AwishControlWriteResult>;
  deleteBanner(i: { machineId: string; id: string }): Promise<AwishControlWriteResult>;
  createCategory(i: {
    title: string;
    priority?: number;
    isVisible?: boolean;
  }): Promise<AwishControlWriteResult>;
  updateCategory(i: {
    id: string;
    title?: string;
    priority?: number;
    isVisible?: boolean;
  }): Promise<AwishControlWriteResult>;
  deleteCategory(id: string): Promise<AwishControlWriteResult>;
  createGood(i: AwishGoodInput): Promise<AwishControlWriteResult>;
  updateGood(id: string, patch: Partial<AwishGoodInput>): Promise<AwishControlWriteResult>;
  deleteGood(id: string): Promise<AwishControlWriteResult>;
  updateProduct(i: {
    id: string;
    goodId?: string;
    categoryId?: string;
    status?: boolean;
    currentInventory?: number;
  }): Promise<AwishControlWriteResult>;
  batchUpdateProducts(i: {
    machineId: string;
    ids: string[];
    goodId?: string;
    categoryId?: string;
    status?: boolean;
  }): Promise<AwishControlWriteResult>;
  replenishProductInventory(i: {
    machineId: string;
    ids: string[];
  }): Promise<AwishControlWriteResult>;
  controlPower(i: {
    machineId: string;
    method: AwishPowerMethod;
  }): Promise<AwishControlWriteResult>;
  setPowerSchedule(i: {
    machineId: string;
    weekdays: Weekdays;
    /** HH:MM:SS */
    powerOn: string;
    powerOff: string;
  }): Promise<AwishControlWriteResult>;
  clearPowerSchedule(machineId: string): Promise<AwishControlWriteResult>;
  executeShipment(i: AwishShipmentInput): Promise<AwishControlWriteResult>;
  updateMachineConfig(i: AwishMachineConfigInput): Promise<AwishControlWriteResult>;
  batchCreateMembers(items: AwishMemberInput[]): Promise<AwishControlWriteResult>;
  updateMember(id: string, patch: AwishMemberPatch): Promise<AwishControlWriteResult>;
  deleteMember(id: string): Promise<AwishControlWriteResult>;
  close(): void;
}
