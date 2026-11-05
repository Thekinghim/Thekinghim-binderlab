-- =============================================================================
-- Demo för kunder: en ägare skapar en egen demoorganisation åt en presumtiv kund
-- (Inställningar → Demo för kunder), med påhittad data och utan något från den
-- riktiga organisationen.
--
-- * organizations.is_demo: organisationen är en demo. Sätts bara av servern
--   (databasägaren); klientrollerna har ingen uppdateringsrätt på kolumnen.
--   Kolumnen säger INTE vilken organisation som skapade demon (det id:t får
--   kunden aldrig se); kopplingen ligger i private.customer_demos.
-- * private.customer_demos: vilken riktig organisation som skapade vilken demo,
--   kundens e-post och demons platshållaranvändare. Schemat private exponeras
--   inte; ägaren läser listan via list_customer_demos (bara ägare i en riktig
--   organisation).
-- * Inget går ut från en demo: inbjudningar (även butiksportalen) och
--   datakällor som hämtar från Awish nekas i databasen med ett vänligt
--   meddelande (BL090, BL092). Servern sätter binderlab.demo_setup = 'on' i sin
--   egen transaktion när den bjuder in kunden.
-- * Ingen riktig användare i en demo: den som är medlem i en riktig organisation
--   kan inte bli medlem i en demo (BL091). Annars skulle kunden se ägarens e-post
--   under Användare.
-- * Demon skapas och raderas utan session_replication_role (kräver superuser):
--   - inköpsorderrader kan skrivas med historisk inleverans när servern sätter
--     binderlab.historic_seed = 'on' (inleveransen skrivs då separat med rätt tid),
--   - "minst en ägare" gäller inte gallringen (binderlab.allow_purge, som förut).
--   Båda kräver att anslutningen är databasägaren (session_user = postgres);
--   PostgREST ansluter som authenticator och kan aldrig sätta dem.
-- =============================================================================

alter table public.organizations add column is_demo boolean not null default false;

comment on column public.organizations.is_demo is
  'Demoorganisation (Demo för kunder eller den lokala demon). Inget skickas ut härifrån.';

-- -----------------------------------------------------------------------------
-- Systemflaggor
-- -----------------------------------------------------------------------------
create function private.system_flag(p_name text) returns boolean
language sql stable
set search_path = ''
as $$
  select session_user = 'postgres'
     and coalesce(current_setting(p_name, true), '') = 'on'
$$;

revoke all on function private.system_flag(text) from public, anon;
grant execute on function private.system_flag(text) to authenticated;

comment on function private.system_flag(text) is
  'Servern (databasägarens anslutning) har satt flaggan i transaktionen.';

