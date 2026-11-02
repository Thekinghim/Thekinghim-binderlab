-- =============================================================================
-- 3. Titlar och priser: titles, title_aliases, purchase_prices och vyn
-- purchase_price_periods.
-- =============================================================================

create table public.titles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  series text,
  merged_into_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, merged_into_id) references public.titles (organization_id, id)
    on delete set null (merged_into_id),
  check (merged_into_id is null or merged_into_id <> id),
  check (merged_into_id is null or archived_at is not null)
);

create unique index titles_active_name_key
  on public.titles (organization_id, lower(name))
  where archived_at is null;

-- Originalstavningen från källan och en normaliserad nyckel (NFKC, gemener,
-- ett mellanslag). Nyckeln räknas fram av databasen så att den alltid stämmer.
create table public.title_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  title_id uuid not null,
  alias text not null check (char_length(btrim(alias)) between 1 and 500),
  alias_normalized text not null
    generated always as (lower(btrim(regexp_replace(normalize(alias, NFKC), '\s+', ' ', 'g')))) stored,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, alias_normalized),
  foreign key (organization_id, title_id) references public.titles (organization_id, id) on delete restrict
);

create index title_aliases_title_idx on public.title_aliases (organization_id, title_id);

-- Inköpspris per order (= per pack) för en titel. Gäller från valid_from till
-- dagen före nästa pris för samma titel.
create table public.purchase_prices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  title_id uuid not null,
  unit_cost_ore bigint not null check (unit_cost_ore >= 0),
  valid_from date not null,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, title_id, valid_from),
  foreign key (organization_id, title_id) references public.titles (organization_id, id) on delete restrict
);

-- Intervallet där ett pris gäller: [valid_from, nästa valid_from) för titeln,
-- med en annan rad (p_exclude_id) bortsedd.
create function private.price_effective_range(
  p_organization_id uuid,
  p_title_id uuid,
  p_valid_from date,
  p_exclude_id uuid
) returns datemultirange
language sql stable security definer
set search_path = ''
as $$
  select datemultirange(daterange(
    p_valid_from,
    (
      select min(pp.valid_from)
      from public.purchase_prices pp
      where pp.organization_id = p_organization_id
        and pp.title_id = p_title_id
        and pp.valid_from > p_valid_from
        and pp.id is distinct from p_exclude_id
    ),
    '[)'
  ))
$$;

-- Ett nytt, ändrat eller borttaget pris får inte ändra kostnaden för någon
-- dag i en stängd månad. Det gäller också ett pris med valid_from i en öppen
-- månad som (i brist på senare pris) skulle gälla in i en stängd månad.
-- AFTER-trigger: körs först när RLS godkänt raden. Som BEFORE-trigger
-- (security definer) avslöjade felkoden (BL004 eller 42501) för den som inte
-- får skriva priser när titelns priser ändrats och vilka månader som stängts.
create function private.purchase_prices_period_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_affected datemultirange := '{}'::datemultirange;
begin
  if tg_op = 'DELETE' and private.purge_allowed() then
    return null;
  end if;
  if tg_op = 'UPDATE'
     and new.title_id = old.title_id
     and new.valid_from = old.valid_from
     and new.unit_cost_ore = old.unit_cost_ore then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    v_affected := v_affected
      + private.price_effective_range(old.organization_id, old.title_id, old.valid_from, old.id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_affected := v_affected
      + private.price_effective_range(new.organization_id, new.title_id, new.valid_from, new.id);
  end if;
  perform private.assert_period_open(
    coalesce(new.organization_id, old.organization_id), v_affected, 'Inköpspriset'
  );
  return null;
end
$$;

-- Prisperioder per titel: valid_to är sista dagen priset gäller (inklusive),
-- null = tills vidare. Kostnaden för en order är priset vars period
-- innehåller orderns business_date.
create view public.purchase_price_periods
with (security_invoker = true)
as
select
  pp.id,
  pp.organization_id,
  pp.title_id,
  pp.unit_cost_ore,
  pp.valid_from,
  (lead(pp.valid_from) over w - 1) as valid_to
from public.purchase_prices pp
window w as (partition by pp.organization_id, pp.title_id order by pp.valid_from);

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------
create trigger t00_forbid_org_change before update on public.titles
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.titles
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.titles
  for each row execute function private.stamp_update();
create trigger t90_audit after update or delete on public.titles
  for each row execute function private.audit();
create trigger t99_forbid_delete before delete on public.titles
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.title_aliases
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.title_aliases
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.title_aliases
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.title_aliases
  for each row execute function private.audit();

create trigger t00_forbid_org_change before update on public.purchase_prices
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.purchase_prices
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.purchase_prices
  for each row execute function private.stamp_update();
create trigger t40_period_guard after insert or update or delete on public.purchase_prices
  for each row execute function private.purchase_prices_period_guard();
create trigger t90_audit after insert or update or delete on public.purchase_prices
  for each row execute function private.audit();
create trigger t99_forbid_delete before delete on public.purchase_prices
  for each row execute function private.forbid_delete();

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS
-- -----------------------------------------------------------------------------

-- titles: tillåtlistad för påfyllare. merged_into_id ändras bara via merge_titles().
alter table public.titles enable row level security;
revoke all on table public.titles from anon, authenticated;
grant select, insert on table public.titles to authenticated;
grant update (name, series, archived_at) on table public.titles to authenticated;

create policy titles_select on public.titles
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))));
create policy titles_insert on public.titles
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy titles_update on public.titles
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- title_aliases: tillåtlistad för påfyllare.
alter table public.title_aliases enable row level security;
revoke all on table public.title_aliases from anon, authenticated;
grant select, insert, delete on table public.title_aliases to authenticated;
grant update (title_id, alias) on table public.title_aliases to authenticated;

create policy title_aliases_select on public.title_aliases
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))));
create policy title_aliases_insert on public.title_aliases
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy title_aliases_update on public.title_aliases
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy title_aliases_delete on public.title_aliases
  for delete to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- purchase_prices: aldrig synliga för påfyllare.
alter table public.purchase_prices enable row level security;
revoke all on table public.purchase_prices from anon, authenticated;
grant select, insert on table public.purchase_prices to authenticated;
grant update (unit_cost_ore, valid_from, note) on table public.purchase_prices to authenticated;

create policy purchase_prices_select on public.purchase_prices
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy purchase_prices_insert on public.purchase_prices
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy purchase_prices_update on public.purchase_prices
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

revoke all on table public.purchase_price_periods from anon, authenticated;
grant select on table public.purchase_price_periods to authenticated;

revoke all on all functions in schema private from public;
