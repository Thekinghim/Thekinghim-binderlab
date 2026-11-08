-- =============================================================================
-- Mystery packs: innehåll och packning.
--
-- Ägaren packar egna produkter (titles.own_product) hemma: ett yttre omslag med exakt ett
-- oöppnat boosterpack, draget ur en omgång på t.ex. 14 enligt ett recept ("innehåll").
--
-- 1. public.mystery_recipes + public.mystery_recipe_items: innehållet per egen produkt.
--    Varje sparning är en ny version (version, valid_from = dagens datum i organisationens
--    tidszon). Versionerna ändras aldrig (append-only), så en gammal packning pekar alltid
--    på det innehåll den packades med. Summan av antalen = omgångens storlek och minst en
--    rad (kontrolleras vid commit, private.mystery_recipe_check). Skrivs bara via
--    save_mystery_recipe (ägare, admin). Alla roller i appen läser (påfyllaren packar).
-- 2. public.mystery_packings: en rad per packning (omgångar, pack, innehållets version,
--    kostnad per pack då, lagret). Skrivs bara via pack_mystery och undo_mystery_packing.
--    Ägare, admin och läsare läser (kostnaden är ett belopp; påfyllaren ser inga belopp).
-- 3. pack_mystery: EN transaktion. Negativ justering (adjustment) för varje del och en
--    positiv för mystery-packet, i samma lager, med ett gemensamt transfer_group_id och
--    noteringen "Packat 2 omgångar Mystery Pack Plus". Nekas om någon del saknas (vilka och
--    hur många). Idempotent på p_client_id. Ägare, admin och påfyllare.
-- 4. undo_mystery_packing: "Ångra" inom 30 minuter. Motbokar exakt samma händelser
--    (aldrig radering) med ett nytt transfer_group_id. Påfyllaren ångrar bara sina egna.
-- 5. stock_events: transfer_group_id får nu också sitta på justeringar, men bara för en
--    packning eller dess ångring (kontrolleras vid commit i private.stock_events_check_transfer).
--    En packning går alltid jämnt ut (lika många pack ut som in), precis som en flytt.
--
-- Inget befintligt ändras i data. Kostnaden för sålda mystery packs är som förut titelns
-- inköpspris (sidan föreslår "Sätt inköpspris till X kr" när innehållets snitt skiljer sig).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Innehåll (recept), versionerat
-- -----------------------------------------------------------------------------

create table public.mystery_recipes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  title_id uuid not null,
  version integer not null check (version between 1 and 100000),
  valid_from date not null,
  batch_size integer not null check (batch_size between 1 and 200),
  note text check (note is null or char_length(note) between 1 and 500),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  unique (organization_id, title_id, version),
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete restrict
);

comment on table public.mystery_recipes is
  'Mystery packs: innehållet per egen produkt, en rad per version (append-only). Skrivs via save_mystery_recipe.';

create table public.mystery_recipe_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  recipe_id uuid not null,
  component_title_id uuid not null,
  -- Antal av den här titeln per omgång.
  quantity integer not null check (quantity between 1 and 200),
  -- HIT: ett av de fina packen (visas på etiketten och räknas i "chans till hit").
  is_hit boolean not null default false,
  position smallint not null check (position between 0 and 49),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  unique (organization_id, recipe_id, component_title_id),
  unique (organization_id, recipe_id, position),
  foreign key (organization_id, recipe_id) references public.mystery_recipes (organization_id, id)
    on delete restrict,
  foreign key (organization_id, component_title_id) references public.titles (organization_id, id)
    on delete restrict
);

comment on table public.mystery_recipe_items is
  'Mystery packs: raderna i en version av innehållet (append-only).';

create index mystery_recipes_title_idx
  on public.mystery_recipes (organization_id, title_id, version desc);
create index mystery_recipe_items_recipe_idx
  on public.mystery_recipe_items (organization_id, recipe_id, position);