-- -----------------------------------------------------------------------------
-- Kopplingen riktig organisation → demo
-- -----------------------------------------------------------------------------
create table private.customer_demos (
  id uuid primary key default gen_random_uuid(),
  -- Den riktiga organisationen som skapade demon.
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- Demoorganisationen (null medan den skapas om eller efter radering).
  demo_organization_id uuid unique references public.organizations (id) on delete set null,
  customer_email extensions.citext not null
    check (customer_email::text ~ '^[^@[:space:]]+@[^@[:space:]]+$' and char_length(customer_email::text) <= 320),
  -- Platshållarna (ägare, läsare, påfyllare) som äger demons data. Raderas med demon.
  placeholder_user_ids uuid[] not null default '{}',
  -- Kundens konto när demon återställs efter att kunden gått med (läggs till igen som ägare).
  customer_user_id uuid,
  -- Ett steg i taget: den som kör ett steg håller raden till den här tidpunkten.
  lease_until timestamptz,
  -- Demons "nu" (svensk tid). Samma värden ger samma demo.
  clock_date date not null,
  clock_hour integer not null check (clock_hour between 0 and 23),
  status text not null default 'creating' check (status in ('creating', 'ready', 'failed')),
  step integer not null default 0,
  steps integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create index customer_demos_org_idx on private.customer_demos (organization_id, created_at);

revoke all on table private.customer_demos from public, anon, authenticated, service_role;

comment on table private.customer_demos is
  'Demo för kunder. Bara servern skriver; ägaren läser via list_customer_demos.';

-- Ägarens lista: kundens e-post, när demon skapades och om inbjudan är accepterad.
-- Aldrig demons id:n, platshållarna eller något ur demon utöver det.
create function public.list_customer_demos(p_organization_id uuid)
returns table (
  id uuid,
  customer_email text,
  status text,
  step integer,
  steps integer,
  created_at timestamptz,
  accepted boolean,
  invitation_expires_at timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not private.has_role(p_organization_id, 'owner')
     or exists (select 1 from public.organizations o where o.id = p_organization_id and o.is_demo) then
    raise exception using errcode = '42501', message = 'Bara ägaren kan se kunddemos.';
  end if;
  return query
    select d.id, d.customer_email::text, d.status, d.step, d.steps, d.created_at,
           exists (
             select 1 from public.memberships m
             join auth.users u on u.id = m.user_id
             where m.organization_id = d.demo_organization_id
               and lower(u.email::text) = lower(d.customer_email::text)
           ),
           (select max(i.expires_at) from public.invitations i
            where i.organization_id = d.demo_organization_id
              and i.email operator(extensions.=) d.customer_email
              and i.accepted_at is null)
    from private.customer_demos d
    where d.organization_id = p_organization_id
    order by d.created_at desc;
end
$$;

revoke all on function public.list_customer_demos(uuid) from public, anon;
grant execute on function public.list_customer_demos(uuid) to authenticated;

comment on function public.list_customer_demos(uuid) is
  'Ägarens kunddemos (e-post, status, accepterad). Bara ägare i en riktig organisation.';

-- -----------------------------------------------------------------------------
-- Inget går ut från en demo
-- -----------------------------------------------------------------------------
create function private.demo_forbid_invitation() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.organizations o where o.id = new.organization_id and o.is_demo)
     and not private.system_flag('binderlab.demo_setup') then
    raise exception using
      errcode = 'BL090',
      message = 'Det här är en demo – inbjudningar är avstängda.';
  end if;
  return new;
end
$$;

create trigger t05_demo_forbid before insert on public.invitations
  for each row execute function private.demo_forbid_invitation();

create function private.demo_forbid_real_member() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.organizations o where o.id = new.organization_id and o.is_demo)
     and exists (
       select 1 from public.memberships m
       join public.organizations o on o.id = m.organization_id
       where m.user_id = new.user_id and not o.is_demo
     ) then
    raise exception using
      errcode = 'BL091',
      message = 'Kontot används redan i Binderlab och kan inte gå med i en demo. Använd en annan e-postadress.';
  end if;
  return new;
end
$$;

create trigger t05_demo_no_real_member before insert on public.memberships
  for each row execute function private.demo_forbid_real_member();

create function private.demo_forbid_integration() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.provider <> 'awish_csv'
     and exists (select 1 from public.organizations o where o.id = new.organization_id and o.is_demo) then
    raise exception using
      errcode = 'BL092',
      message = 'Det här är en demo – kopplingar till Awish och andra tjänster är avstängda.';
  end if;
  return new;
end
$$;

create trigger t05_demo_forbid before insert or update of provider on public.data_sources
  for each row execute function private.demo_forbid_integration();

revoke all on function private.demo_forbid_invitation() from public, anon;
revoke all on function private.demo_forbid_real_member() from public, anon;
revoke all on function private.demo_forbid_integration() from public, anon;

-- -----------------------------------------------------------------------------
-- Skapa och radera utan session_replication_role
-- -----------------------------------------------------------------------------

-- Som förut, men med binderlab.historic_seed skriver servern inleveransen själv
-- med rätt (historisk) tid i stället för att triggern stämplar den "nu".
create or replace function private.purchase_order_lines_receive() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_delta integer := new.received_quantity - case when tg_op = 'UPDATE' then old.received_quantity else 0 end;
  v_location uuid;
begin
  if v_delta = 0 then
    return null;
  end if;
  if v_delta < 0 then
    raise exception using
      errcode = '22023',
      message = 'Mottaget antal kan inte minska. Rätta med en lagerjustering.';
  end if;
  if private.system_flag('binderlab.historic_seed') then
    return null;
  end if;
  select l.id into v_location
  from public.stock_locations l
  where l.organization_id = new.organization_id and l.is_central;
  if v_location is null then
    raise exception using errcode = '22023', message = 'Organisationen saknar centrallager.';
  end if;
  insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, note)
  values (new.organization_id, v_location, new.title_id, 'receipt', v_delta, 'Inleverans');
  return null;
end
$$;

-- Som förut, men gallringen (hela organisationen raderas) behöver ingen ägare kvar.
create or replace function private.memberships_keep_owner() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then
    return null;
  end if;
  if tg_op = 'DELETE' and private.system_flag('binderlab.allow_purge') then
    return null;
  end if;
  perform 1 from public.organizations o where o.id = old.organization_id for update;
  if current_setting('transaction_isolation') <> 'read committed' then
    perform 1 from public.memberships m
    where m.organization_id = old.organization_id and m.role = 'owner'
    for update;
  end if;
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
