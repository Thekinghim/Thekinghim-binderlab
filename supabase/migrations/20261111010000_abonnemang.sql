-- =============================================================================
-- Abonnemang: Binderlab (plattformsoperatören) tar betalt av varje
-- kundorganisation per aktiv automat och månad.
--
-- * private.platform_operators: vilka organisationer som driver plattformen.
--   Ägare och admin i en sådan organisation är plattformsoperatörer och ser
--   /plattform. Tabellen skrivs bara av databasägaren (migrering eller SQL i
--   Supabase); ingen klientroll, inte ens service_role, har rättigheter.
--   Produktion: se docs/abonnemang.md (en rad SQL).
-- * private.subscription_customers: kundens fakturauppgifter (land,
--   momsnummer) och provperiodens sista dag.
-- * private.subscription_plans: planens perioder (status, pris per automat och
--   månad i öre, valuta). Perioderna överlappar aldrig, så historiken (MRR per
--   månad, churn) går att räkna i efterhand. En ändring från ett datum stänger
--   den öppna perioden dagen före och öppnar en ny.
--
-- Allt ligger i schemat private (exponeras inte) och nås bara via RPC:er:
-- * am_platform_operator(): är den inloggade plattformsoperatör (för länken).
-- * platform_overview_data(): alla kunder, planer och automaternas aktiva
--   perioder. Bara plattformsoperatörer (42501 annars).
-- * platform_save_plan(...): ändra en kunds plan. Bara plattformsoperatörer.
-- * my_subscription(org): den egna organisationens plan och automater, för
--   Inställningar. Bara ägare och admin i organisationen. Inga interna
--   anteckningar.
--
-- Demoorganisationer (organizations.is_demo, om kolumnen finns) räknas aldrig
-- som kunder. Kolumnen läses via to_jsonb så att migreringen fungerar både
-- före och efter att demofunktionen slagits ihop.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Plattformsoperatörer
-- -----------------------------------------------------------------------------
create table private.platform_operators (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  note text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now()
);

revoke all on table private.platform_operators from public, anon, authenticated, service_role;

comment on table private.platform_operators is
  'Organisationer som driver plattformen. Bara databasägaren skriver (migrering/SQL).';

-- Är den inloggade ägare eller admin i en plattformsorganisation?
create function private.is_platform_operator() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join private.platform_operators p on p.organization_id = m.organization_id
    join public.organizations o on o.id = m.organization_id
    where m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
      and o.archived_at is null
  )
$$;

revoke all on function private.is_platform_operator() from public, anon;

-- Organisationen räknas som kund (inte demo). is_demo finns bara efter demofunktionen.
create function private.is_customer_org(p_org jsonb) returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce((p_org ->> 'is_demo')::boolean, false) = false
$$;

revoke all on function private.is_customer_org(jsonb) from public, anon;

-- -----------------------------------------------------------------------------
-- Kundens fakturauppgifter och planens perioder
-- -----------------------------------------------------------------------------
create table private.subscription_customers (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  -- ISO 3166-1 alfa-2 (SE, DK …). null = Sverige.
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  -- Momsregistreringsnummer (VAT), versaler utan mellanslag, t.ex. DK12345678.
  vat_number text check (vat_number is null or vat_number ~ '^[A-Z0-9]{4,20}$'),
  -- Sista dagen i provperioden (inget faktureras till och med den dagen).
  trial_ends_on date,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

revoke all on table private.subscription_customers from public, anon, authenticated, service_role;

create table private.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  valid_from date not null,
  valid_to date,
  status text not null check (status in ('active', 'paused', 'ended')),
  price_per_machine_ore bigint not null
    check (price_per_machine_ore between 0 and 100000000),
  currency text not null check (currency in ('SEK', 'EUR', 'DKK', 'NOK')),
  -- Intern anteckning (visas bara för plattformen).
  note text check (note is null or char_length(note) <= 500),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  constraint subscription_plans_range_check check (valid_to is null or valid_to >= valid_from),
  constraint subscription_plans_no_overlap exclude using gist (
    organization_id with =,
    daterange(valid_from, valid_to, '[]') with &&
  )
);

create index subscription_plans_org_idx on private.subscription_plans (organization_id, valid_from);

revoke all on table private.subscription_plans from public, anon, authenticated, service_role;

comment on table private.subscription_plans is
  'Abonnemangets perioder per kund. Skrivs bara via platform_save_plan.';

