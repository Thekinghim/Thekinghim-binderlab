-- =============================================================================
-- 1. Organisation och åtkomst, 8. Perioder, 10. Inställningar och ägande,
-- 12. Ändringslogg.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- organizations
-- -----------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  timezone text not null default 'Europe/Stockholm' check (private.is_valid_timezone(timezone)),
  currency text not null default 'SEK' check (currency ~ '^[A-Z]{3}$'),
  plan public.organization_plan not null default 'standard',
  machine_limit integer check (machine_limit >= 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.organizations is
  'Operatör (hyresgäst). Skapas bara via create_organization(). Raderas aldrig, arkiveras.';

-- -----------------------------------------------------------------------------
-- memberships + rollkontroller
-- -----------------------------------------------------------------------------
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, user_id)
);

create index memberships_user_id_idx on public.memberships (user_id);

-- Har den inloggade användaren någon av rollerna i organisationen?
create function private.has_role(p_organization_id uuid, variadic p_roles public.member_role[])
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
  )
$$;

-- Samma fråga som has_role men för alla organisationer på en gång. Policyerna
-- använder den som "organization_id = any (array(select ...))", vilket Postgres
-- räknar ut EN gång per fråga (InitPlan) och kan använda index för. has_role
-- per rad var ca 60 gånger långsammare på 200 000 order (1,1 s mot 17 ms).
create function private.orgs_with_role(variadic p_roles public.member_role[])
returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select m.organization_id
  from public.memberships m
  where m.user_id = (select auth.uid())
    and m.role = any (p_roles)
$$;

revoke all on function private.has_role(uuid, public.member_role[]) from public, anon;
revoke all on function private.orgs_with_role(public.member_role[]) from public, anon;
grant execute on function private.has_role(uuid, public.member_role[]) to authenticated;
grant execute on function private.orgs_with_role(public.member_role[]) to authenticated;

-- Minst en ägare. Låser organisationsraden så att två samtidiga
-- nedgraderingar inte kan lämna organisationen utan ägare.
create function private.memberships_keep_owner() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then
    return null;
  end if;
  perform 1 from public.organizations o where o.id = old.organization_id for update;
  if not exists (
    select 1 from public.memberships m
    where m.organization_id = old.organization_id and m.role = 'owner'
  ) then
    raise exception using
      errcode = 'BL005',
      message = 'Organisationen måste ha minst en ägare.',
      hint = 'Gör någon annan till ägare först.';
  end if;
  return null;
end
$$;

-- Ingen rollhöjning förbi den egna rollen: en admin kan inte skapa, ändra
-- eller ta bort en ägare, och kan inte göra sig själv till ägare.
-- Gäller direkta skrivningar från klienter (current_user = authenticated).
-- Den som inte är ägare/admin i organisationen stoppas av RLS i stället.
create function private.memberships_guard_role() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if private.has_role(v_org, 'owner') or not private.has_role(v_org, 'admin') then
    return coalesce(new, old);
  end if;
  if (tg_op in ('INSERT', 'UPDATE') and new.role = 'owner')
     or (tg_op in ('UPDATE', 'DELETE') and old.role = 'owner') then
    raise exception using
      errcode = 'BL006',
      message = 'Bara en ägare kan ge, ändra eller ta bort ägarrollen.';
  end if;
  return coalesce(new, old);
end
$$;

-- -----------------------------------------------------------------------------
-- profiles (visningsnamn per organisation; anonymiseras när användaren raderas)
-- -----------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid references auth.users (id) on delete set null,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 200),
  anonymized_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, user_id)
);

create function private.profiles_anonymize() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.user_id is not null and new.user_id is null then
    new.display_name := 'Borttagen användare';
    new.anonymized_at := coalesce(new.anonymized_at, now());
  end if;
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- invitations (bara sha256-hash av token sparas)
-- -----------------------------------------------------------------------------
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  email extensions.citext not null check (email::text ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  role public.member_role not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (accepted_by is null or accepted_at is not null)
);

create index invitations_org_email_idx on public.invitations (organization_id, email);

-- -----------------------------------------------------------------------------
-- audit_log (append-only, skrivs bara av private.audit())
-- -----------------------------------------------------------------------------
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  table_name text not null,
  row_id uuid not null,
  action public.audit_action not null,
  actor_id uuid references auth.users (id) on delete set null,
  occurred_at timestamptz not null default now(),
  before jsonb,
  after jsonb,
  unique (organization_id, id),
  check (before is not null or after is not null)
);

create index audit_log_org_time_idx on public.audit_log (organization_id, occurred_at desc);
create index audit_log_row_idx on public.audit_log (organization_id, table_name, row_id, occurred_at desc);

