/**
 * Awish provider.proto (leverantörens fil, "Vending Machine gRPC Interface Documentation",
 * AW-DOC-110, rev. 2026-08-18) som text, så att inget läses från disk vid körning
 * (Vercel paketerar inte lösa filer). Ändrad bara så här: kommentarerna och
 * `option (google.api.http)` (REST-mappningen) är borttagna, och därmed importen av
 * google/api/annotations.proto. Fältnummer, typer och tjänsten är oförändrade.
 * Binderlab läser Merchant, Machines, Orders, Order, Products, Banners och PickupCodes.
 * CreateBanner, UpdateBanner och CreatePickupCode anropas bara efter en bekräftelse i
 * appen (Kampanjer och Gratis-pack, grpc-client.ts AwishMarketingApi).
 */

export const AWISH_PROVIDER_PROTO = `syntax = "proto3";

option java_multiple_files = true;
option java_package = "io.grpc.provider";
option java_outer_classname = "provider";

package provider;

import "google/protobuf/wrappers.proto";
import "google/protobuf/empty.proto";
import "google/protobuf/any.proto";

message MerchantConfig {
  bool debug = 1;
  bool is_dev = 2;
  string appid = 3;
  optional string app_secret = 4;
  string app_key = 5;
}

message Merchant {
  uint64 id = 1;
  string title = 2;
  string keywords = 3;
  string description = 4;
  optional string logo = 5;
  string status = 6;
  string created_at = 7;
  optional string verified_at = 8;
  optional string expired_at = 9;
  optional MerchantConfig config = 10;
}

message MerchantResponse {
  Merchant data = 1;
  optional string request_id = 2;
}

message FloorTypeDriver {
  bool is_dc = 1;
  bool is_lp = 2;
  uint64 floor_type = 3;
  int64 addr = 4;
  int64 driver_id = 5;
  int64 per_channel_capacity = 6;
  int64 total_channel_slots = 7;
  bool lock_only = 8;
}

message Model {
  uint64 id = 1;
  string name = 2;
  string description = 3;
  string updated_at = 4;
  optional int64 total_channels = 5;
  repeated FloorTypeDriver drivers = 6;
  bool has_lock_feature = 7;
}

message Currency {
  uint64 id = 1;
  string name = 2;
  string code = 3;
  string symbol = 4;
}

message CurrencyResponse {
  repeated Currency data = 1;
  optional string request_id = 2;
}

message MachineConfig {
  uint64 id = 1;
  uint32 price_digits = 2;
  bool price_thousands = 3;
  bool price_line = 4;
  optional uint32 volume = 5;
  optional uint32 brightness = 6;
  optional string language = 7;
  optional string app_version = 8;
  optional string android_version = 9;
  optional string java_version = 10;
  optional string sdk_version = 11;
  optional string device_model = 12;
  optional string manufacturer = 13;
  optional string serial_no = 14;
  optional uint32 screen_width = 15;
  optional uint32 screen_height = 16;
  optional string network_type = 17;
  optional string network_sim_iccid = 18;
  optional uint32 network_rssi = 19;
  optional uint32 uptime_minutes_today = 20;
  optional string temperature = 21;
  optional string humidity = 22;
  string app_navbar_logo = 23;
}

message Machine {
  uint64 id = 1;
  string name = 2;
  optional string client_id = 3;
  optional string imei = 4;
  uint64 status = 6;
  bool is_online = 7;
  uint32 connect_type = 8;
  uint32 machine_type = 9;
  optional string cover_image = 10;
  optional string contact = 11;
  optional string tel = 12;
  optional string address = 13;
  optional string qrcode = 14;
  string machine_no = 15;
  optional string password = 16;
  optional MachineConfig config = 19;
  optional Model model = 20;
}

message MachineRequest {
  uint64 id = 1;
}

message MachineListRequest {
  optional int64 current_page = 1;
  optional int64 per_page = 2;
  optional string cursor = 3;
  optional int64 limit = 4;
}

message MachineListResponse {
  repeated Machine data = 1;
  optional int64 total = 2;
  optional int64 current_page = 3;
  optional int64 per_page = 4;
  optional int64 last_page = 5;
  optional string next_cursor = 6;
  optional bool has_more = 7;
  optional string request_id = 8;
}

message MachineResponse {
  int64 code = 1;
  string message = 2;
  Machine data = 3;
  optional string request_id = 4;
}

message DeliveryLog {
  optional string created_at = 1;
  optional string updated_at = 2;
  uint64 id = 3;
  uint64 machine_id = 4;
  string code = 5;
  string event_id = 6;
  int64 priority = 7;
  string status = 8;
  string fail_reason = 9;
}

message OrderRecord {
  uint64 id = 1;
  uint64 product_id = 2;
  uint64 quantity = 3;
  string price = 4;
  string tax_amount = 5;
  repeated DeliveryLog delivery_logs = 6;
}

message Order {
  uint64 id = 1;
  string date = 2;
  optional string trade_id = 3;
  optional string title = 4;
  string amount = 5;
  optional string pay_time = 6;
  string status = 7;
  bool is_free = 8;
  optional string tax_total = 9;
  optional uint64 pickup_code_id = 10;
  uint64 payment_id = 11;
  uint64 machine_id = 12;
  repeated OrderRecord order_records = 19;
  optional string total_cash_amount = 20;
  optional string change_cash_amount = 21;
}

message OrderRequest {
  uint64 id = 1;
}

message OrderResponse {
  int64 code = 1;
  string message = 2;
  Order data = 3;
  optional string request_id = 4;
}

message OrderListRequest {
  optional int64 current_page = 1;
  optional int64 per_page = 2;
  optional string cursor = 3;
  optional int64 limit = 4;
  repeated uint64 machine_ids = 5;
  optional uint32 status = 6;
  optional uint32 trade_type = 7;
  optional string trade_id = 8;
}

message OrderListResponse {
  repeated Order data = 1;
  optional int64 total = 2;
  optional int64 current_page = 3;
  optional int64 per_page = 4;
  optional int64 last_page = 5;
  optional string next_cursor = 6;
  optional bool has_more = 7;
  optional string request_id = 8;
}

message Channel {
  uint64 id = 1;
  uint64 model_id = 2;
  string name = 3;
  int64 total = 4;
  uint64 floor_type = 5;
  int64 motor_id = 6;
  int64 x = 7;
  int64 y = 8;
  uint64 addr = 9;
  bool is_auxiliary = 10;
  optional bool is_used = 12;
}

message ChannelListRequest {
  uint64 machine_id = 1;
  optional uint64 addr = 2;
}

message ChannelListResponse {
  repeated Channel data = 1;
  optional string request_id = 2;
}

message Unit {
  uint64 id = 1;
  string name = 2;
  string display_name = 3;
  float multiplier = 4;
  string base_unit = 5;
  string description = 6;
  bool immutable = 7;
}

message Attribute {
  uint64 id = 1;
  string label_name = 2;
  repeated string label_value = 3;
  bool immutable = 4;
}

message GoodPrice {
  uint64 id = 1;
  string price = 2;
  optional string original_price = 3;
  optional Currency currency = 6;
}

message Good {
  uint64 id = 1;
  string name = 2;
  optional string description = 3;
  string price = 4;
  optional string original_price = 5;
  repeated string media = 6;
  string content = 7;
  optional string slug = 8;
  string updated_at = 9;
  Unit unit = 10;
  bool age_verification_enabled = 11;
  optional int64 age_verification_min = 12;
  repeated Attribute attributes = 13;
  bool is_tax_exempt = 14;
  optional string tax_rate = 15;
  optional string thumb = 16;
  repeated GoodPrice prices = 17;
  bool multi_currency_enabled = 18;
  optional string barcode = 19;
}

message GoodListRequest {
  optional int64 current_page = 1;
  optional int64 per_page = 2;
  optional string cursor = 3;
  optional int64 limit = 4;
}

message GoodListResponse {
  repeated Good data = 1;
  optional int64 total = 2;
  optional int64 current_page = 3;
  optional int64 per_page = 4;
  optional int64 last_page = 5;
  optional string next_cursor = 6;
  optional bool has_more = 7;
  optional string request_id = 8;
}

message Product {
  uint64 id = 1;
  uint64 machine_id = 4;
  bool status = 5;
  optional string floor_status = 9;
  optional string lock_status = 10;
  uint64 current_inventory = 11;
  uint64 inventory = 12;
  optional Channel channel = 13;
  optional Good good = 15;
  optional Channel locker = 16;
}

message ProductListRequest {
  uint64 machine_id = 1;
  optional uint64 addr = 2;
}

message ProductListResponse {
  repeated Product data = 1;
  optional string request_id = 2;
}

message Banner {
  uint64 id = 1;
  bool is_visible = 4;
  optional int64 expired_at = 5;
  optional string link_url = 7;
  optional string video_url = 9;
  optional string cover_image = 10;
  int64 sort_id = 11;
  uint64 hit_count = 12;
  uint64 views_count = 13;
  string title = 14;
  int64 view_type = 15;
  uint32 media_type = 16;
}

message BannerListRequest {
  uint64 machine_id = 1;
  optional int64 view_type = 2;
}

message BannerListResponse {
  repeated Banner data = 1;
  optional string request_id = 2;
}

message CreateBannerRequest {
  uint64 machine_id = 1;
  optional bool is_link = 10;
  optional string link_url = 2;
  optional string video_url = 4;
  optional string cover_image = 5;
  optional string title = 6;
  optional int64 expired_at = 7;
  optional int64 view_type = 8;
  optional int64 media_type = 9;
}

message UpdateBannerRequest {
  uint64 machine_id = 1;
  optional string link_url = 2;
  optional string video_url = 4;
  optional string cover_image = 5;
  optional string title = 6;
  optional int64 expired_at = 7;
  optional int64 view_type = 8;
  uint64 id = 9;
  optional int64 media_type = 10;
}

message SuccessResponse {
  int64 code = 1;
  string message = 2;
  google.protobuf.Any data = 3;
  optional string request_id = 4;
}

message PickupCode {
  uint64 id = 1;
  uint64 machine_id = 2;
  optional int64 expired_at_millis = 3;
  uint64 product_id = 4;
  string code = 5;
  uint64 quantity = 6;
  optional string expired_at = 7;
  bool status = 8;
}

message PickupCodeListRequest {
  uint64 machine_id = 1;
}

message PickupCodeListResponse {
  repeated PickupCode data = 1;
  optional string request_id = 2;
}

message CreatePickupCodesRequest {
  uint64 machine_id = 1;
  optional int64 expired_at = 5;
  optional bool status = 2;
  uint64 product_id = 3;
  optional uint64 quantity = 4;
}

service Provider {
  rpc Merchant (google.protobuf.Empty) returns (MerchantResponse);
  rpc Machines (MachineListRequest) returns (MachineListResponse);
  rpc Machine (MachineRequest) returns (MachineResponse);
  rpc Orders (OrderListRequest) returns (OrderListResponse);
  rpc Order (OrderRequest) returns (OrderResponse);
  rpc Goods (GoodListRequest) returns (GoodListResponse);
  rpc Products (ProductListRequest) returns (ProductListResponse);
  rpc Banners (BannerListRequest) returns (BannerListResponse);
  rpc CreateBanner (CreateBannerRequest) returns (SuccessResponse);
  rpc UpdateBanner (UpdateBannerRequest) returns (SuccessResponse);
  rpc Channels (ChannelListRequest) returns (ChannelListResponse);
  rpc PickupCodes (PickupCodeListRequest) returns (PickupCodeListResponse);
  rpc CreatePickupCode (CreatePickupCodesRequest) returns (SuccessResponse);
}
`;
