-- =============================================================================
-- Awish: automatens anslutning (online/offline) och när Awish-kontot går ut.
--
-- 1. source_machines.awish_*: senaste läget från Machines (is_online, status) per
--    Awish-automat, skrivet av synken var tionde minut (src/server/awish/sync.ts,
--    reglerna i src/analytics/health/connectivity.ts):
--      awish_online             senaste svaret (null = aldrig läst)
--      awish_status             Machine.status som text
--      awish_seen_at            senaste gången automaten fanns i svaret
--      awish_online_at          senaste gången den var online (null = aldrig: inget larm)
--      awish_offline_since      början på pågående offlineperiod (null = online)
--      awish_back_online_at     när den kom tillbaka (en offlineperiod slutar först när
--                               automaten varit online 20 minuter, mot fladder)
--      awish_last_offline_from  början på senaste avslutade offlineperiod (tidslinjen)
-- 2. data_sources.awish_expires_at / awish_merchant_checked_at: Merchant.expired_at,
--    läst högst en gång per dygn. Att göra, Drift och Datakällor varnar 30 dagar före.
-- 3. public.machine_connectivity(org): anslutningen per Binderlab-automat för alla roller
--    i organisationen (påfyllaren läser inte source_machines). Samma mönster som
--    sales_data_until: anroparens rättigheter, läsning via en definer-funktion i private.
--
-- Kolumnerna skrivs bara av synken (systemrollen); klientroller nekas av triggrar.
-- =============================================================================

alter table public.source_machines
  add column awish_online boolean,
  add column awish_status text,
  add column awish_seen_at timestamptz,
  add column awish_online_at timestamptz,
  add column awish_offline_since timestamptz,
  add column awish_back_online_at timestamptz,
  add column awish_last_offline_from timestamptz;

comment on column public.source_machines.awish_online is
  'Senaste Machines.is_online från Awish-synken. null = aldrig läst.';
comment on column public.source_machines.awish_offline_since is
  'Början på pågående offlineperiod enligt Awish (null = online). Larm efter 20 minuter.';
comment on column public.source_machines.awish_online_at is
  'Senaste gången Awish sa att automaten var online. null = aldrig (inget offlinelarm).';

alter table public.data_sources
  add column awish_expires_at timestamptz,
  add column awish_merchant_checked_at timestamptz;

comment on column public.data_sources.awish_expires_at is
  'Merchant.expired_at (Awish-kontots slutdag), läst av synken högst en gång per dygn.';

create function private.source_machines_client_awish() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and (
       tg_op = 'INSERT' and (
         new.awish_online is not null or new.awish_status is not null
         or new.awish_seen_at is not null or new.awish_online_at is not null
         or new.awish_offline_since is not null or new.awish_back_online_at is not null
         or new.awish_last_offline_from is not null)
       or tg_op = 'UPDATE' and (
         new.awish_online is distinct from old.awish_online
         or new.awish_status is distinct from old.awish_status
         or new.awish_seen_at is distinct from old.awish_seen_at
         or new.awish_online_at is distinct from old.awish_online_at
         or new.awish_offline_since is distinct from old.awish_offline_since
         or new.awish_back_online_at is distinct from old.awish_back_online_at
         or new.awish_last_offline_from is distinct from old.awish_last_offline_from)
     ) then
    raise exception using
      errcode = '42501',
      message = 'Bara Awish-synken kan ändra automatens anslutning.';
  end if;
  return new;
end
$$;

create trigger t06_client_awish before insert or update on public.source_machines
  for each row execute function private.source_machines_client_awish();

create function private.data_sources_client_awish_expiry() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and (
       tg_op = 'INSERT' and (new.awish_expires_at is not null
                             or new.awish_merchant_checked_at is not null)
       or tg_op = 'UPDATE' and (
         new.awish_expires_at is distinct from old.awish_expires_at
         or new.awish_merchant_checked_at is distinct from old.awish_merchant_checked_at)
     ) then
    raise exception using
      errcode = '42501',
      message = 'Bara Awish-synken kan ändra när Awish-kontot går ut.';
  end if;
  return new;
end
$$;

create trigger t06_client_awish_expiry before insert or update on public.data_sources
  for each row execute function private.data_sources_client_awish_expiry();

revoke all on function private.source_machines_client_awish() from public;
revoke all on function private.data_sources_client_awish_expiry() from public;

-- Anslutningen per automat: den senast lästa Awish-automaten som är kopplad till den
-- (källan inte arkiverad). Bara tidpunkter och läge, inga Awish-id.
create function private.machine_connectivity_rows(p_organization_id uuid)
returns table (
  machine_id uuid,
  online boolean,
  status text,
  seen_at timestamptz,
  online_at timestamptz,
  offline_since timestamptz,
  back_online_at timestamptz,
  last_offline_from timestamptz
)
language sql stable security definer
set search_path = ''
as $$
  select distinct on (sm.machine_id)
         sm.machine_id, sm.awish_online, sm.awish_status, sm.awish_seen_at,
         sm.awish_online_at, sm.awish_offline_since, sm.awish_back_online_at,
         sm.awish_last_offline_from
  from public.source_machines sm
  join public.data_sources ds
    on ds.organization_id = sm.organization_id and ds.id = sm.data_source_id
  join public.machines m
    on m.organization_id = sm.organization_id and m.id = sm.machine_id
  where sm.organization_id = p_organization_id
    and sm.machine_id is not null
    and sm.awish_seen_at is not null
    and ds.archived_at is null
    and m.archived_at is null
    and ((select auth.uid()) is null
         or private.has_role(p_organization_id, 'owner', 'admin', 'viewer', 'refiller'))
  order by sm.machine_id, sm.awish_seen_at desc
$$;
revoke all on function private.machine_connectivity_rows(uuid) from public;
grant execute on function private.machine_connectivity_rows(uuid) to authenticated;

create function public.machine_connectivity(p_organization_id uuid)
returns table (
  machine_id uuid,
  online boolean,
  status text,
  seen_at timestamptz,
  online_at timestamptz,
  offline_since timestamptz,
  back_online_at timestamptz,
  last_offline_from timestamptz
)
language plpgsql stable
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and not private.has_role(p_organization_id, 'owner', 'admin', 'viewer', 'refiller') then
    raise exception using errcode = '42501',
      message = 'Du har inte behörighet till organisationens driftdata.';
  end if;
  return query select * from private.machine_connectivity_rows(p_organization_id);
end
$$;
revoke all on function public.machine_connectivity(uuid) from public, anon;
grant execute on function public.machine_connectivity(uuid) to authenticated;
