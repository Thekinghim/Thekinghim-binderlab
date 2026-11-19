-- =============================================================================
-- Månadsstängning från appen
--
-- close_period/reopen_period har funnits sedan start men anropades aldrig. Nu
-- stänger appen månaden när sista avräkningen markeras som betald och när
-- bokföringsmånaden markeras som skickad. Ägaren kan öppna månaden igen, med en
-- anledning som sparas på stängningen (och i audit_log via t90_audit).
--
-- Bara tillägg: en ny kolumn, en ny funktion reopen_period_with_reason och vakten som
-- släpper igenom den nya kolumnen. Den gamla reopen_period(org, month) finns kvar och
-- fungerar som förut.
-- =============================================================================

alter table public.period_closes
  add column reopened_reason text
    check (reopened_reason is null or char_length(btrim(reopened_reason)) between 1 and 500);

-- Bara öppning (reopened_at/reopened_by/reopened_reason) får ändras på en stängning.
create or replace function private.period_closes_guard() returns trigger
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
     or not (v_changed <@ array['reopened_at', 'reopened_by', 'reopened_reason', 'updated_at']) then
    raise exception using
      errcode = 'BL004',
      message = 'En månadsstängning kan bara öppnas, inte ändras.';
  end if;
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- reopen_period_with_reason(org, month, reason). Bara ägare. Anledningen krävs.
-- -----------------------------------------------------------------------------
create function public.reopen_period_with_reason(
  p_organization_id uuid,
  p_month date,
  p_reason text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not private.has_role(p_organization_id, 'owner') then
    raise exception using errcode = '42501', message = 'Bara ägaren kan öppna en stängd månad.';
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'Skriv varför månaden öppnas (3–500 tecken).';
  end if;
  select pc.id into v_id
  from public.period_closes pc
  where pc.organization_id = p_organization_id
    and pc.month = p_month
    and pc.reopened_at is null
  for update;
  if v_id is null then
    raise exception using errcode = 'BL016', message = 'Månaden är inte stängd.';
  end if;
  update public.period_closes
  set reopened_at = now(), reopened_by = auth.uid(), reopened_reason = v_reason
  where id = v_id;
end
$$;

revoke all on function public.reopen_period_with_reason(uuid, date, text) from public, anon;
grant execute on function public.reopen_period_with_reason(uuid, date, text) to authenticated;