-- -----------------------------------------------------------------------------
-- Automaternas aktiva perioder (för debitering)
--
-- Från: active_from, annars dagen automaten lades upp (organisationens tidszon).
-- Till: active_to och dagen före arkiveringen, det som kommer först (null = öppen).
-- Exempelautomater räknas aldrig.
-- -----------------------------------------------------------------------------
create function private.billing_machines(p_organization_id uuid)
returns table (organization_id uuid, machine_id uuid, active_from date, active_to date)
language sql stable security definer
set search_path = ''
as $$
  select x.organization_id, x.machine_id, x.active_from, x.active_to
  from (
    select m.organization_id, m.id as machine_id,
           coalesce(m.active_from, (m.created_at at time zone o.timezone)::date) as active_from,
           least(m.active_to, ((m.archived_at at time zone o.timezone)::date - 1)) as active_to
    from public.machines m
    join public.organizations o on o.id = m.organization_id
    where not m.is_example
      and (p_organization_id is null or m.organization_id = p_organization_id)
  ) x
  where x.active_to is null or x.active_to >= x.active_from
$$;

revoke all on function private.billing_machines(uuid) from public, anon;

-- -----------------------------------------------------------------------------
-- RPC: är jag plattformsoperatör?
-- -----------------------------------------------------------------------------
create function public.am_platform_operator() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.is_platform_operator()
$$;

revoke all on function public.am_platform_operator() from public, anon;
grant execute on function public.am_platform_operator() to authenticated;

comment on function public.am_platform_operator() is
  'Sant om den inloggade är ägare eller admin i en plattformsorganisation.';

-- -----------------------------------------------------------------------------
-- RPC: plattformens data (bara plattformsoperatörer)
-- -----------------------------------------------------------------------------
create function public.platform_overview_data() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.is_platform_operator() then
    raise exception using errcode = '42501', message = 'Du har inte behörighet till plattformen.';
  end if;

  with orgs as (
    select o.*
    from public.organizations o
    where private.is_customer_org(to_jsonb(o))
  )
  select jsonb_build_object(
    'customers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id,
        'name', o.name,
        'slug', o.slug,
        'timezone', o.timezone,
        'createdAt', o.created_at,
        'archivedAt', o.archived_at,
        'operator', exists (select 1 from private.platform_operators p where p.organization_id = o.id),
        'countryCode', c.country_code,
        'vatNumber', c.vat_number,
        'trialEndsOn', c.trial_ends_on,
        'members', (select count(*) from public.memberships m where m.organization_id = o.id),
        'lastSaleOn', (select max(ord.business_date) from public.orders ord
                       where ord.organization_id = o.id)
      ) order by o.name)
      from orgs o
      left join private.subscription_customers c on c.organization_id = o.id
    ), '[]'::jsonb),
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organizationId', p.organization_id,
        'validFrom', p.valid_from,
        'validTo', p.valid_to,
        'status', p.status,
        'pricePerMachineOre', p.price_per_machine_ore,
        'currency', p.currency,
        'note', p.note
      ) order by p.organization_id, p.valid_from)
      from private.subscription_plans p
      where p.organization_id in (select id from orgs)
    ), '[]'::jsonb),
    'machines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organizationId', bm.organization_id,
        'machineId', bm.machine_id,
        'activeFrom', bm.active_from,
        'activeTo', bm.active_to
      ) order by bm.organization_id, bm.active_from)
      from private.billing_machines(null) bm
      where bm.organization_id in (select id from orgs)
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end
$$;

revoke all on function public.platform_overview_data() from public, anon;
grant execute on function public.platform_overview_data() to authenticated;

comment on function public.platform_overview_data() is
  'Alla kunder, planer och automaters aktiva perioder. Bara plattformsoperatörer.';

