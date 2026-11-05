/**
 * GraphQL-dokumenten som Awishs webbpanel (dash.awish.vip) själv skickar, ordagrant ur
 * panelens publika JavaScript (index-*.js, version 1.30.4). Binderlab skickar exakt samma
 * text, variabeltyper och urval, så att servern får samma form som från panelen.
 *
 * Mutationerna svarar med ett skalärt värde (inget urval), precis som i panelen; ett urval
 * på dem nekas av riktiga Awish ("must not have a selection").
 *
 * Låtsas-panelen i testerna (testing/fake-web-server.ts) har en egen kopia av samma
 * dokument och nekar allt som avviker, så en ändring här som inte stämmer med panelen syns
 * i testerna.
 */

/** Inloggning: `input` är signerad base64 av { email, password, timestamp, sign }. */
export const SIGNIN_DOCUMENT =
  "mutation Signin($input: String!) { signin(input: $input) { access_token refresh_token expires_in } }";

/** Inloggad användare; `merchant.id` behövs för valutorna. */
export const PROFILE_DOCUMENT =
  "query Profile { profile { id email username profile_url status email_verified_at permissions merchant { id title logo verified_at expired_at is_dev debug tax_enabled } role { id name display_name } is_readonly is_email_verified agent { id parent_id agent_level_id agent_type_id commission_rate name path status region_code } } }";

/** Enheter och butikens valutor (input: { merchant_id }). Panelens sida "Ny vara". */
export const UNITS_AND_CURRENCIES_DOCUMENT =
  "query UnitsAndCurrencies($input: CurrenciesQueryInput!) { units { id name display_name multiplier base_unit description } currencies(input: $input) { id name code symbol } }";

/** Varor (input: { per_page, current_page }), som panelens dialog "Välj vara" för ett fack. */
export const GOODS_DOCUMENT =
  "query Goods($input: GoodsQueryInput!) { goods(input: $input) { total currentPage perPage lastPage data { id name description multi_currency_enabled prices { id price original_price member_price cost_price currency { id name code symbol } } thumb media content slug updated_at age_verification_enabled age_verification_min unit { id name display_name multiplier base_unit description } attributes { id label_name label_value immutable } is_tax_exempt tax_rate is_returnable } } goodsStatistics { id title header_extra value footer link disabled } }";

/** Ny vara. Svarar med ett skalärt värde (inget urval). */
export const CREATE_GOOD_DOCUMENT =
  "mutation CreateGood($input: GoodInput!) { createGood(input: $input) }";

/**
 * Ändra vara ("Redigera vara"). Panelens sida skickar hela varan tillbaka (GoodInput) med
 * varans id; se goods-edit.ts (encodeUpdateGoodInput). Skalärt svar.
 */
export const UPDATE_GOOD_DOCUMENT =
  "mutation UpdateGood($id: Int!, $input: GoodInput!) { updateGood(id: $id, input: $input) }";

/** Automatens kategorier (skärmens flikar). Dokumenterat; Binderlab skickar inget med det. */
export const CATEGORIES_DOCUMENT =
  "query Categories($machine_id: Int!) { categories(machine_id: $machine_id) { id title machine_id sort_id is_visible priority } }";

/**
 * En automats fack. `input` är signerad base64 av { machine_id } (panelen lägger även till
 * addr, kortets nummer; utan addr svarar Awish med automatens fack som i påfyllningen).
 */
export const PRODUCTS_DOCUMENT =
  "query Products($input: String!) { products(input: $input) { id machine_id status floor_status lock_status lock_id current_inventory inventory channel { id model_id name total sort_id motor_id x y addr is_dc is_lp } locker { id model_id name total sort_id motor_id x y addr } good { id name description price original_price multi_currency_enabled prices { id price original_price currency { id name code symbol } } thumb media content slug updated_at age_verification_enabled age_verification_min unit { id name display_name multiplier base_unit description immutable } attributes { id label_name label_value immutable } is_returnable } } }";

/** Ett facks vara, status och antal: input { good_id, status, current_inventory }. Skalärt svar. */
export const UPDATE_PRODUCT_DOCUMENT =
  "mutation UpdateProduct($id: Int!, $input: ProductInput!) { updateProduct(id: $id, input: $input) }";

/**
 * "Synka fack" i panelen: skapar automatens fack ur modellens kanaler. Bara för panelens
 * root-konto; Binderlab anropar den aldrig (facken måste redan finnas).
 */
export const CREATE_PRODUCT_DOCUMENT =
  "mutation CreateProduct($machine_id: Int!) { createProduct(machine_id: $machine_id) }";

/** Panelens uppladdning av bilder (VITE_GLOB_UPLOAD_URL), relativt panelens adress. */
export const UPLOAD_PATH = "/api/v1/files";

/**
 * Formulärfälten panelen skickar med en varubild (MediumUpload på sidan "Ny vara", extraData
 * resize/crop/thumbnail 400×400 och standardkomprimering 80). Filen skickas som fältet "file".
 */
export const GOOD_IMAGE_UPLOAD_FIELDS = {
  compress: JSON.stringify({ quality: 80 }),
  crop: JSON.stringify({ width: 400, height: 400 }),
  thumbnail: JSON.stringify({ width: 400, height: 400 }),
  resize: JSON.stringify({ width: 400, height: 400 }),
} as const;
