-- =============================================================================
-- Tillväxt A och B: kampanjer på automaternas skärm och gratis-pack-koder (Awish).
--
-- campaigns            En kampanj: text, bild (publik URL som Awish visar), start och slut.
-- campaign_machines    Kampanjen per automat: Awish-automatens id, kampanjbildens id i
--                      Awish (Banner.id) och läget (planerad, visas, misslyckad, avstängd).
-- free_pack_batches    "Ge bort ett pack": automat, titel, antal, skäl, vem och kostnaden
--                      (inköpspris × antal) som Lönsamhet räknar som raden "Gratis-pack".
-- free_pack_codes      Koderna som Awish skapade (värda ett pack var).
--
-- Behörighet:
--   * Ägare, admin och läsare läser kampanjer och gratis-pack (kostnaden är en rad i
--     Lönsamhet, som läsaren ser). Koderna läser bara ägare och admin. Påfyllaren ser
--     ingenting.
--   * Bara servern skriver (databasägaren), efter rollkontroll och efter att Awish svarat.
--     Ingen klientroll kan skapa, ändra eller radera rader; raderna raderas aldrig.
--
-- Bilderna ligger i den publika bucketen 'campaigns' (bara kampanjbilder: Awish hämtar
-- dem utan inloggning). Sökvägen är "{organization_id}/{sha256}.{ext}" och skrivs bara
-- av servern med systemnyckeln.
-- =============================================================================

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 1 and 60),
  -- Titeln kampanjen gäller (förslaget "ny titel"), eller null.
  title_id uuid,
  image_path text not null check (char_length(image_path) between 1 and 300),
  image_url text not null check (image_url ~ '^https?://' and char_length(image_url) <= 1000),
  image_type text not null check (image_type in ('image/png', 'image/jpeg', 'image/webp')),
  image_bytes integer not null check (image_bytes between 1 and 3145728),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  stopped_at timestamptz,
  stopped_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (ends_at > starts_at),
  foreign key (organization_id, title_id)
    references public.titles (organization_id, id) on delete restrict
);

create index campaigns_org_ends_idx on public.campaigns (organization_id, ends_at desc);

create table public.campaign_machines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  campaign_id uuid not null,
  machine_id uuid not null,
  awish_machine_id text not null check (awish_machine_id ~ '^[0-9]{1,20}$'),
  awish_banner_id text check (awish_banner_id ~ '^[0-9]{1,20}$'),
  -- scheduled: väntar på starttiden. sending: skickas nu. shown: Awish har den.
  -- failed: Awish sa nej eller svarade inte (error). stopped: avstängd i förtid.
  status text not null default 'scheduled'
    check (status in ('scheduled', 'sending', 'shown', 'failed', 'stopped')),
  error text check (error is null or char_length(error) <= 300),
  sent_at timestamptz,
  stopped_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, campaign_id, machine_id),
  foreign key (organization_id, campaign_id)
    references public.campaigns (organization_id, id) on delete restrict,
  foreign key (organization_id, machine_id)
    references public.machines (organization_id, id) on delete restrict
);

create index campaign_machines_due_idx on public.campaign_machines (organization_id)
  where status = 'scheduled';

create table public.free_pack_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  machine_id uuid not null,
  title_id uuid,
  -- Varans namn i Awish (facket), som det stod när koderna skapades.
  good_name text not null check (char_length(btrim(good_name)) between 1 and 200),
  awish_machine_id text not null check (awish_machine_id ~ '^[0-9]{1,20}$'),
  awish_product_id text not null check (awish_product_id ~ '^[0-9]{1,20}$'),
  quantity integer not null check (quantity between 1 and 20),
  reason text not null check (reason in ('compensation', 'giveaway', 'staff', 'other')),
  recipient text check (recipient is null or char_length(recipient) <= 80),
  note text check (note is null or char_length(note) <= 200),
  -- Inköpspriset som gällde (purchase_prices) och kostnaden = pris × antal. null = inget pris.
  unit_cost_ore bigint check (unit_cost_ore >= 0),
  cost_ore bigint check (cost_ore >= 0),
  -- Affärsdagen koderna skapades (organisationens tidszon); kostnaden räknas den dagen.
  business_date date not null,
  expires_at timestamptz not null,
  -- sending: Awish anropas. created: koderna finns. failed: Awish skapade inga (error).
  status text not null default 'sending' check (status in ('sending', 'created', 'failed')),
  error text check (error is null or char_length(error) <= 300),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check ((unit_cost_ore is null) = (cost_ore is null)),
  foreign key (organization_id, machine_id)
    references public.machines (organization_id, id) on delete restrict,
  foreign key (organization_id, title_id)
    references public.titles (organization_id, id) on delete restrict
);

