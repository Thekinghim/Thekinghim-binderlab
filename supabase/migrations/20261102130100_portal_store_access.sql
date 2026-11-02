-- =============================================================================
-- Butiksportalen (fas 10), del 2: butiksanvändare och portalens dataåtkomst.
--
-- Modell
--   * En butiksanvändare är ett medlemskap med role = 'store' och store_id satt.
--     store_id får bara användas för rollen store (check), och pekar med
--     sammansatt FK på en butik i samma organisation.
--   * Butiksanvändare bjuds in från /butiker med create_store_invitation
--     (ägare/admin). Inbjudan bär store_id; accept_invitation skapar
--     medlemskapet med samma store_id. create_invitation kan inte skapa en
--     butiksinbjudan (check-villkoret kräver store_id).
--
-- Säkerhet
--   * Rollen store har INGA rättigheter i appens tabeller, vyer, RPC:er eller
--     filer: alla policyer räknar uttryckligen upp sina roller och ingen nämner
--     'store'. Butiksanvändaren ser bara sitt eget medlemskap (memberships_select,
--     user_id = auth.uid()). test/db/portal-*.test.ts kontrollerar det för VARJE
--     tabell och vy i public, så att en ny tabell inte kan släppa in rollen.
--   * All portaldata går via portal_*-funktionerna nedan: security definer,
--     search_path = '', och första steget är att anroparen har rollen store för
--     just den butiken (private.portal_store_org). De lämnar bara ut butikens
--     försäljning (belopp exkl. inköp: dag, automat, titel, belopp, antal),
--     butikens avtalsvillkor (provision och hyra, det ersättningen räknas på),
--     butikens automater och placeringar i butiken, butikens rapporter och de
--     felanmälningar butiken själv gjort. Aldrig inköpspris, marginal, vinst,
--     ägarandelar, investeringar eller något om andra butiker.
--   * Felmeddelandena är desamma oavsett om en butik, automat eller rapport
--     finns hos någon annan eller inte finns alls.
--   * Ersättningen räknas INTE här: siffrorna räknas i appen med @/domain och
--     @/reports (buildStoreReport), samma kod som butiksrapporten.
--
-- Felkoder: 42501 (inte butikens), 22023 (ogiltigt argument), P0002 (rapporten
-- finns inte), BL030 (för många felanmälningar på ett dygn).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- memberships.store_id
-- -----------------------------------------------------------------------------
alter table public.memberships add column store_id uuid;

alter table public.memberships
  add constraint memberships_store_fkey
    foreign key (organization_id, store_id) references public.stores (organization_id, id)
    on delete restrict,
  add constraint memberships_store_role_check
    check ((role = 'store') = (store_id is not null));

create index memberships_store_idx on public.memberships (organization_id, store_id)
  where store_id is not null;

comment on column public.memberships.store_id is
  'Butiken som en butiksanvändare (role = store) hör till. Bara för rollen store.';

-- -----------------------------------------------------------------------------
-- invitations.store_id
-- -----------------------------------------------------------------------------
alter table public.invitations add column store_id uuid;

alter table public.invitations
  add constraint invitations_store_fkey
    foreign key (organization_id, store_id) references public.stores (organization_id, id)
    on delete restrict,
  add constraint invitations_store_role_check
    check ((role = 'store') = (store_id is not null));

comment on column public.invitations.store_id is
  'Butiken för en inbjudan till butiksportalen (role = store). Bara för rollen store.';

-- -----------------------------------------------------------------------------
-- Hjälpfunktioner (private)
-- -----------------------------------------------------------------------------

