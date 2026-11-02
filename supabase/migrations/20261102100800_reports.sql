-- =============================================================================
-- 9. Rapporter: report_recipients, reports, report_deliveries (append-only).
-- =============================================================================

create table public.report_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  email extensions.citext not null check (email::text ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  kind public.report_recipient_kind not null,
  store_id uuid,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, store_id) references public.stores (organization_id, id)
    on delete set null (store_id)
);

-- En genererad rapport. data_snapshot + calc_version gör att den kan återskapas
-- exakt; bara storage_path kan sättas i efterhand (när PDF:en är klar).
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind public.report_kind not null,
  period_start date not null,
  period_end date not null,
  store_id uuid,
  storage_path text check (storage_path like organization_id::text || '/%'),
  generated_by uuid references auth.users (id) on delete set null,
  generated_at timestamptz not null default now(),
  data_snapshot jsonb not null check (jsonb_typeof(data_snapshot) = 'object'),
  calc_version text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, store_id) references public.stores (organization_id, id)
    on delete restrict,
  check (period_end >= period_start)
);

create table public.report_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  report_id uuid not null,
  recipient_id uuid,
  -- Adressen när rapporten skickades (mottagaren kan ändras senare).
  email extensions.citext not null,
  status public.report_delivery_status not null,
  sent_at timestamptz,
  provider_message_id text,
  error text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  foreign key (organization_id, report_id) references public.reports (organization_id, id)
    on delete restrict,
  foreign key (organization_id, recipient_id) references public.report_recipients (organization_id, id)
    on delete restrict
);

create index report_deliveries_report_idx on public.report_deliveries (organization_id, report_id, created_at);

create trigger t00_forbid_org_change before update on public.report_recipients
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.report_recipients
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.report_recipients
  for each row execute function private.stamp_update();

create trigger t00_forbid_org_change before update on public.reports
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.reports
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.reports
  for each row execute function private.stamp_update();
create trigger t99_forbid_delete before delete on public.reports
  for each row execute function private.forbid_delete();

create trigger t00_forbid_org_change before update on public.report_deliveries
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.report_deliveries
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.report_deliveries
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.report_deliveries
  for each row execute function private.stamp_insert();
create trigger t90_audit after insert on public.report_deliveries
  for each row execute function private.audit();

alter table public.report_recipients enable row level security;
revoke all on table public.report_recipients from anon, authenticated;
grant select, insert, update, delete on table public.report_recipients to authenticated;

create policy report_recipients_select on public.report_recipients
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy report_recipients_insert on public.report_recipients
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy report_recipients_update on public.report_recipients
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy report_recipients_delete on public.report_recipients
  for delete to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.reports enable row level security;
revoke all on table public.reports from anon, authenticated;
grant select, insert on table public.reports to authenticated;
grant update (storage_path) on table public.reports to authenticated;

create policy reports_select on public.reports
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy reports_insert on public.reports
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
create policy reports_update on public.reports
  for update to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))))
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

alter table public.report_deliveries enable row level security;
revoke all on table public.report_deliveries from anon, authenticated;
grant select, insert on table public.report_deliveries to authenticated;

create policy report_deliveries_select on public.report_deliveries
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy report_deliveries_insert on public.report_deliveries
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