-- -----------------------------------------------------------------------------
-- RPC: ändra en kunds plan (bara plattformsoperatörer)
--
-- p_effective_from: från vilken dag ändringen gäller.
--   * Ingen plan ännu: en ny period från dagen.
--   * Samma dag som den senaste periodens start: perioden skrivs över.
--   * Senare: den senaste perioden slutar dagen före och en ny börjar.
--   * Tidigare än den senaste periodens start: nekas (BL120). Historiken skrivs
--     inte om bakåt.
-- Är status, pris och valuta oförändrade skapas ingen ny period (bara
-- anteckning och fakturauppgifter sparas).
-- -----------------------------------------------------------------------------
create function public.platform_save_plan(
  p_organization_id uuid,
  p_effective_from date,
  p_status text,
  p_price_per_machine_ore bigint,
  p_currency text,
  p_trial_ends_on date,
  p_country_code text,
  p_vat_number text,
  p_note text
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_last private.subscription_plans;
  v_country text := nullif(upper(btrim(coalesce(p_country_code, ''))), '');
  v_vat text := nullif(upper(regexp_replace(coalesce(p_vat_number, ''), '[\s.-]', '', 'g')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not private.is_platform_operator() then
    raise exception using errcode = '42501', message = 'Du har inte behörighet till plattformen.';
  end if;
  if p_organization_id is null or p_effective_from is null then
    raise exception using errcode = '22023', message = 'Kund och datum krävs.';
  end if;
  perform 1 from public.organizations o
   where o.id = p_organization_id and private.is_customer_org(to_jsonb(o))
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Kunden finns inte.';
  end if;

  insert into private.subscription_customers as c
    (organization_id, country_code, vat_number, trial_ends_on, created_by, updated_by)
  values (p_organization_id, v_country, v_vat, p_trial_ends_on, v_uid, v_uid)
  on conflict (organization_id) do update
    set country_code = excluded.country_code,
        vat_number = excluded.vat_number,
        trial_ends_on = excluded.trial_ends_on,
        updated_at = now(),
        updated_by = v_uid
  where (c.country_code, c.vat_number, c.trial_ends_on)
        is distinct from (excluded.country_code, excluded.vat_number, excluded.trial_ends_on);

  select * into v_last
  from private.subscription_plans p
  where p.organization_id = p_organization_id
  order by p.valid_from desc
  limit 1;

  if v_last.id is null then
    insert into private.subscription_plans
      (organization_id, valid_from, status, price_per_machine_ore, currency, note,
       created_by, updated_by)
    values (p_organization_id, p_effective_from, p_status, p_price_per_machine_ore, p_currency,
            v_note, v_uid, v_uid);
  elsif p_effective_from < v_last.valid_from then
    raise exception using
      errcode = 'BL120',
      message = 'Datumet ligger före den nuvarande planen.',
      hint = 'Välj samma dag som planen började eller senare.';
  elsif p_effective_from = v_last.valid_from then
    update private.subscription_plans
       set status = p_status,
           price_per_machine_ore = p_price_per_machine_ore,
           currency = p_currency,
           note = v_note,
           updated_at = now(),
           updated_by = v_uid
     where id = v_last.id;
  elsif (v_last.status, v_last.price_per_machine_ore, v_last.currency)
        is not distinct from (p_status, p_price_per_machine_ore, p_currency)
        and v_last.valid_to is null then
    update private.subscription_plans
       set note = v_note, updated_at = now(), updated_by = v_uid
     where id = v_last.id and note is distinct from v_note;
  else
    if v_last.valid_to is null or v_last.valid_to >= p_effective_from then
      update private.subscription_plans
         set valid_to = p_effective_from - 1, updated_at = now(), updated_by = v_uid
       where id = v_last.id;
    end if;
    insert into private.subscription_plans
      (organization_id, valid_from, status, price_per_machine_ore, currency, note,
       created_by, updated_by)
    values (p_organization_id, p_effective_from, p_status, p_price_per_machine_ore, p_currency,
            v_note, v_uid, v_uid);
  end if;
end
$$;

revoke all on function public.platform_save_plan(uuid, date, text, bigint, text, date, text, text, text)
  from public, anon;
grant execute on function public.platform_save_plan(uuid, date, text, bigint, text, date, text, text, text)
  to authenticated;

comment on function public.platform_save_plan(uuid, date, text, bigint, text, date, text, text, text) is
  'Ändrar en kunds plan från ett datum och kundens fakturauppgifter. Bara plattformsoperatörer.';

-- -----------------------------------------------------------------------------
-- RPC: den egna organisationens abonnemang (ägare och admin)
-- -----------------------------------------------------------------------------
create function public.my_subscription(p_organization_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501',
      message = 'Bara ägare och admin ser abonnemanget.';
  end if;

  return jsonb_build_object(
    'customer', (
      select jsonb_build_object(
        'countryCode', c.country_code,
        'vatNumber', c.vat_number,
        'trialEndsOn', c.trial_ends_on)
      from private.subscription_customers c
      where c.organization_id = p_organization_id
    ),
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organizationId', p.organization_id,
        'validFrom', p.valid_from,
        'validTo', p.valid_to,
        'status', p.status,
        'pricePerMachineOre', p.price_per_machine_ore,
        'currency', p.currency
      ) order by p.valid_from)
      from private.subscription_plans p
      where p.organization_id = p_organization_id
    ), '[]'::jsonb),
    'machines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organizationId', bm.organization_id,
        'machineId', bm.machine_id,
        'activeFrom', bm.active_from,
        'activeTo', bm.active_to
      ) order by bm.active_from)
      from private.billing_machines(p_organization_id) bm
    ), '[]'::jsonb)
  );
end
$$;

revoke all on function public.my_subscription(uuid) from public, anon;
grant execute on function public.my_subscription(uuid) to authenticated;

comment on function public.my_subscription(uuid) is
  'Organisationens plan, fakturauppgifter och automater (för fakturaunderlaget). Ägare och admin.';