-- Skriver en rad i audit_log. Argumenten är kolumner som inte ska loggas
-- (t.ex. token_hash). Ändringar som bara nollar aktörskolumner efter att en
-- användare raderats (GDPR) loggas inte, och inte heller ändringar utan effekt.
create function private.audit() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_row jsonb;
  v_strip text[] := coalesce(tg_argv::text[], '{}');
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_before := to_jsonb(old) - v_strip;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_after := to_jsonb(new) - v_strip;
  end if;
  if tg_op = 'UPDATE' then
    if (v_before - 'updated_at') = (v_after - 'updated_at') then
      return null;
    end if;
    if private.is_actor_anonymization(to_jsonb(old), to_jsonb(new)) then
      return null;
    end if;
  end if;
  v_row := coalesce(v_after, v_before);
  insert into public.audit_log (organization_id, table_name, row_id, action, actor_id, before, after)
  values (
    (v_row ->> 'organization_id')::uuid,
    tg_table_name,
    (v_row ->> 'id')::uuid,
    lower(tg_op)::public.audit_action,
    auth.uid(),
    v_before,
    v_after
  );
  return null;
end
$$;

-- -----------------------------------------------------------------------------
-- period_closes (månadsstängning). Skrivs bara via close_period/reopen_period.
-- En rad per stängning; öppnas månaden sätts reopened_at och en ny stängning
-- blir en ny rad. Historiken finns alltså kvar.
-- -----------------------------------------------------------------------------
create table public.period_closes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  month date not null check (extract(day from month) = 1),
  closed_at timestamptz not null default now(),
  closed_by uuid references auth.users (id) on delete set null,
  reopened_at timestamptz,
  reopened_by uuid references auth.users (id) on delete set null,
  snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (reopened_at is null or reopened_at >= closed_at),
  check (reopened_by is null or reopened_at is not null)
);

create unique index period_closes_one_open_per_month
  on public.period_closes (organization_id, month)
  where reopened_at is null;

-- Bara öppning (reopened_at/reopened_by) får ändras på en stängning.
create function private.period_closes_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_changed text[] := private.changed_keys(to_jsonb(old), to_jsonb(new));
begin
  if private.is_actor_anonymization(to_jsonb(old), to_jsonb(new)) then
    return new;
  end if;
  if old.reopened_at is not null
     or not (v_changed <@ array['reopened_at', 'reopened_by', 'updated_at']) then
    raise exception using
      errcode = 'BL004',
      message = 'En månadsstängning kan bara öppnas, inte ändras.';
  end if;
  return new;
end
$$;

-- Stängda månader för en organisation, som ett datumintervall-set.
create function private.closed_months(p_organization_id uuid) returns datemultirange
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    range_agg(daterange(pc.month, (pc.month + interval '1 month')::date, '[)')),
    '{}'::datemultirange
  )
  from public.period_closes pc
  where pc.organization_id = p_organization_id
    and pc.reopened_at is null
$$;

-- Kastar BL004 om något av datumen i p_affected ligger i en stängd månad.
create function private.assert_period_open(
  p_organization_id uuid,
  p_affected datemultirange,
  p_what text
) returns void
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_overlap datemultirange;
begin
  if p_affected is null or isempty(p_affected) then
    return;
  end if;
  v_overlap := p_affected * private.closed_months(p_organization_id);
  if not isempty(v_overlap) then
    raise exception using
      errcode = 'BL004',
      message = format(
        '%s påverkar en stängd månad (%s).',
        p_what,
        to_char(lower(v_overlap), 'YYYY-MM')
      ),
      hint = 'Bara en ägare kan öppna en stängd månad.';
  end if;
end
$$;

-- Är dagen i en stängd månad?
create function private.is_closed_day(p_organization_id uuid, p_day date) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.period_closes pc
    where pc.organization_id = p_organization_id
      and pc.reopened_at is null
      and pc.month = date_trunc('month', p_day)::date
  )
$$;

-- -----------------------------------------------------------------------------
-- organization_settings (en rad per organisation)
-- -----------------------------------------------------------------------------
create table public.organization_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations (id) on delete restrict,
  vat_rate_bp integer not null default 0 check (vat_rate_bp between 0 and 10000),
  card_fee_bp integer not null default 0 check (card_fee_bp between 0 and 10000),
  fiscal_year_start_month integer not null default 1 check (fiscal_year_start_month between 1 and 12),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

-- -----------------------------------------------------------------------------
-- owner_shares (ägarandelar; varje valid_from-grupp summerar till 10 000 bp)
-- -----------------------------------------------------------------------------
create table public.owner_shares (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  member_user_id uuid references auth.users (id) on delete set null,
  holder_name text not null check (char_length(btrim(holder_name)) between 1 and 200),
  share_bp integer not null check (share_bp between 1 and 10000),
  valid_from date not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, valid_from, holder_name)
);