-- Organisationen om den inloggade är butiksanvändare för just den butiken
-- (organisationen och butiken är inte arkiverade), annars null.
create function private.portal_store_org(p_store_id uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select m.organization_id
  from public.memberships m
  join public.organizations o on o.id = m.organization_id
  join public.stores s on s.organization_id = m.organization_id and s.id = m.store_id
  where m.user_id = (select auth.uid())
    and m.role = 'store'
    and m.store_id = p_store_id
    and o.archived_at is null
    and s.archived_at is null
$$;

-- Som portal_store_org men kastar 42501. Samma fel för en butik som finns hos
-- någon annan och en som inte finns.
create function private.portal_require_store(p_store_id uuid) returns uuid
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if (select auth.uid()) is null or p_store_id is null then
    raise exception using errcode = '42501', message = 'Ingen behörighet till butiken.';
  end if;
  v_org := private.portal_store_org(p_store_id);
  if v_org is null then
    raise exception using errcode = '42501', message = 'Ingen behörighet till butiken.';
  end if;
  return v_org;
end
$$;

-- Är ett objekt (eller ett av dess barn) ett otillåtet fält i en butiksrapport?
-- Samma nyckelregel som assertStoreReportSafe i src/reports/store-report.ts,
-- plus källistor (andra butiker, priser, avtal) och storeId som inte är butikens.
create function private.portal_snapshot_safe(p_report jsonb, p_store_id uuid) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_report is not null
    and jsonb_typeof(p_report) = 'object'
    and p_report ->> 'kind' = 'store'
    and p_report -> 'store' ->> 'id' = p_store_id::text
    and not exists (
      select 1
      from jsonb_path_query(p_report, 'strict $.**') as v(value)
      cross join lateral jsonb_each(v.value) as kv(key, value)
      where jsonb_typeof(v.value) = 'object'
        and (
          kv.key ~* '(cost|margin|profit|unpriced|inkop|inköp|vinst|marginal|purchase|owner)'
          or kv.key in ('stores', 'prices', 'agreements', 'placements', 'settings', 'investments')
          or (kv.key = 'orders' and jsonb_typeof(kv.value) <> 'number')
          or (kv.key = 'storeId' and kv.value <> to_jsonb(p_store_id::text))
        )
    )
$$;

-- Butiksrapporten i en ögonblicksbild: hela objektet om det är rapporten, annars
-- nyckeln "report". null om ingen av dem är en säker rapport för butiken.
create function private.portal_store_report(p_snapshot jsonb, p_store_id uuid) returns jsonb
language sql immutable
set search_path = ''
as $$
  select case
    when private.portal_snapshot_safe(p_snapshot, p_store_id) then p_snapshot
    when jsonb_typeof(p_snapshot) = 'object'
      and private.portal_snapshot_safe(p_snapshot -> 'report', p_store_id) then p_snapshot -> 'report'
  end
$$;

-- Får den inloggade läsa filen i bucketen reports? Bara PDF:er till butikens egna
-- butiksrapporter (storage-policyn nedan).
create function private.portal_can_read_report_file(p_name text) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_name is not null and exists (
    select 1
    from public.reports r
    join public.memberships m
      on m.organization_id = r.organization_id and m.store_id = r.store_id
    join public.organizations o on o.id = r.organization_id
    join public.stores s on s.organization_id = r.organization_id and s.id = r.store_id
    where r.storage_path = p_name
      and r.kind = 'store_statement'
      and r.organization_id = private.storage_path_org(p_name)
      and m.user_id = (select auth.uid())
      and m.role = 'store'
      and o.archived_at is null
      and s.archived_at is null
  )
$$;

revoke all on function private.portal_store_org(uuid) from public, anon;
revoke all on function private.portal_require_store(uuid) from public, anon;
revoke all on function private.portal_snapshot_safe(jsonb, uuid) from public, anon;
revoke all on function private.portal_store_report(jsonb, uuid) from public, anon;
revoke all on function private.portal_can_read_report_file(text) from public, anon;
grant execute on function private.portal_can_read_report_file(text) to authenticated;

-- -----------------------------------------------------------------------------
-- Portalens RPC:er
-- -----------------------------------------------------------------------------

-- Butikerna där den inloggade är butiksanvändare.
create function public.portal_stores()
returns table (
  store_id uuid,
  store_name text,
  organization_id uuid,
  organization_name text,
  timezone text,
  vat_rate_bp integer
)
language sql stable security definer
set search_path = ''
as $$
  select s.id, s.name, o.id, o.name, o.timezone, coalesce(os.vat_rate_bp, 0)
  from public.memberships m
  join public.organizations o on o.id = m.organization_id
  join public.stores s on s.organization_id = m.organization_id and s.id = m.store_id
  left join public.organization_settings os on os.organization_id = o.id
  where m.user_id = (select auth.uid())
    and m.role = 'store'
    and o.archived_at is null
    and s.archived_at is null
  order by m.created_at, s.name
$$;

-- Butikens försäljning per dag, automat, titel och belopp. En order hör till
-- butiken när automaten stod där orderns affärsdag (som i beräkningarna).
-- Ingen inköpskostnad, inget ordernummer, ingen tid på dygnet.
create function public.portal_sales(p_store_id uuid, p_from date, p_to date)
returns table (
  business_date date,
  machine_id uuid,
  title_id uuid,
  title_name text,
  amount_ore bigint,
  order_count bigint
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100 then
    raise exception using errcode = '22023', message = 'Ange en period på högst tre år.';
  end if;
  return query
    select o.business_date, o.machine_id, o.title_id, coalesce(t.name, o.raw_title),
           o.amount_ore, count(*)
    from public.orders o
    join public.machine_placements mp
      on mp.organization_id = o.organization_id
     and mp.machine_id = o.machine_id
     and mp.store_id = p_store_id
     and o.business_date >= mp.valid_from
     and (mp.valid_to is null or o.business_date <= mp.valid_to)
    left join public.titles t on t.organization_id = o.organization_id and t.id = o.title_id
    where o.organization_id = v_org
      and o.business_date between p_from and p_to
    group by o.business_date, o.machine_id, o.title_id, coalesce(t.name, o.raw_title), o.amount_ore
    order by o.business_date, o.machine_id, coalesce(t.name, o.raw_title), o.amount_ore;
end
$$;

-- Butikens avtalsvillkor: det ersättningen räknas på.
create function public.portal_agreements(p_store_id uuid)
returns table (
  valid_from date,
  valid_to date,
  commission_bp integer,
  monthly_rent_ore bigint
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select a.valid_from, a.valid_to, a.commission_bp, a.monthly_rent_ore
    from public.store_agreements a
    where a.organization_id = v_org and a.store_id = p_store_id
    order by a.valid_from;
end
$$;

-- Automaterna i butiken: bara perioderna då de stod i just den här butiken.
create function public.portal_machines(p_store_id uuid)
returns table (
  machine_id uuid,
  code text,
  name text,
  placed_from date,
  placed_to date
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select m.id, m.code, m.name, mp.valid_from, mp.valid_to
    from public.machine_placements mp
    join public.machines m on m.organization_id = mp.organization_id and m.id = mp.machine_id
    where mp.organization_id = v_org and mp.store_id = p_store_id
    order by mp.valid_from, m.code;
end
$$;

-- Butikens rapporter (butiksrapporter till just den här butiken).
create function public.portal_reports(p_store_id uuid)
returns table (
  report_id uuid,
  period_start date,
  period_end date,
  generated_at timestamptz,
  has_pdf boolean,
  has_report boolean
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select r.id, r.period_start, r.period_end, r.generated_at, r.storage_path is not null,
           private.portal_store_report(r.data_snapshot, p_store_id) is not null
    from public.reports r
    where r.organization_id = v_org
      and r.store_id = p_store_id
      and r.kind = 'store_statement'
    order by r.period_start desc, r.generated_at desc;
end
$$;

-- En av butikens rapporter med innehållet (bara om det är en säker
-- butiksrapport för butiken; annars null). Samma fel för en rapport som finns
-- hos någon annan och en som inte finns.
create function public.portal_report(p_store_id uuid, p_report_id uuid)
returns table (
  report_id uuid,
  period_start date,
  period_end date,
  generated_at timestamptz,
  storage_path text,
  report jsonb
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select r.id, r.period_start, r.period_end, r.generated_at, r.storage_path,
           private.portal_store_report(r.data_snapshot, p_store_id)
    from public.reports r
    where r.organization_id = v_org
      and r.store_id = p_store_id
      and r.kind = 'store_statement'
      and r.id = p_report_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Rapporten finns inte.';
  end if;
end
$$;

-- Felanmälan från butiken: blir ett ärende (incidents) på automaten, med
-- created_by = butiksanvändaren. Automaten måste stå i butiken i dag.
create function public.portal_report_fault(
  p_store_id uuid,
  p_machine_id uuid,
  p_kind text,
  p_description text
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
  v_today date;
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_id uuid;
begin
  if p_kind is null or p_kind not in (
    'store_payment', 'store_stuck', 'store_empty', 'store_screen', 'store_damage', 'store_other'
  ) then
    raise exception using errcode = '22023', message = 'Välj vad som är fel.';
  end if;
  if v_description is not null and char_length(v_description) > 1000 then
    raise exception using errcode = '22023', message = 'Beskrivningen får vara högst 1 000 tecken.';
  end if;
  if p_kind = 'store_other' and v_description is null then
    raise exception using errcode = '22023', message = 'Beskriv vad som är fel.';
  end if;

  select (now() at time zone o.timezone)::date into v_today
  from public.organizations o where o.id = v_org;

  if p_machine_id is null or not exists (
    select 1 from public.machine_placements mp
    where mp.organization_id = v_org
      and mp.store_id = p_store_id
      and mp.machine_id = p_machine_id
      and mp.valid_from <= v_today
      and (mp.valid_to is null or mp.valid_to >= v_today)
  ) then
    raise exception using errcode = '22023', message = 'Automaten står inte i butiken.';
  end if;

  if (
    select count(*) from public.incidents i
    where i.organization_id = v_org
      and i.created_by = (select auth.uid())
      and i.kind like 'store\_%'
      and i.created_at > now() - interval '24 hours'
  ) >= 20 then
    raise exception using
      errcode = 'BL030',
      message = 'Ni har gjort många felanmälningar det senaste dygnet. Ring operatören om det är bråttom.';
  end if;

  insert into public.incidents (organization_id, machine_id, kind, started_at, description)
  values (v_org, p_machine_id, p_kind, now(), v_description)
  returning id into v_id;
  return v_id;
end
$$;

-- Felanmälningar som butikens användare gjort på automater i butiken, med
-- ärendets status (open, in_progress, resolved; se 20261102122143_drift_larm_arenden).
-- Operatörens anteckningar (action_taken), ansvarig och återbetalningar lämnas inte ut.
create function public.portal_faults(p_store_id uuid)
returns table (
  incident_id uuid,
  machine_id uuid,
  kind text,
  description text,
  status text,
  reported_at timestamptz,
  resolved_at timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select i.id, i.machine_id, i.kind, i.description, i.status, i.started_at, i.ended_at
    from public.incidents i
    join public.organizations o on o.id = i.organization_id
    where i.organization_id = v_org
      and i.kind like 'store\_%'
      and i.created_by in (
        select m.user_id from public.memberships m
        where m.organization_id = v_org and m.store_id = p_store_id and m.role = 'store'
      )
      and exists (
        select 1 from public.machine_placements mp
        where mp.organization_id = v_org
          and mp.store_id = p_store_id
          and mp.machine_id = i.machine_id
          and mp.valid_from <= (i.started_at at time zone o.timezone)::date
          and (mp.valid_to is null or mp.valid_to >= (i.started_at at time zone o.timezone)::date)
      )
    order by i.started_at desc
    limit 100;
end
$$;

-- -----------------------------------------------------------------------------
-- Inbjudan av butiksanvändare (från /butiker). Ägare och admin.
-- -----------------------------------------------------------------------------
create function public.create_store_invitation(
  p_organization_id uuid,
  p_store_id uuid,
  p_email text,
  p_valid_days integer default 14
)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_token text;
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501', message = 'Bara ägare och admin kan bjuda in.';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    raise exception using errcode = '22023', message = 'Ange en e-postadress.';
  end if;
  if p_valid_days is null or p_valid_days not between 1 and 30 then
    raise exception using errcode = '22023', message = 'En inbjudan gäller 1–30 dagar.';
  end if;
  if p_store_id is null or not exists (
    select 1 from public.stores s
    where s.organization_id = p_organization_id and s.id = p_store_id and s.archived_at is null
  ) then
    raise exception using errcode = '22023', message = 'Butiken finns inte.';
  end if;
  if exists (
    select 1
    from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.organization_id = p_organization_id
      and u.email operator(extensions.=) v_email::extensions.citext
  ) then
    raise exception using errcode = 'BL014', message = 'Personen är redan medlem.';
  end if;

  -- Tidigare obesvarade butiksinbjudningar till samma adress löper ut (inte
  -- inbjudningar med andra roller: de ägs av Användare).
  update public.invitations i
  set expires_at = now()
  where i.organization_id = p_organization_id
    and i.email operator(extensions.=) v_email::extensions.citext
    and i.role = 'store'
    and i.accepted_at is null
    and i.expires_at > now();

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.invitations (
    organization_id, email, role, store_id, token_hash, expires_at, invited_by
  )
  values (
    p_organization_id,
    v_email,
    'store',
    p_store_id,
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    now() + make_interval(days => p_valid_days),
    auth.uid()
  );

  return v_token;
end
$$;

-- accept_invitation: som i 20261102101000_rpc.sql, men medlemskapet får
-- inbjudans store_id (null för alla roller utom store).
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_invitation public.invitations;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Inloggning krävs.';
  end if;

  select * into v_invitation
  from public.invitations i
  where i.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
  for update;

  if not found then
    raise exception using errcode = 'BL010', message = 'Inbjudan finns inte.';
  end if;
  if v_invitation.accepted_at is not null then
    raise exception using errcode = 'BL011', message = 'Inbjudan har redan använts.';
  end if;
  if v_invitation.expires_at <= now() then
    raise exception using errcode = 'BL012', message = 'Inbjudan har gått ut.';
  end if;
  if not (coalesce(v_claims ->> 'email', '')::extensions.citext operator(extensions.=) v_invitation.email) then
    raise exception using
      errcode = 'BL013',
      message = 'Inbjudan gäller en annan e-postadress.';
  end if;
  if exists (
    select 1 from public.memberships m
    where m.organization_id = v_invitation.organization_id and m.user_id = v_uid
  ) then
    raise exception using errcode = 'BL014', message = 'Du är redan medlem.';
  end if;

  insert into public.memberships (organization_id, user_id, role, store_id)
  values (v_invitation.organization_id, v_uid, v_invitation.role, v_invitation.store_id);

  update public.invitations
  set accepted_at = now(), accepted_by = v_uid
  where id = v_invitation.id;

  insert into public.profiles (organization_id, user_id, display_name)
  values (
    v_invitation.organization_id,
    v_uid,
    coalesce(
      nullif(btrim(v_claims -> 'user_metadata' ->> 'full_name'), ''),
      nullif(split_part(v_invitation.email::text, '@', 1), ''),
      'Medlem'
    )
  )
  on conflict (organization_id, user_id) do nothing;

  return v_invitation.organization_id;
end
$$;

-- -----------------------------------------------------------------------------
-- Rättigheter
-- -----------------------------------------------------------------------------
revoke all on function public.portal_stores() from public, anon;
revoke all on function public.portal_sales(uuid, date, date) from public, anon;
revoke all on function public.portal_agreements(uuid) from public, anon;
revoke all on function public.portal_machines(uuid) from public, anon;
revoke all on function public.portal_reports(uuid) from public, anon;
revoke all on function public.portal_report(uuid, uuid) from public, anon;
revoke all on function public.portal_report_fault(uuid, uuid, text, text) from public, anon;
revoke all on function public.portal_faults(uuid) from public, anon;
revoke all on function public.create_store_invitation(uuid, uuid, text, integer) from public, anon;
revoke all on function public.accept_invitation(text) from public, anon;

grant execute on function public.portal_stores() to authenticated;
grant execute on function public.portal_sales(uuid, date, date) to authenticated;
grant execute on function public.portal_agreements(uuid) to authenticated;
grant execute on function public.portal_machines(uuid) to authenticated;
grant execute on function public.portal_reports(uuid) to authenticated;
grant execute on function public.portal_report(uuid, uuid) to authenticated;
grant execute on function public.portal_report_fault(uuid, uuid, text, text) to authenticated;
grant execute on function public.portal_faults(uuid) to authenticated;
grant execute on function public.create_store_invitation(uuid, uuid, text, integer) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;

-- -----------------------------------------------------------------------------
-- Filer: butiksanvändaren får läsa PDF:en till sina egna butiksrapporter.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'Schemat storage saknas: portalens policy skapas inte.';
    return;
  end if;

  create policy binderlab_reports_select_store on storage.objects
    for select to authenticated
    using (bucket_id = 'reports' and private.portal_can_read_report_file(name));
end
$$;
