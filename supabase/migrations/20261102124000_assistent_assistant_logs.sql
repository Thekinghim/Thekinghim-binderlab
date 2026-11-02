-- =============================================================================
-- Assistent: logg över frågor och svar (assistant_logs).
--
-- Varje fråga till assistenten (/assistent) sparas med svaret, vilka verktyg som
-- anropades med vilka parametrar och resultat, kontrollen av talen i svaret,
-- modell, tokenåtgång och tid. En rad per fråga, skriven när svaret är klart (eller
-- när det misslyckades). Raden ändras aldrig: tabellen är append-only.
--
-- conversation_id grupperar frågorna i ett samtal. Tidigare frågor och svar i samma
-- samtal läses tillbaka härifrån (under RLS) när användaren ställer en följdfråga, så
-- att historiken aldrig kommer från webbläsaren.
--
-- Behörighet:
--   * Alla medlemmar (även påfyllare) får skriva sina egna rader, med sin faktiska
--     roll i organisationen (has_role) och sitt eget user_id.
--   * Var och en läser sina egna rader. Ägare och admin läser alla rader i
--     organisationen (uppföljning av vad assistenten svarat). Påfyllarens rader
--     innehåller bara lagerdata: assistenten ger påfyllaren bara lagerverktyg.
--   * Ingen ändrar eller raderar (forbid_mutation). Raderas en användare nollas
--     user_id/created_by (GDPR), vilket forbid_mutation tillåter i systemkontext.
--
-- Ingen audit-trigger: tabellen är själv en logg och skrivs bara en gång. En kopia
-- i audit_log skulle bara dubblera innehållet (inklusive belopp i svaren).
-- =============================================================================

create table public.assistant_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  conversation_id uuid not null,
  user_id uuid references auth.users (id) on delete set null,
  -- Rollen när frågan ställdes (styr vilka verktyg assistenten fick).
  role public.member_role not null,
  question text not null check (char_length(btrim(question)) between 1 and 2000),
  answer text not null default '' check (char_length(answer) <= 50000),
  -- answered: alla tal i svaret fanns i verktygsresultaten. unverified: minst ett tal
  -- saknades. refused: modellen avböjde. limit: för många verktygsvarv. error: fel.
  status text not null
    check (status in ('answered', 'unverified', 'refused', 'limit', 'error')),
  provider text not null check (provider in ('anthropic', 'local')),
  model text not null check (char_length(model) between 1 and 100),
  -- [{ name, input, ok, summary, result, durationMs }]
  tool_calls jsonb not null default '[]'::jsonb check (jsonb_typeof(tool_calls) = 'array'),
  -- { checked, unverified: [...] }
  verification jsonb not null default '{}'::jsonb check (jsonb_typeof(verification) = 'object'),
  -- { inputTokens, outputTokens, cacheReadTokens, turns }
  usage jsonb not null default '{}'::jsonb check (jsonb_typeof(usage) = 'object'),
  error text check (error is null or char_length(error) <= 2000),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id)
);

create index assistant_logs_user_idx
  on public.assistant_logs (organization_id, user_id, created_at desc);
create index assistant_logs_conversation_idx
  on public.assistant_logs (organization_id, conversation_id, created_at);

alter table public.assistant_logs alter column organization_id set statistics 0;

create trigger t00_forbid_org_change before update on public.assistant_logs
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.assistant_logs
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.assistant_logs
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.assistant_logs
  for each row execute function private.stamp_insert();

-- -----------------------------------------------------------------------------
-- Rättigheter och RLS
-- -----------------------------------------------------------------------------
alter table public.assistant_logs enable row level security;
revoke all on table public.assistant_logs from anon, authenticated;
grant select, insert on table public.assistant_logs to authenticated;

create policy assistant_logs_select on public.assistant_logs
  for select to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
    or (
      user_id = (select auth.uid())
      and organization_id = any (
        array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))
      )
    )
  );

create policy assistant_logs_insert on public.assistant_logs
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and private.has_role(organization_id, role)
  );
