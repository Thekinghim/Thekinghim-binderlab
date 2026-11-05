/**
 * Låtsas-panelens "schema": panelens egna GraphQL-dokument, inklistrade ordagrant ur
 * panelens publika JavaScript (dash.awish.vip, index-*.js, version 1.30.4). Medvetet en egen
 * kopia, skild från ../web-documents.ts som klienten skickar: låtsas-panelen ska neka det
 * klienten gör fel, inte jämföra klienten med sig själv.
 */

export const DASHBOARD_DOCUMENTS: Record<string, string> = {
  Signin:
    "mutation Signin($input: String!) { signin(input: $input) { access_token refresh_token expires_in } }",
  Profile:
    "query Profile { profile { id email username profile_url status email_verified_at permissions merchant { id title logo verified_at expired_at is_dev debug tax_enabled } role { id name display_name } is_readonly is_email_verified agent { id parent_id agent_level_id agent_type_id commission_rate name path status region_code } } }",
  UnitsAndCurrencies:
    "query UnitsAndCurrencies($input: CurrenciesQueryInput!) { units { id name display_name multiplier base_unit description } currencies(input: $input) { id name code symbol } }",
  Goods:
    "query Goods($input: GoodsQueryInput!) { goods(input: $input) { total currentPage perPage lastPage data { id name description multi_currency_enabled prices { id price original_price member_price cost_price currency { id name code symbol } } thumb media content slug updated_at age_verification_enabled age_verification_min unit { id name display_name multiplier base_unit description } attributes { id label_name label_value immutable } is_tax_exempt tax_rate is_returnable } } goodsStatistics { id title header_extra value footer link disabled } }",
  Good: "query Good($id: Int!, $input: CurrenciesQueryInput!) { good(id: $id) { id name description multi_currency_enabled prices { id price original_price member_price cost_price currency { id name code symbol } } thumb media content slug updated_at age_verification_enabled age_verification_min unit { id name display_name multiplier base_unit description } attributes { id label_name label_value immutable } is_tax_exempt tax_rate is_returnable category_id } units { id name display_name multiplier base_unit description } currencies(input: $input) { id name code symbol } }",
  CreateGood: "mutation CreateGood($input: GoodInput!) { createGood(input: $input) }",
  UpdateGood:
    "mutation UpdateGood($id: Int!, $input: GoodInput!) { updateGood(id: $id, input: $input) }",
  Categories:
    "query Categories($machine_id: Int!) { categories(machine_id: $machine_id) { id title machine_id sort_id is_visible priority } }",
  Products:
    "query Products($input: String!) { products(input: $input) { id machine_id status floor_status lock_status lock_id current_inventory inventory channel { id model_id name total sort_id motor_id x y addr is_dc is_lp } locker { id model_id name total sort_id motor_id x y addr } good { id name description price original_price multi_currency_enabled prices { id price original_price currency { id name code symbol } } thumb media content slug updated_at age_verification_enabled age_verification_min unit { id name display_name multiplier base_unit description immutable } attributes { id label_name label_value immutable } is_returnable } } }",
  UpdateProduct:
    "mutation UpdateProduct($id: Int!, $input: ProductInput!) { updateProduct(id: $id, input: $input) }",
  CreateProduct:
    "mutation CreateProduct($machine_id: Int!) { createProduct(machine_id: $machine_id) }",
  Channels:
    "query Channels($addr: Int, $model_id: Int!) { channels(addr: $addr, model_id: $model_id) { id model_id name total motor_id floor_type x y addr is_auxiliary is_dc is_lp } }",
};

/**
 * Fält som panelen själv inte frågar efter men som visats fungera mot riktiga Awish
 * (påfyllningens Products-fråga med good_id har körts i drift).
 */
export const PROVEN_EXTRA_FIELDS: Record<string, readonly string[]> = {
  products: ["good_id"],
};

/** Fälten i GoodInput som panelens "Ny vara" skickar (GoodsCreate). */
export const GOOD_INPUT_FIELDS = [
  "name",
  "description",
  "thumb",
  "content",
  "media",
  "multi_currency_enabled",
  "slug",
  "unit_id",
  "attributes",
  "is_tax_exempt",
  "tax_rate",
  "is_returnable",
  "prices",
] as const;

/** Fälten i ett pris i GoodInput.prices (good_id bara vid ändring av en befintlig vara). */
export const GOOD_PRICE_FIELDS = [
  "id",
  "good_id",
  "currency_id",
  "price",
  "original_price",
  "member_price",
  "cost_price",
] as const;

/** ProductInput: facksidan skickar good_id/status/current_inventory, låsdialogen även resten. */
export const PRODUCT_INPUT_FIELDS = [
  "good_id",
  "status",
  "current_inventory",
  "category_id",
  "lock_id",
] as const;

/** GoodsQueryInput enligt panelens varulista och dialogen "Välj vara". */
export const GOODS_QUERY_FIELDS = [
  "merchant_id",
  "barcode",
  "age_verification_enabled",
  "is_tax_exempt",
  "per_page",
  "current_page",
] as const;

/** Formulärfälten vid uppladdning av en varubild (MediumUpload, extraData). */
export const UPLOAD_FIELDS = ["compress", "crop", "thumbnail", "resize"] as const;