-- Kontrolleras vid commit, så att en hel grupp kan läggas in rad för rad.
create function private.owner_shares_check_sum() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_group record;
  v_sum bigint;
begin
  for v_group in
    select distinct x.organization_id, x.valid_from
    from (
      select new.organization_id, new.valid_from where tg_op in ('INSERT', 'UPDATE')
      union all
      select old.organization_id, old.valid_from where tg_op in ('UPDATE', 'DELETE')
    ) x
  loop
    select coalesce(sum(s.share_bp), 0) into v_sum
    from public.owner_shares s
    where s.organization_id = v_group.organization_id and s.valid_from = v_group.valid_from;
    if v_sum <> 0 and v_sum <> 10000 then
      raise exception using
        errcode = 'BL018',
        message = format(
          'Ägarandelarna från %s summerar till %s baspunkter, inte 10 000.',
          v_group.valid_from, v_sum
        );
    end if;
  end loop;
  return null;
end
$$;

-- -----------------------------------------------------------------------------
-- ledger_accounts (kontoplan, BAS)
-- -----------------------------------------------------------------------------
create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  bas_account text not null check (bas_account ~ '^[0-9]{4}$'),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, key)
);

-- -----------------------------------------------------------------------------
-- Organisationsspecifika triggers
-- -----------------------------------------------------------------------------

-- Bara ägaren kan arkivera (eller återställa) organisationen.
create function private.organizations_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception using errcode = 'BL001', message = 'En organisations id kan inte ändras.';
  end if;
  if current_user = 'authenticated'
     and new.archived_at is distinct from old.archived_at
     and not private.has_role(old.id, 'owner') then
    raise exception using
      errcode = '42501',
      message = 'Bara ägaren kan arkivera organisationen.';
  end if;
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------
create trigger t00_guard before update on public.organizations
  for each row execute function private.organizations_guard();
create trigger t20_stamp_insert before insert on public.organizations
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.organizations
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.organizations
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.memberships
  for each row execute function private.forbid_org_change();
create trigger t10_guard_role before insert or update or delete on public.memberships
  for each row execute function private.memberships_guard_role();
create trigger t20_stamp_insert before insert on public.memberships
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.memberships
  for each row execute function private.stamp_update();
create trigger t80_keep_owner after update or delete on public.memberships
  for each row execute function private.memberships_keep_owner();
create trigger t90_audit after insert or update or delete on public.memberships
  for each row execute function private.audit();

create trigger t00_forbid_org_change before update on public.profiles
  for each row execute function private.forbid_org_change();
create trigger t10_anonymize before update on public.profiles
  for each row execute function private.profiles_anonymize();
create trigger t20_stamp_insert before insert on public.profiles
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.profiles
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.profiles
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.invitations
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.invitations
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.invitations
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.invitations
  for each row execute function private.audit('token_hash');

create trigger t00_forbid_org_change before update on public.audit_log
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.audit_log
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.audit_log
  for each statement execute function private.forbid_truncate();

create trigger t00_forbid_org_change before update on public.period_closes
  for each row execute function private.forbid_org_change();
create trigger t10_guard before update on public.period_closes
  for each row execute function private.period_closes_guard();
create trigger t20_stamp_insert before insert on public.period_closes
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.period_closes
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.period_closes
  for each row execute function private.audit();
create trigger t99_forbid_delete before delete on public.period_closes
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.organization_settings
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.organization_settings
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.organization_settings
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.organization_settings
  for each row execute function private.audit();
create trigger t99_forbid_delete before delete on public.organization_settings
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.owner_shares
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.owner_shares
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.owner_shares
  for each row execute function private.stamp_update();
create constraint trigger t80_check_sum after insert or update or delete on public.owner_shares
  deferrable initially deferred
  for each row execute function private.owner_shares_check_sum();
create trigger t90_audit after insert or update or delete on public.owner_shares
  for each row execute function private.audit();
create trigger t99_forbid_delete before delete on public.owner_shares
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.ledger_accounts
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.ledger_accounts
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.ledger_accounts
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.ledger_accounts
  for each row execute function private.audit();

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS
-- Mönster: "organization_id = any (array(select private.orgs_with_role(...)))".
-- Påfyllaren (refiller) styrs av en tillåtlista: bara tabeller som uttryckligen
-- nämner 'refiller' i sin select-policy är synliga för den rollen.
-- -----------------------------------------------------------------------------

-- organizations: läses av alla medlemmar (tillåtlistad). Skapas via RPC.
alter table public.organizations enable row level security;
revoke all on table public.organizations from anon, authenticated;
grant select on table public.organizations to authenticated;
grant update (name, slug, timezone, archived_at) on table public.organizations to authenticated;