-- Innehållet måste gå ihop: minst en rad, högst 30, summan = omgångens storlek och aldrig
-- titeln själv eller en annan egen produkt. Kontrolleras vid commit (raderna skrivs efter
-- huvudet i samma transaktion).
create function private.mystery_recipe_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_recipe public.mystery_recipes;
  v_rows integer;
  v_sum integer;
  v_bad integer;
  v_recipe_id uuid;
begin
  if tg_table_name = 'mystery_recipes' then
    v_recipe_id := (to_jsonb(new) ->> 'id')::uuid;
  else
    v_recipe_id := (to_jsonb(new) ->> 'recipe_id')::uuid;
  end if;
  select * into v_recipe from public.mystery_recipes r
  where r.organization_id = new.organization_id and r.id = v_recipe_id;
  if v_recipe.id is null then
    return null;
  end if;
  select count(*)::int, coalesce(sum(i.quantity), 0)::int,
         count(*) filter (where i.component_title_id = v_recipe.title_id or t.own_product)::int
    into v_rows, v_sum, v_bad
  from public.mystery_recipe_items i
  join public.titles t on t.organization_id = i.organization_id and t.id = i.component_title_id
  where i.organization_id = v_recipe.organization_id and i.recipe_id = v_recipe.id;
  if v_rows < 1 or v_rows > 30 then
    raise exception using errcode = '22023', message = 'Innehållet behöver 1–30 rader.';
  end if;
  if v_bad > 0 then
    raise exception using errcode = '22023',
      message = 'Ett mystery pack kan inte innehålla sig självt eller en annan egen produkt.';
  end if;
  if v_sum <> v_recipe.batch_size then
    raise exception using errcode = '22023',
      message = format('Antalen blir %s men en omgång är %s.', v_sum, v_recipe.batch_size);
  end if;
  return null;
end
$$;

create constraint trigger t80_recipe_check after insert on public.mystery_recipes
  deferrable initially deferred
  for each row execute function private.mystery_recipe_check();
create constraint trigger t80_recipe_check after insert on public.mystery_recipe_items
  deferrable initially deferred
  for each row execute function private.mystery_recipe_check();

-- -----------------------------------------------------------------------------
-- 2. Packningar
-- -----------------------------------------------------------------------------

create table public.mystery_packings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- Klientens id för inskicket: samma id två gånger ger samma packning.
  client_id uuid not null,
  title_id uuid not null,
  recipe_id uuid not null,
  location_id uuid not null,
  batches integer not null check (batches between 1 and 10),
  packs integer not null check (packs between 1 and 2000),
  -- Innehållets snittkostnad per pack med de inköpspriser som gällde packdagen
  -- (null = någon del saknade inköpspris).
  cost_per_pack_ore bigint check (cost_per_pack_ore is null or cost_per_pack_ore >= 0),
  transfer_group_id uuid not null,
  note text not null check (char_length(note) between 1 and 300),
  packed_at timestamptz not null default now(),
  packed_by uuid references auth.users (id) on delete set null,
  undone_at timestamptz,
  undone_by uuid references auth.users (id) on delete set null,
  undo_group_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, client_id),
  unique (organization_id, transfer_group_id),
  unique (organization_id, undo_group_id),
  foreign key (organization_id, title_id) references public.titles (organization_id, id)
    on delete restrict,
  foreign key (organization_id, recipe_id) references public.mystery_recipes (organization_id, id)
    on delete restrict,
  foreign key (organization_id, location_id) references public.stock_locations (organization_id, id)
    on delete restrict,
  check ((undone_at is null) = (undo_group_id is null))
);

comment on table public.mystery_packings is
  'Mystery packs: en rad per packning (pack_mystery). Ångra (undo_mystery_packing) sätter undone_at.';

create index mystery_packings_title_idx
  on public.mystery_packings (organization_id, title_id, packed_at desc);

-- -----------------------------------------------------------------------------
-- Triggers, rättigheter och RLS
-- -----------------------------------------------------------------------------

