-- =============================================================================
-- Utbetalningar från Nayax: vilka dagar en utbetalning gäller, ihågkomna filformat,
-- utkast som väntar på "Stämmer" och AI-körningar för att läsa rapporter.
--
-- 1. payouts.period_basis: varifrån perioden kommer. 'report' = rapporten (Nayax-PDF
--    eller filens period), 'lines' = transaktionerna i filen, 'inferred' = räknad av appen
--    (äldsta obetalda försäljningen först, src/domain/payout-coverage.ts; texten står i
--    inferred_note), 'manual' = ägaren skrev in den. period_start/period_end är som förut
--    alltid satta: en räknad period börjar dagen efter den senast täckta dagen, så den
--    överlappar aldrig en annan utbetalning.
--    Sammanfattningen (två–tre meningar med partnerns och ägarens belopp) ligger INTE på
--    payouts, som läsaren kan läsa, utan i payout_summaries (5) som bara ägare och admin ser.
-- 2. payout_import_mappings: "kom ihåg filen". Rubrikernas fingeravtryck → vilken kolumn
--    som är vad. Nästa fil med samma rubriker läses utan kolumnsteget och utan AI.
-- 3. payout_drafts: en uppladdad rapport eller inskrivning som väntar på att ägaren
--    trycker "Stämmer, spara". Inget skrivs i payouts förrän dess. Utkast äldre än 30
--    dagar tas bort av det dagliga jobbet (/api/cron/larm).
-- 4. ai_runs.purpose: 'advisor' (som förut), 'payout_read' (läsa en rapport) eller
--    'payout_summary' (sammanfattningen). trigger får också 'upload'. Kostnaden räknas
--    in i samma månadstak som förut.
--
-- 5. payout_summaries: sammanfattningen per utbetalning (mall eller AI, talen kontrollerade
--    mot uträkningen). Innehåller partnerns och ägarens belopp, så bara ägare och admin.
--
-- Rättigheter: ägare och admin. Läsaren, påfyllaren och butiksportalen ser inget.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. payouts
-- -----------------------------------------------------------------------------
alter table public.payouts
  add column period_basis text not null default 'manual'
    check (period_basis in ('report', 'lines', 'inferred', 'manual')),
  add column inferred_note text check (inferred_note is null or char_length(inferred_note) <= 500);

-- Befintliga rader: rapporten (Nayax-PDF eller fil) när de inte är inskrivna.
-- payouts_guard (t10_guard) stoppar alla ändringar av en utbetalning. Den nya kolumnen
-- fylls i här en enda gång, så vakten stängs av bara runt den raden (samma transaktion).
alter table public.payouts disable trigger t10_guard;
update public.payouts set period_basis = 'report' where not manual;
alter table public.payouts enable trigger t10_guard;

create index payouts_period_end_idx on public.payouts (organization_id, period_end)
  where archived_at is null;


-- -----------------------------------------------------------------------------
-- 2. payout_import_mappings
-- -----------------------------------------------------------------------------
create table public.payout_import_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  header_signature text not null check (header_signature ~ '^[0-9a-f]{64}$'),
  mapping jsonb not null check (jsonb_typeof(mapping) = 'object'),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, header_signature)
);

create trigger t00_forbid_org_change before update on public.payout_import_mappings
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.payout_import_mappings
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.payout_import_mappings
  for each row execute function private.stamp_update();
create trigger t90_audit after insert or update or delete on public.payout_import_mappings
  for each row execute function private.audit();

alter table public.payout_import_mappings enable row level security;
alter table public.payout_import_mappings alter column organization_id set statistics 0;
revoke all on table public.payout_import_mappings from anon, authenticated, service_role;
grant select, insert, update on table public.payout_import_mappings to authenticated;
grant select, insert, update on table public.payout_import_mappings to service_role;

create policy payout_import_mappings_select on public.payout_import_mappings
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy payout_import_mappings_insert on public.payout_import_mappings
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy payout_import_mappings_update on public.payout_import_mappings
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- 3. payout_drafts
-- -----------------------------------------------------------------------------
create table public.payout_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  source text not null check (source in ('csv', 'xlsx', 'pdf', 'image', 'manual')),
  file_name text check (file_name is null or char_length(file_name) between 1 and 255),
  storage_path text
    check (storage_path is null
           or private.storage_path_org(storage_path) is not distinct from organization_id),
  extracted jsonb not null default '{}'::jsonb check (jsonb_typeof(extracted) = 'object'),
  extractor text not null default 'deterministic' check (extractor in ('deterministic', 'ai')),
  ai_run_id uuid,
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  status text not null default 'open' check (status in ('open', 'confirmed', 'discarded')),
  payout_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, payout_id) references public.payouts (organization_id, id)
    on delete restrict,
  foreign key (organization_id, ai_run_id) references public.ai_runs (organization_id, id)
    on delete restrict,
  check ((status = 'confirmed') = (payout_id is not null))
);

create index payout_drafts_org_idx on public.payout_drafts (organization_id, created_at desc);

create trigger t00_forbid_org_change before update on public.payout_drafts
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.payout_drafts
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.payout_drafts
  for each row execute function private.stamp_update();

alter table public.payout_drafts enable row level security;
alter table public.payout_drafts alter column organization_id set statistics 0;
revoke all on table public.payout_drafts from anon, authenticated, service_role;
grant select, insert, update on table public.payout_drafts to authenticated;
grant select, insert, update, delete on table public.payout_drafts to service_role;

create policy payout_drafts_select on public.payout_drafts
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy payout_drafts_insert on public.payout_drafts
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy payout_drafts_update on public.payout_drafts
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- 4. ai_runs
-- -----------------------------------------------------------------------------
alter table public.ai_runs
  add column purpose text not null default 'advisor'
    check (purpose in ('advisor', 'payout_read', 'payout_summary'));
alter table public.ai_runs drop constraint ai_runs_trigger_check;
alter table public.ai_runs
  add constraint ai_runs_trigger_check check (trigger in ('cron', 'manual', 'upload'));

-- -----------------------------------------------------------------------------
-- 5. payout_summaries
-- -----------------------------------------------------------------------------
create table public.payout_summaries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  payout_id uuid not null,
  summary text not null check (char_length(summary) between 1 and 1000),
  written_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, payout_id),
  foreign key (organization_id, payout_id) references public.payouts (organization_id, id)
    on delete restrict
);

create trigger t00_forbid_org_change before update on public.payout_summaries
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.payout_summaries
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.payout_summaries
  for each row execute function private.stamp_update();

alter table public.payout_summaries enable row level security;
alter table public.payout_summaries alter column organization_id set statistics 0;
revoke all on table public.payout_summaries from anon, authenticated, service_role;
grant select, insert on table public.payout_summaries to authenticated;
grant update (summary, written_at) on table public.payout_summaries to authenticated;
grant select, insert, update on table public.payout_summaries to service_role;

create policy payout_summaries_select on public.payout_summaries
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy payout_summaries_insert on public.payout_summaries
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy payout_summaries_update on public.payout_summaries
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
