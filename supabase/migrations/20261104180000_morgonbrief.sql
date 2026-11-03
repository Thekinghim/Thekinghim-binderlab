-- =============================================================================
-- Managerpaket 5: morgonbriefen på Hem (ai_briefs).
--
-- Tre korta rader per organisation och dag: "I går", "Fel" och "Gör i dag". Servern
-- bygger ett litet underlag (gårdagens försäljning mot samma veckodag veckan före och
-- punkterna i Att göra) och ber den billiga modellen om tre rader. Rader vars tal inte
-- finns i underlaget byts mot en fast mening ur samma underlag (src/server/assistant/
-- brief). Görs en gång per dag: i AI-rådgivarens dagliga körning (/api/cron/ai) eller
-- vid första besöket på Hem samma dag. Kostnaden räknas in i månadstaket
-- (AI_MONTHLY_BUDGET_SEK) tillsammans med ai_runs och assistentens frågor.
--
-- Behörighet: som ai_runs. Ägare och admin läser (briefen innehåller belopp); bara
-- servern skriver. En rad per organisation och dag (unik), högst tre försök.
-- =============================================================================

create table public.ai_briefs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  -- Affärsdatum (organisationens tidszon) som briefen gäller.
  brief_date date not null,
  -- cron: dagliga körningen. visit: första besöket på Hem.
  trigger text not null check (trigger in ('cron', 'visit')),
  -- running: pågår. ok: raderna sparade. budget: månadens tak nått, inget anrop.
  -- error: fel från API:t (nytt försök vid nästa besök, högst tre försök).
  status text not null default 'running'
    check (status in ('running', 'ok', 'budget', 'error')),
  attempts smallint not null default 1 check (attempts between 1 and 3),
  line_yesterday text check (line_yesterday is null or char_length(line_yesterday) between 1 and 200),
  line_problem text check (line_problem is null or char_length(line_problem) between 1 and 200),
  line_today text check (line_today is null or char_length(line_today) between 1 and 200),
  -- Underlaget raderna kontrollerades mot (för felsökning; bara belopp och punkter).
  facts jsonb not null default '{}'::jsonb check (jsonb_typeof(facts) = 'object'),
  -- [{ line, reason }] för rader som byttes mot den fasta meningen.
  rejected jsonb not null default '[]'::jsonb check (jsonb_typeof(rejected) = 'array'),
  model text not null check (char_length(model) between 1 and 100),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  -- Kostnad i öre (SEK), räknad med listpriset och AI_USD_SEK (summa för alla försök).
  cost_ore integer not null default 0 check (cost_ore >= 0),
  error text check (error is null or char_length(error) <= 2000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, brief_date),
  check (
    status <> 'ok'
    or (line_yesterday is not null and line_problem is not null and line_today is not null)
  )
);

comment on table public.ai_briefs is
  'Morgonbriefen på Hem: tre rader per organisation och dag (managerpaket 5).';

create index ai_briefs_created_idx on public.ai_briefs (created_at);

alter table public.ai_briefs alter column organization_id set statistics 0;

create trigger t00_forbid_org_change before update on public.ai_briefs
  for each row execute function private.forbid_org_change();
create trigger t20_stamp_insert before insert on public.ai_briefs
  for each row execute function private.stamp_insert();
create trigger t20_stamp_update before update on public.ai_briefs
  for each row execute function private.stamp_update();

alter table public.ai_briefs enable row level security;

revoke all on table public.ai_briefs from anon, authenticated, service_role;
grant select on table public.ai_briefs to authenticated;
-- Servernyckeln (service_role) som ai_runs; appen skriver via databasägaren.
grant select, insert, update on table public.ai_briefs to service_role;

create policy ai_briefs_select on public.ai_briefs for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));