create trigger t00_forbid_org_change before update on public.mystery_recipes
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.mystery_recipes
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.mystery_recipes
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.mystery_recipes
  for each row execute function private.stamp_insert();
create trigger t90_audit_insert after insert on public.mystery_recipes
  for each row execute function private.audit();

create trigger t00_forbid_org_change before update on public.mystery_recipe_items
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.mystery_recipe_items
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.mystery_recipe_items
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.mystery_recipe_items
  for each row execute function private.stamp_insert();

create trigger t00_forbid_org_change before update on public.mystery_packings
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.mystery_packings
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.mystery_packings
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.mystery_packings
  for each row execute function private.forbid_delete();
create trigger t90_audit_insert after insert on public.mystery_packings
  for each row execute function private.audit();
create trigger t90_audit_update after update on public.mystery_packings
  for each row execute function private.audit();

alter table public.mystery_recipes enable row level security;
alter table public.mystery_recipe_items enable row level security;
alter table public.mystery_packings enable row level security;
revoke all on table public.mystery_recipes, public.mystery_recipe_items, public.mystery_packings
  from anon, authenticated, service_role;
grant select on table public.mystery_recipes, public.mystery_recipe_items, public.mystery_packings
  to authenticated;
-- Servicerollen som för övriga tabeller (update ger den bara triggernas fel); appen skriver
-- aldrig med den här.
grant select, insert, update on table public.mystery_recipes, public.mystery_recipe_items,
  public.mystery_packings to service_role;

-- Ingen planerarstatistik på organization_id (den avslöjar hur många organisationer som finns).
alter table public.mystery_recipes alter column organization_id set statistics 0;
alter table public.mystery_recipe_items alter column organization_id set statistics 0;
alter table public.mystery_packings alter column organization_id set statistics 0;

-- Innehållet: inga belopp, alla roller i appen (påfyllaren packar).
create policy mystery_recipes_select on public.mystery_recipes
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))));
create policy mystery_recipe_items_select on public.mystery_recipe_items
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))));
-- Packningarna har kostnaden per pack: ägare, admin och läsare.
create policy mystery_packings_select on public.mystery_packings
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));

-- -----------------------------------------------------------------------------
-- 5. stock_events: transfer_group_id på justeringar (bara packning och ångring)
-- -----------------------------------------------------------------------------

alter table public.stock_events drop constraint stock_events_transfer_group;
alter table public.stock_events add constraint stock_events_transfer_group check (
  (kind not in ('transfer_in', 'transfer_out') or transfer_group_id is not null)
  and (transfer_group_id is null or kind in ('transfer_in', 'transfer_out', 'adjustment'))
);

-- En flytt (transfer_out + transfer_in) måste gå jämnt ut. En grupp justeringar måste höra
-- till en packning (eller dess ångring) och också gå jämnt ut. Kontrolleras vid commit.
create or replace function private.stock_events_check_transfer() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_sum bigint;
  v_kinds text[];
begin
  select coalesce(sum(e.quantity), 0), array_agg(distinct e.kind::text order by e.kind::text)
    into v_sum, v_kinds
  from public.stock_events e
  where e.organization_id = new.organization_id
    and e.transfer_group_id = new.transfer_group_id;
  if v_kinds = array['adjustment'] then
    -- Alla händelser i gruppen ligger i packningens lager (aldrig i en automat).
    if v_sum <> 0 or not exists (
      select 1 from public.mystery_packings p
      where p.organization_id = new.organization_id
        and (p.transfer_group_id = new.transfer_group_id or p.undo_group_id = new.transfer_group_id)
        and not exists (
          select 1 from public.stock_events x
          where x.organization_id = new.organization_id
            and x.transfer_group_id = new.transfer_group_id
            and x.location_id <> p.location_id
        )
    ) then
      raise exception using
        errcode = 'BL017',
        message = 'En packning måste ta ut lika många pack som den lägger till.';
    end if;
    return null;
  end if;
  if v_sum <> 0 or v_kinds is distinct from array['transfer_in', 'transfer_out'] then
    raise exception using
      errcode = 'BL017',
      message = 'En lagerflytt måste ha lika många ut som in.';
  end if;
  return null;