create policy organizations_select on public.organizations
  for select to authenticated
  using (id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))));
create policy organizations_update on public.organizations
  for update to authenticated
  using (id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- memberships: eget medlemskap (alla roller) och alla för ägare/admin.
alter table public.memberships enable row level security;
revoke all on table public.memberships from anon, authenticated;
grant select, insert, delete on table public.memberships to authenticated;
grant update (role) on table public.memberships to authenticated;

create policy memberships_select on public.memberships
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
  );
create policy memberships_insert on public.memberships
  for insert to authenticated
  with check (
    organization_id = any (array(select private.orgs_with_role('owner')))
    or (organization_id = any (array(select private.orgs_with_role('admin'))) and role <> 'owner')
  );
create policy memberships_update on public.memberships
  for update to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner')))
    or (organization_id = any (array(select private.orgs_with_role('admin'))) and role <> 'owner')
  )
  with check (
    organization_id = any (array(select private.orgs_with_role('owner')))
    or (organization_id = any (array(select private.orgs_with_role('admin'))) and role <> 'owner')
  );
create policy memberships_delete on public.memberships
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    or organization_id = any (array(select private.orgs_with_role('owner')))
    or (organization_id = any (array(select private.orgs_with_role('admin'))) and role <> 'owner')
  );

-- profiles: egen profil (alla roller), alla för ägare/admin/läsare.
alter table public.profiles enable row level security;
revoke all on table public.profiles from anon, authenticated;
grant select, insert on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;

create policy profiles_select on public.profiles
  for select to authenticated
  using (
    (user_id = (select auth.uid())
      and organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))))
    or organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer')))
  );
create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
    or (user_id = (select auth.uid())
      and organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))))
  );
create policy profiles_update on public.profiles
  for update to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
    or (user_id = (select auth.uid())
      and organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))))
  )
  with check (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
    or (user_id = (select auth.uid())
      and organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))))
  );

-- invitations: bara ägare/admin. Skapas och accepteras via RPC.
alter table public.invitations enable row level security;
revoke all on table public.invitations from anon, authenticated;
grant select, delete on table public.invitations to authenticated;

create policy invitations_select on public.invitations
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy invitations_delete on public.invitations
  for delete to authenticated
  using (
    accepted_at is null
    and (
      organization_id = any (array(select private.orgs_with_role('owner')))
      or (organization_id = any (array(select private.orgs_with_role('admin'))) and role <> 'owner')
    )
  );

-- audit_log: läses av ägare, admin och läsare (läsare ser inte medlems- och
-- inbjudningshändelser). Ingen roll får skriva, ändra eller radera.
alter table public.audit_log enable row level security;
revoke all on table public.audit_log from anon, authenticated, service_role;
grant select on table public.audit_log to authenticated, service_role;

create policy audit_log_select on public.audit_log
  for select to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
    or (organization_id = any (array(select private.orgs_with_role('viewer')))
      and table_name not in ('memberships', 'invitations'))
  );

-- period_closes: läses av ägare/admin/läsare, skrivs bara via RPC.
alter table public.period_closes enable row level security;
revoke all on table public.period_closes from anon, authenticated;
grant select on table public.period_closes to authenticated;

create policy period_closes_select on public.period_closes
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));

-- organization_settings
alter table public.organization_settings enable row level security;
revoke all on table public.organization_settings from anon, authenticated;
grant select, insert on table public.organization_settings to authenticated;
grant update (vat_rate_bp, card_fee_bp, fiscal_year_start_month)
  on table public.organization_settings to authenticated;

create policy organization_settings_select on public.organization_settings
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy organization_settings_insert on public.organization_settings
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy organization_settings_update on public.organization_settings
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- owner_shares: läses av ägare/admin/läsare, skrivs bara av ägare.
alter table public.owner_shares enable row level security;
revoke all on table public.owner_shares from anon, authenticated;
grant select, insert, update on table public.owner_shares to authenticated;

create policy owner_shares_select on public.owner_shares
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy owner_shares_insert on public.owner_shares
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner'))));
create policy owner_shares_update on public.owner_shares
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner'))));

-- ledger_accounts
alter table public.ledger_accounts enable row level security;
revoke all on table public.ledger_accounts from anon, authenticated;
grant select, insert, update, delete on table public.ledger_accounts to authenticated;

create policy ledger_accounts_select on public.ledger_accounts
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy ledger_accounts_insert on public.ledger_accounts
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy ledger_accounts_update on public.ledger_accounts
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy ledger_accounts_delete on public.ledger_accounts
  for delete to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

revoke all on all functions in schema private from public;
grant execute on function private.has_role(uuid, public.member_role[]) to authenticated;
grant execute on function private.orgs_with_role(public.member_role[]) to authenticated;
