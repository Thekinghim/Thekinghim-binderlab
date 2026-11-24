/**
 * Gränssnittet för styrning via Awish Open API v1.2.41 (fryst kontrakt mellan paketen).
 * Klienten (client.ts) mappar camelCase till protons snake_case och signerar varje
 * skrivning (sign.ts).
 */

import type { AwishPage } from "../grpc-client";

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
  id?: string /* "0"=new */;
  price: string /* "79.00" */;
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
export type Weekdays = readonly [0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1]; // Mon..Sun
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
export type AwishMemberPatch = Partial<AwishMemberInput>; // never balance or password from Binderlab UI
export interface AwishControlApi {
  version(): Promise<string>;
  merchantDetail(): Promise<AwishMerchantDetail>;
  machineDetail(awishMachineId: string): Promise<AwishMachineDetail>;
  productDetails(awishMachineId: string): Promise<AwishProductDetail[]>;
  categories(): Promise<AwishCategory[]>;
  currencies(): Promise<AwishCurrencyInfo[]>;
  members(page: { currentPage: number; perPage: number }): Promise<AwishPage<AwishMember>>;
  updateMerchantTimezone(timezone: string): Promise<AwishControlWriteResult>; // sends ONLY {timezone}
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
    powerOn: string /*HH:MM:SS*/;
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