create index free_pack_batches_org_day_idx
  on public.free_pack_batches (organization_id, business_date desc);

create table public.free_pack_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  batch_id uuid not null,
  code text not null check (char_length(code) between 1 and 64),
  awish_code_id text check (awish_code_id ~ '^[0-9]{1,20}$'),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, batch_id, code),
  foreign key (organization_id, batch_id)
    references public.free_pack_batches (organization_id, id) on delete restrict
);

alter table public.campaigns alter column organization_id set statistics 0;
alter table public.campaign_machines alter column organization_id set statistics 0;
alter table public.free_pack_batches alter column organization_id set statistics 0;
alter table public.free_pack_codes alter column organization_id set statistics 0;

-- -----------------------------------------------------------------------------
-- Triggers: organisationen ändras aldrig, vem/när stämplas, ändringar loggas, inget raderas.
-- -----------------------------------------------------------------------------
do $$
declare
  v_table text;
begin
  foreach v_table in array array['campaigns', 'campaign_machines', 'free_pack_batches', 'free_pack_codes']
  loop
    execute format('create trigger t00_forbid_org_change before update on public.%I
      for each row execute function private.forbid_org_change()', v_table);
    execute format('create trigger t20_stamp_insert before insert on public.%I
      for each row execute function private.stamp_insert()', v_table);
    execute format('create trigger t20_stamp_update before update on public.%I
      for each row execute function private.stamp_update()', v_table);
    execute format('create trigger t90_audit after insert or update or delete on public.%I
      for each row execute function private.audit()', v_table);
    execute format('create trigger t99_forbid_delete before delete on public.%I
      for each row execute function private.forbid_delete()', v_table);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS
-- -----------------------------------------------------------------------------
alter table public.campaigns enable row level security;
alter table public.campaign_machines enable row level security;
alter table public.free_pack_batches enable row level security;
alter table public.free_pack_codes enable row level security;

revoke all on table public.campaigns from anon, authenticated, service_role;
revoke all on table public.campaign_machines from anon, authenticated, service_role;
revoke all on table public.free_pack_batches from anon, authenticated, service_role;
revoke all on table public.free_pack_codes from anon, authenticated, service_role;

grant select on table public.campaigns to authenticated;
grant select on table public.campaign_machines to authenticated;
grant select on table public.free_pack_batches to authenticated;
grant select on table public.free_pack_codes to authenticated;
-- Servernyckeln (service_role) som övriga tabeller; appen skriver via databasägaren.
grant select, insert, update on table public.campaigns to service_role;
grant select, insert, update on table public.campaign_machines to service_role;
grant select, insert, update on table public.free_pack_batches to service_role;
grant select, insert, update on table public.free_pack_codes to service_role;

create policy campaigns_select on public.campaigns for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy campaign_machines_select on public.campaign_machines for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy free_pack_batches_select on public.free_pack_batches for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
-- Koderna är värda ett pack var: bara ägare och admin.
create policy free_pack_codes_select on public.free_pack_codes for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- Publika bucketen för kampanjbilder (Awish hämtar bilden utan inloggning). Inga
-- policyer för klienter: bara servern laddar upp, med systemnyckeln.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise notice 'Schemat storage saknas: bucket campaigns skapas inte.';
    return;
  end if;

  insert into storage.buckets (id, name, public)
  values ('campaigns', 'campaigns', true)
  on conflict (id) do nothing;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit'
  ) then
    execute $q$update storage.buckets
      set file_size_limit = 3145728,
          allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
      where id = 'campaigns'$q$;
  end if;
end
$$;