end
$$;

-- -----------------------------------------------------------------------------
-- RPC:er
-- -----------------------------------------------------------------------------

-- Gällande innehåll för en titel (senaste versionen), eller null.
create function private.current_mystery_recipe(p_organization_id uuid, p_title_id uuid)
returns public.mystery_recipes
language sql stable security definer
set search_path = ''
as $$
  select r.* from public.mystery_recipes r
  where r.organization_id = p_organization_id and r.title_id = p_title_id
  order by r.version desc
  limit 1
$$;

-- Spara innehållet: en ny version från i dag. Samma innehåll som det gällande ger ingen ny
-- version (det gällandes id returneras). p_items: [{"titleId": uuid, "quantity": n, "hit": bool}].
create function public.save_mystery_recipe(
  p_organization_id uuid,
  p_title_id uuid,
  p_batch_size integer,
  p_items jsonb,
  p_note text default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_title public.titles;
  v_current public.mystery_recipes;
  v_note text := nullif(btrim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g')), '');
  v_today date;
  v_id uuid;
  v_sum integer := 0;
  v_ids uuid[] := '{}';
  v_qty integer[] := '{}';
  v_hit boolean[] := '{}';
  v_same boolean;
  v_component public.titles;
  e jsonb;
  v_raw text;
  v_n integer;
begin
  if auth.uid() is null or not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501', message = 'Bara ägare och admin kan ändra innehållet.';
  end if;
  select * into v_title from public.titles t
  where t.organization_id = p_organization_id and t.id = p_title_id;
  if v_title.id is null or v_title.merged_into_id is not null or v_title.archived_at is not null then
    raise exception using errcode = '22023', message = 'Titeln finns inte i organisationen.';
  end if;
  if not v_title.own_product then
    raise exception using errcode = '22023',
      message = 'Slå på Egen produkt för titeln först (Inköpspriser).';
  end if;
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 200 then
    raise exception using errcode = '22023', message = 'En omgång är 1–200 pack.';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception using errcode = '22023', message = 'Noteringen får vara högst 500 tecken.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 30 then
    raise exception using errcode = '22023', message = 'Lägg till minst en titel (högst 30).';
  end if;

  for e in select x from jsonb_array_elements(p_items) x loop
    v_raw := e ->> 'titleId';
    if jsonb_typeof(e) <> 'object' or v_raw is null
       or v_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode = '22023', message = 'Välj en titel på varje rad.';
    end if;
    if jsonb_typeof(e -> 'quantity') <> 'number'
       or (e ->> 'quantity') !~ '^[0-9]{1,4}$' then
      raise exception using errcode = '22023', message = 'Antalet måste vara ett heltal.';
    end if;
    v_n := (e ->> 'quantity')::integer;
    if v_n < 1 or v_n > 200 then
      raise exception using errcode = '22023', message = 'Antalet per rad är 1–200.';
    end if;
    select * into v_component from public.titles t
    where t.organization_id = p_organization_id and t.id = v_raw::uuid;
    if v_component.id is null or v_component.merged_into_id is not null
       or v_component.archived_at is not null then
      raise exception using errcode = '22023', message = 'En av titlarna finns inte längre.';
    end if;
    if v_component.id = p_title_id or v_component.own_product then
      raise exception using errcode = '22023',
        message = 'Ett mystery pack kan inte innehålla sig självt eller en annan egen produkt.';
    end if;
    if v_component.id = any (v_ids) then
      raise exception using errcode = '22023',
        message = format('%s står två gånger.', v_component.name);
    end if;
    v_ids := v_ids || v_component.id;
    v_qty := v_qty || v_n;
    v_hit := v_hit || coalesce((e ->> 'hit')::boolean, false);
    v_sum := v_sum + v_n;
  end loop;

  if v_sum <> p_batch_size then
    raise exception using errcode = '22023',
      message = format('Antalen blir %s men en omgång är %s.', v_sum, p_batch_size);
  end if;

  -- En sparning åt gången per titel (versionsnumret).
  perform pg_advisory_xact_lock(
    hashtextextended('mystery-recipe/' || p_organization_id::text || '/' || p_title_id::text, 0)
  );
  v_current := private.current_mystery_recipe(p_organization_id, p_title_id);
  if v_current.id is not null
     and v_current.batch_size = p_batch_size
     and v_current.note is not distinct from v_note then
    select coalesce(array_agg(i.component_title_id order by i.position), '{}') = v_ids
       and coalesce(array_agg(i.quantity order by i.position), '{}') = v_qty
       and coalesce(array_agg(i.is_hit order by i.position), '{}') = v_hit
      into v_same
    from public.mystery_recipe_items i
    where i.organization_id = p_organization_id and i.recipe_id = v_current.id;
    if v_same then
      return v_current.id;
    end if;
  end if;

  select (now() at time zone o.timezone)::date into v_today
  from public.organizations o where o.id = p_organization_id;

  insert into public.mystery_recipes (organization_id, title_id, version, valid_from, batch_size, note)
  values (p_organization_id, p_title_id, coalesce(v_current.version, 0) + 1, v_today, p_batch_size, v_note)
  returning id into v_id;

  insert into public.mystery_recipe_items
    (organization_id, recipe_id, component_title_id, quantity, is_hit, position)
  select p_organization_id, v_id, x.t, x.q, x.h, (x.n - 1)::smallint
  from unnest(v_ids, v_qty, v_hit) with ordinality as x(t, q, h, n);
  return v_id;
end
$$;

-- Packa: ta delarna ur ett eget lager och lägg till mystery-packen i samma lager.
create function public.pack_mystery(
  p_organization_id uuid,
  p_client_id uuid,
  p_title_id uuid,
  p_location_id uuid,
  p_batches integer,
  p_recipe_id uuid default null
)
returns table (packing_id uuid, group_id uuid, pack_count integer, duplicate boolean)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_prev public.mystery_packings;
  v_title public.titles;
  v_recipe public.mystery_recipes;
  v_loc public.stock_locations;
  v_group uuid := gen_random_uuid();
  v_packs integer;
  v_note text;
  v_missing text[] := '{}';
  v_today date;
  v_total numeric := 0;
  v_known boolean := true;
  v_price bigint;
  v_id uuid;
  r record;
begin
  if v_uid is null or not private.has_role(p_organization_id, 'owner', 'admin', 'refiller') then
    raise exception using errcode = '42501',
      message = 'Bara ägare, admin och påfyllare kan packa.';
  end if;
  if p_client_id is null then
    raise exception using errcode = '22023', message = 'Inskicket saknar id.';
  end if;
  if p_batches is null or p_batches < 1 or p_batches > 10 then
    raise exception using errcode = '22023', message = 'Välj 1–10 omgångar.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_organization_id::text || '/mystery/' || p_client_id::text, 0)
  );
  select * into v_prev from public.mystery_packings p
  where p.organization_id = p_organization_id and p.client_id = p_client_id;
  if v_prev.id is not null then
    if v_prev.packed_by is distinct from v_uid
       or v_prev.title_id <> p_title_id
       or v_prev.location_id <> p_location_id
       or v_prev.batches <> p_batches then
      raise exception using errcode = '22023', message = 'Den här packningen är redan sparad. Ladda om sidan.';
    end if;
    return query select v_prev.id, v_prev.transfer_group_id, v_prev.packs, true;
    return;
  end if;

  select * into v_title from public.titles t
  where t.organization_id = p_organization_id and t.id = p_title_id;
  if v_title.id is null or v_title.merged_into_id is not null or v_title.archived_at is not null then
    raise exception using errcode = '22023', message = 'Titeln finns inte i organisationen.';
  end if;
  if not v_title.own_product then
    raise exception using errcode = '22023', message = 'Titeln är inte en egen produkt.';
  end if;
  v_recipe := private.current_mystery_recipe(p_organization_id, p_title_id);
  if v_recipe.id is null then
    raise exception using errcode = '22023', message = 'Lägg in innehållet först.';
  end if;
  if p_recipe_id is not null and p_recipe_id <> v_recipe.id then
    raise exception using errcode = '22023', message = 'Innehållet har ändrats. Ladda om sidan.';
  end if;
  v_loc := private.active_warehouse(p_organization_id, p_location_id);
  v_packs := p_batches * v_recipe.batch_size;

  -- Samma lås som påfyllning, flytt och Awish-synken, i titel-ordning (inga dödlägen).
  for r in
    select x.t from (
      select i.component_title_id as t from public.mystery_recipe_items i
      where i.organization_id = p_organization_id and i.recipe_id = v_recipe.id
      union select p_title_id
    ) x order by x.t
  loop
    perform private.lock_own_stock(p_organization_id, r.t);
  end loop;

  select (now() at time zone o.timezone)::date into v_today
  from public.organizations o where o.id = p_organization_id;

  for r in
    select i.component_title_id as title_id, i.quantity * p_batches as need, i.quantity, t.name,
           private.location_level(p_organization_id, v_loc.id, i.component_title_id) as have
    from public.mystery_recipe_items i
    join public.titles t on t.organization_id = i.organization_id and t.id = i.component_title_id
    where i.organization_id = p_organization_id and i.recipe_id = v_recipe.id
    order by i.position
  loop
    if r.have < r.need then
      v_missing := v_missing || format('%s %s', r.need - greatest(r.have, 0), r.name);
    end if;
    select pp.unit_cost_ore into v_price from public.purchase_price_periods pp
    where pp.organization_id = p_organization_id and pp.title_id = r.title_id
      and pp.valid_from <= v_today and (pp.valid_to is null or pp.valid_to >= v_today)
    limit 1;
    if v_price is null then
      v_known := false;
    else
      v_total := v_total + v_price * r.quantity;
    end if;
  end loop;
  if cardinality(v_missing) > 0 then
    raise exception using errcode = '22023',
      message = format('%s saknar %s.', v_loc.name, array_to_string(v_missing, ', '));
  end if;

  v_note := format('Packat %s %s %s', p_batches,
                   case when p_batches = 1 then 'omgång' else 'omgångar' end, v_title.name);

  insert into public.mystery_packings (
    organization_id, client_id, title_id, recipe_id, location_id, batches, packs,
    cost_per_pack_ore, transfer_group_id, note, packed_by
  ) values (
    p_organization_id, p_client_id, p_title_id, v_recipe.id, v_loc.id, p_batches, v_packs,
    case when v_known then round(v_total / v_recipe.batch_size)::bigint end,
    v_group, left(v_note, 300), v_uid
  )
  returning id into v_id;

  insert into public.stock_events (
    organization_id, location_id, title_id, kind, quantity, performed_by, transfer_group_id, note
  )
  select p_organization_id, v_loc.id, i.component_title_id, 'adjustment', -(i.quantity * p_batches),
         v_uid, v_group, v_note
  from public.mystery_recipe_items i
  where i.organization_id = p_organization_id and i.recipe_id = v_recipe.id
  order by i.position;
  insert into public.stock_events (
    organization_id, location_id, title_id, kind, quantity, performed_by, transfer_group_id, note
  ) values (
    p_organization_id, v_loc.id, p_title_id, 'adjustment', v_packs, v_uid, v_group, v_note
  );

  return query select v_id, v_group, v_packs, false;
end
$$;

-- Ångra en packning inom 30 minuter: samma händelser åt andra hållet. Bara en gång.
create function public.undo_mystery_packing(p_organization_id uuid, p_packing_id uuid)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_p public.mystery_packings;
  v_loc public.stock_locations;
  v_name text;
  v_have integer;
  v_group uuid := gen_random_uuid();
  r record;
begin
  if v_uid is null or not private.has_role(p_organization_id, 'owner', 'admin', 'refiller') then
    raise exception using errcode = '42501',
      message = 'Bara ägare, admin och påfyllare kan ångra en packning.';
  end if;
  select * into v_p from public.mystery_packings p
  where p.organization_id = p_organization_id and p.id = p_packing_id
  for update;
  if v_p.id is null then
    raise exception using errcode = '22023', message = 'Packningen finns inte.';
  end if;
  if v_p.packed_by is distinct from v_uid
     and not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501', message = 'Du kan bara ångra dina egna packningar.';
  end if;
  if v_p.undone_at is not null then
    raise exception using errcode = '22023', message = 'Packningen är redan ångrad.';
  end if;
  if v_p.packed_at < now() - interval '30 minutes' then
    raise exception using errcode = '22023',
      message = 'För sent att ångra. Rätta antalet i Vårt lager.';
  end if;
  v_loc := private.active_warehouse(p_organization_id, v_p.location_id);

  for r in
    select distinct e.title_id from public.stock_events e
    where e.organization_id = p_organization_id and e.transfer_group_id = v_p.transfer_group_id
    order by e.title_id
  loop
    perform private.lock_own_stock(p_organization_id, r.title_id);
  end loop;

  -- Har lagret räknats (inventering) efter packningen för någon av titlarna är det räknade
  -- antalet facit: att ångra då skulle lägga tillbaka delarna ovanpå det (dubbelräkning).
  if exists (
    select 1 from public.stock_events c
    join (
      select e.title_id, max(e.occurred_at) as at, max(e.seq) as seq
      from public.stock_events e
      where e.organization_id = p_organization_id and e.transfer_group_id = v_p.transfer_group_id
      group by e.title_id
    ) g on g.title_id = c.title_id
    where c.organization_id = p_organization_id and c.location_id = v_p.location_id
      and c.kind = 'count' and (c.occurred_at, c.seq) > (g.at, g.seq)
  ) then
    raise exception using errcode = '22023',
      message = 'Lagret har räknats efter packningen. Rätta antalet i Vårt lager.';
  end if;

  v_have := private.location_level(p_organization_id, v_loc.id, v_p.title_id);
  if v_have < v_p.packs then
    select t.name into v_name from public.titles t
    where t.organization_id = p_organization_id and t.id = v_p.title_id;
    raise exception using errcode = '22023',
      message = format('%s har bara %s %s kvar. Det går inte att ångra.',
                       v_loc.name, greatest(v_have, 0), v_name);
  end if;

  update public.mystery_packings
  set undone_at = now(), undone_by = v_uid, undo_group_id = v_group
  where organization_id = p_organization_id and id = v_p.id;

  insert into public.stock_events (
    organization_id, location_id, title_id, kind, quantity, performed_by, transfer_group_id, note
  )
  select e.organization_id, e.location_id, e.title_id, 'adjustment', -e.quantity, v_uid, v_group,
         left('Ångrat: ' || v_p.note, 500)
  from public.stock_events e
  where e.organization_id = p_organization_id and e.transfer_group_id = v_p.transfer_group_id
  order by e.seq;
  return v_group;
end
$$;

revoke all on function private.mystery_recipe_check() from public;
revoke all on function private.current_mystery_recipe(uuid, uuid) from public;
revoke all on function public.save_mystery_recipe(uuid, uuid, integer, jsonb, text) from public, anon;
revoke all on function public.pack_mystery(uuid, uuid, uuid, uuid, integer, uuid) from public, anon;
revoke all on function public.undo_mystery_packing(uuid, uuid) from public, anon;
grant execute on function public.save_mystery_recipe(uuid, uuid, integer, jsonb, text) to authenticated;
grant execute on function public.pack_mystery(uuid, uuid, uuid, uuid, integer, uuid) to authenticated;
grant execute on function public.undo_mystery_packing(uuid, uuid) to authenticated;

revoke all on all functions in schema private from public;
