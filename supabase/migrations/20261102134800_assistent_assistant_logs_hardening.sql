-- =============================================================================
-- Assistent: skärpt behörighet för assistant_logs (granskningen av fas 6b).
--
-- 1. Loggen skrivs bara av servern. Tidigare fick varje medlem skriva egna rader
--    direkt (INSERT under RLS), vilket gick att göra via API:t med påhittade svar,
--    verktygsresultat och status "answered". Loggen dög då inte som revisionsspår, och
--    påhittade tal i en tidigare rad räknades som underlag i en följdfråga.
--    Nu: ingen INSERT-rättighet för authenticated. Raden skrivs av
--    private.insert_assistant_log (security definer). Schemat private exponeras inte
--    via API:t (se foundation), så funktionen nås bara av servern, som kör den i
--    användarens transaktion (withRls) efter att svaret räknats fram.
--    Funktionen kräver inloggning (auth.uid()), sätter user_id själv och kräver att
--    rollen på raden är användarens faktiska roll i organisationen. Butiksrollen
--    (store) har ingen assistent och kan aldrig skriva.
--
-- 2. En nedgraderad användare ser inte längre ekonomi i sina gamla rader. Egna rader
--    läses bara om rollen de skrevs med ser lika lite som (eller mindre än) rollen
--    användaren har nu:
--      * rader skrivna som ägare, admin eller läsare (ekonomi) kräver att användaren
--        fortfarande är ägare, admin eller läsare;
--      * rader skrivna som påfyllare (bara lagerdata) läses av alla roller utom store.
--    Ägare och admin läser som förut alla rader i organisationen.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Skrivning bara via servern
-- -----------------------------------------------------------------------------
drop policy assistant_logs_insert on public.assistant_logs;
revoke insert on table public.assistant_logs from authenticated;

create function private.insert_assistant_log(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_role public.member_role,
  p_question text,
  p_answer text,
  p_status text,
  p_provider text,
  p_model text,
  p_tool_calls jsonb,
  p_verification jsonb,
  p_usage jsonb,
  p_error text,
  p_duration_ms integer
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Inte inloggad.';
  end if;
  if p_role is null or p_role = 'store' or not exists (
    select 1 from public.memberships m
    where m.organization_id = p_organization_id
      and m.user_id = v_uid
      and m.role = p_role
  ) then
    raise exception using
      errcode = '42501',
      message = 'Rollen på raden är inte din roll i organisationen.';
  end if;

  insert into public.assistant_logs (
    organization_id, conversation_id, user_id, role, question, answer, status,
    provider, model, tool_calls, verification, usage, error, duration_ms
  ) values (
    p_organization_id, p_conversation_id, v_uid, p_role, p_question,
    coalesce(p_answer, ''), p_status, p_provider, p_model,
    coalesce(p_tool_calls, '[]'::jsonb), coalesce(p_verification, '{}'::jsonb),
    coalesce(p_usage, '{}'::jsonb), p_error, coalesce(p_duration_ms, 0)
  )
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function private.insert_assistant_log(
  uuid, uuid, public.member_role, text, text, text, text, text, jsonb, jsonb, jsonb, text, integer
) from public, anon;
grant execute on function private.insert_assistant_log(
  uuid, uuid, public.member_role, text, text, text, text, text, jsonb, jsonb, jsonb, text, integer
) to authenticated;

-- -----------------------------------------------------------------------------
-- 2. Läsning efter nuvarande roll
-- -----------------------------------------------------------------------------
drop policy assistant_logs_select on public.assistant_logs;

create policy assistant_logs_select on public.assistant_logs
  for select to authenticated
  using (
    organization_id = any (array(select private.orgs_with_role('owner', 'admin')))
    or (
      user_id = (select auth.uid())
      and (
        (
          role in ('owner', 'admin', 'viewer')
          and organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer')))
        )
        or (
          role = 'refiller'
          and organization_id = any (
            array(select private.orgs_with_role('owner', 'admin', 'refiller', 'viewer'))
          )
        )
      )
    )
  );
