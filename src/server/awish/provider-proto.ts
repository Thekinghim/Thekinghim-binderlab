/**
 * Awish provider.proto (leverantörens fil, "Vending Machine gRPC Interface Documentation",
 * AW-DOC-110, v1.2.41, godkänd 2026-11-23) som text, så att inget läses från disk vid körning
 * (Vercel paketerar inte lösa filer). Ändrad bara så här: kommentarerna och
 * `option (google.api.http)` (REST-mappningen) är borttagna, och därmed importen av
 * google/api/annotations.proto. Fältnummer, typer och tjänsten är oförändrade.
 *
 * v1.2.41 numrerade om fälten i bland annat Product, Machine, Banner och svaren med
 * code/message (MerchantResponse, BannerListResponse). Den gamla texten (rev. 2026-08-18)
 * avkodade därför Products fel från 24 nov. 2026. Binderlab läser Merchant, Machines,
 * Orders, Order, Products, Banners och PickupCodes. Skrivande anrop (CreateBanner m.fl.)
 * kräver från v1.2.40 timestamp + sign (HMAC-SHA256, se dokumentationen 8.13).
 */

export const AWISH_PROVIDER_PROTO = `syntax = "proto3";

option java_multiple_files = true;
option java_package = "io.grpc.provider";
option java_outer_classname = "provider";

package provider;

import "google/protobuf/wrappers.proto";
import "google/protobuf/empty.proto";
import "google/protobuf/any.proto";
import "google/protobuf/struct.proto";

message SuccessResponse {

	int64 code = 1;

	string message = 2;

	google.protobuf.Struct data = 3;

	optional string request_id = 4;
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

message MerchantConfig {

	bool debug = 1;

	bool is_dev = 2;

	string appid = 3;

	optional string app_secret = 4;

	string app_key = 5;

	string timezone = 6;

	optional string whitelist_ip = 7;

	optional bool tax_enabled = 8;
}

message MerchantResponse {

	int64 code = 1;

	string message = 2;

	Merchant data = 3;

	optional string request_id = 4;
}

message UpdateMerchantRequest {
	optional string title = 1;

	optional string keywords = 2;

	optional string description = 3;

	optional string timezone = 4;

	optional MerchantConfig config = 5;

	int64 timestamp = 6;

	string sign = 7;
}

message ShipmentRequest {
	uint64 machine_id = 1;

	uint64 addr = 2;

	optional uint64 code = 3;

	repeated uint64 motor_ids = 4;

	optional int64 floor_type = 5;

	optional bool is_lp = 6;

	optional bool is_dc = 7;

	int64 timestamp = 8;

	string sign = 9;
}

message PowerControlRequest {
	enum Method {
		UNSPECIFIED = 0;
		REBOOT      = 1;
		SHUTDOWN    = 2;
	}

	uint64 machine_id = 1;

	Method method = 2;

	int64 timestamp = 3;

	string sign = 4;
}

message PowerScheduleRequest {
	uint64 machine_id = 1;

	string power_on = 2;

	string power_off = 3;

	repeated int64 weekdays = 4;

	int64 timestamp = 5;

	string sign = 6;
}

message ClearPowerScheduleRequest {
	uint64 machine_id = 1;

	int64 timestamp = 2;

	string sign = 3;
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

message Banner {

	uint64 id = 1;

	bool is_visible = 2;

	optional int64 expired_at = 3;

	optional string link_url = 4;

	optional string video_url = 5;

	optional string cover_image = 6;

	int64 sort_id = 7;

	uint64 hit_count = 8;

	uint64 views_count = 9;

	string title = 10;

	int64 view_type = 11;

	uint32 media_type = 12;
}

message BannerListRequest {

	uint64 machine_id = 1;

	optional int64 view_type = 2;
}

message BannerListResponse {

	int64 code = 1;

	string message = 2;

	repeated Banner data = 3;

	optional string request_id = 4;
}

message CreateBannerRequest {

	uint64 machine_id = 1;

	optional string link_url = 2;

	optional string video_url = 3;

	optional string cover_image = 4;

	optional string title = 5;

	optional int64 expired_at = 6;

	optional int64 view_type = 7;

	optional int64 media_type = 8;

	optional bool is_link = 9;

	optional int64 timestamp = 10;

	optional string sign = 11;
}

message UpdateBannerRequest {

	uint64 id = 1;

	uint64 machine_id = 2;

	optional string link_url = 3;

	optional string video_url = 4;

	optional string cover_image = 5;

	optional string title = 6;

	optional int64 expired_at = 7;

	optional int64 view_type = 8;

	optional int64 media_type = 9;

	optional int64 timestamp = 10;

	optional string sign = 11;
}

message DeleteBannerRequest {

	uint64 machine_id = 1;

	uint64 id = 2;

	int64 timestamp = 3;

	string sign = 4;
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

	int64 code = 3;

	string message = 4;
}

message CreatePickupCodesRequest {

	uint64 machine_id = 1;

	optional bool status = 2;

	uint64 product_id = 3;

	optional uint64 quantity = 4;

	optional int64 expired_at = 5;

	int64 timestamp = 6;

	string sign = 7;

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

	int64 code = 1;

	string message = 2;

	repeated Currency data = 3;

	optional string request_id = 4;
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

	bool standby_ads_autoplay = 24;

	bool standby_ads_enabled = 25;

	uint32 standby_ads_count = 26;

	uint32 standby_ads_switch_interval = 27;

	bool carousel_ads_enabled = 28;

	uint32 carousel_ads_count = 29;

	uint32 carousel_ads_switch_interval = 30;
}

message UpdateMachineConfigRequest {
	uint64 machine_id = 1;

	optional bool standby_ads_autoplay = 2;

	optional bool standby_ads_enabled = 3;

	optional bool carousel_ads_enabled = 4;

	optional uint32 carousel_ads_switch_interval = 5;

	optional uint32 standby_ads_switch_interval = 7;

	int64 timestamp = 9;

	string sign = 10;
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

	optional MachineConfig config = 17;

	optional Model model = 18;
}

message MachineRequest {

	uint64 id = 1;
}

message MachineListRequest {

	optional int64 current_page = 1;
	optional int64 per_page     = 2;

	optional string cursor = 3;
	optional int64  limit  = 4;
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

message Category {
	uint64 id    = 1;
	string title = 2;
}

message DeleteCategoryRequest {
	uint64 id = 1;

	int64 timestamp = 2;

	string sign = 3;
}

message CreateCategoryRequest {
	string title = 1;

	optional uint64 priority = 2;

	optional bool is_visible = 3;

	int64 timestamp = 4;

	string sign = 5;
}

message UpdateCategoryRequest {

	uint64 id = 1;

	optional string title = 2;

	optional uint64 priority = 3;

	optional bool is_visible = 4;

	int64 timestamp = 5;

	string sign = 6;
}

message CategoryResponse {

	int64 code = 1;

	string message = 2;

	repeated Category data = 3;

	optional string request_id = 4;
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

	optional bool is_used = 11;
}

message ChannelListRequest {

	uint64 machine_id = 1;

	optional uint64 addr = 2;
}

message ChannelListResponse {
	repeated Channel data       = 1;
	optional string  request_id = 2;
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

	optional Currency currency = 4;
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

	int64 code = 9;

	string message = 10;
}

message GoodPriceRequest {

	uint64 id = 1;

	string price = 2;

	uint64 currency_id = 3;

	optional string original_price = 4;
	optional string member_price   = 5;
	optional string cost_price     = 6;
}

message CreateGoodRequest {
	string name = 2;

	string description = 3;

	repeated GoodPriceRequest prices = 4;

	optional string thumb = 5;

	repeated string media = 6;

	optional string content = 7;

	optional string barcode = 8;

	optional bool age_verification_enabled = 9;

	optional int64 age_verification_min = 10;

	optional bool is_tax_exempt = 11;

	optional string tax_rate = 12;

	optional bool is_returnable = 13;

	optional uint64 category_id = 14;

	int64 timestamp = 20;

	string sign = 21;
}

message UpdateGoodRequest {
	uint64 id = 1;

	optional string name = 2;

	optional string description = 3;

	repeated GoodPriceRequest prices = 4;

	optional string thumb = 5;

	repeated string media = 6;

	optional string content = 7;

	optional string barcode = 8;

	optional bool age_verification_enabled = 9;

	optional int64 age_verification_min = 10;

	optional bool is_tax_exempt = 11;

	optional string tax_rate = 12;

	optional bool is_returnable = 13;

	optional uint64 category_id = 14;

	int64 timestamp = 20;

	string sign = 21;
}

message DeleteGoodRequest {

	uint64 id = 1;

	int64 timestamp = 10;

	string sign = 11;
}

message Member {
	uint64 id = 1;

	string name = 2;

	string tel = 3;

	string email = 4;

	optional uint64 machine_id = 5;

	string member_no = 6;

	string principal_balance = 7;

	string bonus_balance = 8;

	string total_balance = 9;

	int64 points = 10;

	int64 total_points = 11;

	int64 level_id = 12;

	uint64 status = 13;

	string registered_at = 14;

	optional string remark = 15;
}

message MemberListRequest {

	optional int64 current_page = 1;

	optional int64 per_page = 2;

	optional string cursor = 3;

	optional int64 limit = 4;
}

message MemberListResponse {

	repeated Member data = 1;

	optional int64 total = 2;

	optional int64 current_page = 3;

	optional int64 per_page = 4;

	optional int64 last_page = 5;

	optional string next_cursor = 6;

	optional bool has_more = 7;

	optional string request_id = 8;

	int64 code = 9;

	string message = 10;

}

message CreateMemberItem {
	string name = 1;

	optional string tel = 2;

	optional string email = 3;

	optional string member_no = 4;

	optional uint64 machine_id = 5;

	optional string principal_balance = 7;

	optional int64 level_id = 8;

	optional uint64 status = 9;

	optional string password = 10;

	optional string remark = 11;

	optional string registered_at = 14;
}

message BatchCreateMembersRequest {

	repeated CreateMemberItem members = 1;

	int64 timestamp = 2;

	string sign = 3;
}

message UpdateMemberRequest {
	uint64 id = 1;

	optional string name = 2;

	optional string tel = 3;

	optional string email = 4;

	optional string member_no = 5;

	optional uint64 machine_id = 6;

	optional string principal_balance = 7;

	optional int64 level_id = 8;

	optional uint64 status = 9;

	optional string password = 10;

	optional int64 expired_at = 11;

	optional string remark = 12;

	int64 timestamp = 13;

	string sign = 14;
}

message DeleteMemberRequest {
	uint64 id = 1;

	int64 timestamp = 2;

	string sign = 3;
}

message Product {

	uint64 id = 1;

	uint64 machine_id = 2;

	bool status = 3;

	optional string floor_status = 4;

	optional string lock_status = 5;

	uint64 current_inventory = 6;

	uint64 inventory = 7;

	optional Channel channel = 8;

	optional Good good = 9;

	optional Channel locker = 10;
}

message ProductListRequest {

	uint64 machine_id = 1;

	optional uint64 addr = 2;
}

message ProductListResponse {

	repeated Product data = 1;

	optional string request_id = 2;
}

message UpdateProductRequest {
	uint64 id = 1;

	optional uint64 good_id = 2;

	optional uint64 category_id = 3;

	optional bool status = 4;

	optional uint64 current_inventory = 5;

	int64 timestamp = 6;

	string sign = 7;
}

message BatchUpdateProductRequest {
	repeated uint64 ids = 1;

	uint64 machine_id = 2;

	optional uint64 good_id = 3;

	optional uint64 category_id = 4;

	optional bool status = 5;

	int64 timestamp = 6;

	string sign = 7;
}

message ReplenishProductInventoryRequest {
	uint64 machine_id = 1;

	repeated uint64 ids = 2;

	int64 timestamp = 3;

	string sign = 4;
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

	rpc Currencies (google.protobuf.Empty) returns (CurrencyResponse);

	rpc UpdateMerchant (UpdateMerchantRequest) returns (SuccessResponse);

	rpc DeleteBanner (DeleteBannerRequest) returns (SuccessResponse);

	rpc Categories (google.protobuf.Empty) returns (CategoryResponse);

	rpc CreateCategory (CreateCategoryRequest) returns (SuccessResponse);

	rpc UpdateCategory (UpdateCategoryRequest) returns (SuccessResponse);

	rpc DeleteCategory (DeleteCategoryRequest) returns (SuccessResponse);

	rpc DeleteGood (DeleteGoodRequest) returns (SuccessResponse);

	rpc UpdateProduct (UpdateProductRequest) returns (SuccessResponse);

	rpc BatchUpdateProducts (BatchUpdateProductRequest) returns (SuccessResponse);

	rpc ReplenishProductInventory (ReplenishProductInventoryRequest) returns (SuccessResponse);

	rpc ControlPower (PowerControlRequest) returns (SuccessResponse);

	rpc SetPowerSchedule (PowerScheduleRequest) returns (SuccessResponse);

	rpc ClearPowerSchedule (ClearPowerScheduleRequest) returns (SuccessResponse);

	rpc Version (google.protobuf.Empty) returns (SuccessResponse);

	rpc CreateGood (CreateGoodRequest) returns (SuccessResponse);

	rpc UpdateGood (UpdateGoodRequest) returns (SuccessResponse);

	rpc ExecuteShipment (ShipmentRequest) returns (SuccessResponse);

	rpc UpdateMachineConfig (UpdateMachineConfigRequest) returns (SuccessResponse);

	rpc Members (MemberListRequest) returns (MemberListResponse);

	rpc BatchCreateMembers (BatchCreateMembersRequest) returns (SuccessResponse);

	rpc UpdateMember (UpdateMemberRequest) returns (SuccessResponse);

	rpc DeleteMember (DeleteMemberRequest) returns (SuccessResponse);

}
`;
