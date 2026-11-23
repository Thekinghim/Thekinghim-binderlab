-- =============================================================================
-- Notis vid varje försäljning: en push när Awish-synken har hämtat nya köp.
--
-- 1. profiles.sale_push_since (timestamptz | null): personens knapp "Notis vid varje
--    försäljning". null = av (standard). Tidpunkten då knappen slogs på: bara order som
--    sparades efter den skickas, så att den som slår på inte får en hög gamla köp.
--    profiles.sale_push_quiet (boolean, standard false): tyst 22–07 i organisationens
--    tidszon. Personen ändrar sin egen rad (profiles_update, som för språket och
--    veckosammanfattningen).
-- 2. public.sale_notifications: en rad per order som har tagits om hand av notisjobbet.
--    unique (organization_id, order_id) gör att samma order aldrig skickas två gånger:
--    jobbet lägger raderna (insert … on conflict do nothing returning) och skickar bara de
--    order som blev nya rader. Två samtidiga körningar väntar på varandra på nyckeln, så
--    bara en av dem skickar. Raderna skrivs bara av servern (systemrollen) och tas bort
--    efter sju dagar (jobbet tittar bara på order från det senaste dygnet).
--    Ägare och admin ser organisationens rader; ingen annan.
--
-- Allt är additivt: två nya kolumner och en ny tabell.
-- =============================================================================

alter table public.profiles
  add column sale_push_since timestamptz,
  add column sale_push_quiet boolean not null default false;

comment on column public.profiles.sale_push_since is
  'Notis vid varje försäljning: påslagen sedan (null = av). Bara order sparade efter den skickas.';
comment on column public.profiles.sale_push_quiet is
  'Notis vid varje försäljning: tyst 22–07 i organisationens tidszon.';

grant update (display_name, locale, weekly_summary, sale_push_since, sale_push_quiet)
  on table public.profiles to authenticated;

create table public.sale_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  order_id uuid not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, order_id),
  foreign key (organization_id, order_id) references public.orders (organization_id, id)
    on delete restrict
);

create index sale_notifications_created_idx on public.sale_notifications (created_at);

comment on table public.sale_notifications is
  'Notis vid varje försäljning: order som notisjobbet har tagit om hand (skrivs av servern). En rad per order.';

create trigger t00_forbid_org_change before update on public.sale_notifications
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.sale_notifications
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.sale_notifications
  for each row execute function private.stamp_update();

alter table public.sale_notifications enable row level security;
revoke all on table public.sale_notifications from anon, authenticated, service_role;
grant select on table public.sale_notifications to authenticated;
grant select, insert, delete on table public.sale_notifications to service_role;

-- Ägare och admin ser organisationens rader (som orders_select, utan läsaren: raderna säger
-- bara vilka order som har notifierats).
create policy sale_notifications_select on public.sale_notifications
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

revoke all on all functions in schema private from public;
