-- =============================================================================
-- Om Awish krånglar: hälsan per Awish-väg (docs/operations.md, "Om Awish krånglar").
--
-- public.awish_path_health: en rad per datakälla och väg (orders, machines, stock, merchant,
-- push, goods, slots, campaigns, free_packs). Servern (systemrollen) skriver raden efter varje
-- försök (src/server/awish/health.ts, recordPathResult):
--
-- - active_route: vägen som fungerar nu (open_api, webbpanelen), senast kända data
--   (senast_kanda), manuell, eller ingen.
-- - last_success_at/last_success_route/last_attempt_at: senaste lyckade och senaste försöket.
-- - last_error_*: senaste felet (art, gRPC-kod, kort text utan hemligheter, högst 200 tecken).
-- - failing_since/consecutive_failures: första felet i rad utan någon fungerande väg.
-- - breaker_route/breaker_open_until: brytaren. Är den öppen hoppas vägen över (direkt till
--   reserven) tills tiden har gått; då provas den en gång igen.
-- - alerted_at/recovered_at: vakten (en push per väg, en när den fungerar igen).
-- - web_ids_verified_at: Gratis-pack. Webbpanelens fack-id har jämförts med Open API:s
--   product_id (samma) senast då. Utan den skapas inga koder från facken via webbpanelen.
--
-- Ägare, admin och läsare ser organisationens rader; bara servern skriver. Additivt: en ny
-- tabell.
-- =============================================================================

create table public.awish_path_health (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  data_source_id uuid not null,
  path text not null check (
    path in ('orders', 'machines', 'stock', 'merchant', 'push', 'goods', 'slots', 'campaigns',
             'free_packs')
  ),
  active_route text not null default 'ingen' check (
    active_route in ('open_api', 'webbpanelen', 'senast_kanda', 'manuell', 'ingen')
  ),
  last_success_at timestamptz,
  last_success_route text check (
    last_success_route is null
    or last_success_route in ('open_api', 'webbpanelen', 'senast_kanda', 'manuell')
  ),
  last_attempt_at timestamptz,
  last_error_at timestamptz,
  last_error_kind text check (last_error_kind is null or char_length(last_error_kind) <= 40),
  last_error_code integer,
  last_error_text text check (last_error_text is null or char_length(last_error_text) <= 200),
  failing_since timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  breaker_route text check (
    breaker_route is null or breaker_route in ('open_api', 'webbpanelen')
  ),
  breaker_open_until timestamptz,
  alerted_at timestamptz,
  recovered_at timestamptz,
  web_ids_verified_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, data_source_id, path),
  foreign key (organization_id, data_source_id) references public.data_sources (organization_id, id)
    on delete restrict
);

alter table public.awish_path_health alter column organization_id set statistics 0;

comment on table public.awish_path_health is
  'Om Awish krånglar: hälsan per datakälla och Awish-väg (vilken väg som fungerar, senaste fel, brytaren). Skrivs av servern.';

create trigger t00_forbid_org_change before update on public.awish_path_health
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.awish_path_health
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.awish_path_health
  for each row execute function private.stamp_update();

alter table public.awish_path_health enable row level security;
revoke all on table public.awish_path_health from anon, authenticated, service_role;
grant select on table public.awish_path_health to authenticated;
grant select, insert, update, delete on table public.awish_path_health to service_role;

-- Samma som data_sources_select: ägare, admin och läsare.
create policy awish_path_health_select on public.awish_path_health
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
