-- =============================================================================
-- Kortavgiften gäller från ett datum
--
-- organization_settings.card_fee_bp var en enda sats för alla datum: en ändring räknade om
-- all historik. Nu sparas satserna med startdatum i card_fee_history, en lista
--   [{"from": "ÅÅÅÅ-MM-DD", "bp": 400}, …]   (stigande datum, första raden är grundsatsen)
-- En order får satsen på den sista raden med from <= orderns dag. card_fee_bp finns kvar
-- och är satsen som gäller i dag (den nya koden skriver båda).
--
-- Tom lista = en sats för alla datum (card_fee_bp), som förut. Så är det för alla
-- organisationer direkt efter migreringen: ingen siffra ändras.
--
-- Säkert medan den gamla koden kör: den läser bara card_fee_bp. Skriver den card_fee_bp
-- utan att röra listan (en ändring "för alla datum", som den alltid gjort) töms listan av
-- triggern, så att kolumnerna aldrig säger olika saker.
--
-- Stängda månader: en ändring som ger någon dag i en stängd månad en annan sats nekas
-- (BL004), som för inköpspriser och avtal.
-- =============================================================================

alter table public.organization_settings
  add column card_fee_history jsonb not null default '[]'::jsonb
    check (jsonb_typeof(card_fee_history) = 'array');

comment on column public.organization_settings.card_fee_history is
  'Kortavgiften med startdatum: [{"from": "ÅÅÅÅ-MM-DD", "bp": 400}]. Tom = card_fee_bp gäller alla datum.';

grant update (card_fee_history) on table public.organization_settings to authenticated;

-- Satsen (bp) som gäller en dag.
create function private.card_fee_bp_on(p_history jsonb, p_fallback integer, p_day date)
returns integer
language sql immutable
set search_path = ''
as $$
  select coalesce(
    (select (e ->> 'bp')::integer
     from jsonb_array_elements(p_history) e
     where (e ->> 'from')::date <= p_day
     order by (e ->> 'from')::date desc
     limit 1),
    -- Före första raden gäller den första raden (grundsatsen); tom lista: card_fee_bp.
    (select (e ->> 'bp')::integer
     from jsonb_array_elements(p_history) e
     order by (e ->> 'from')::date
     limit 1),
    p_fallback
  )
$$;

revoke all on function private.card_fee_bp_on(jsonb, integer, date) from public, anon;

-- Före skrivning: formen kontrolleras, och en ändring av bara card_fee_bp (gamla koden)
-- tömmer listan.
create function private.organization_settings_card_fee() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_prev date;
  v_from date;
  v_bp integer;
  e jsonb;
begin
  if tg_op = 'UPDATE'
     and new.card_fee_bp is distinct from old.card_fee_bp
     and new.card_fee_history is not distinct from old.card_fee_history then
    new.card_fee_history := '[]'::jsonb;
  end if;
  if tg_op = 'UPDATE' and new.card_fee_history is not distinct from old.card_fee_history then
    return new;
  end if;
  for e in select * from jsonb_array_elements(new.card_fee_history) loop
    begin
      if jsonb_typeof(e) <> 'object' then
        raise exception 'form';
      end if;
      v_from := (e ->> 'from')::date;
      v_bp := (e ->> 'bp')::integer;
    exception when others then
      raise exception using errcode = '22023', message = 'Kortavgiftens datum eller sats är ogiltig.';
    end;
    if v_from is null or v_bp is null or v_bp < 0 or v_bp > 10000
       or (v_prev is not null and v_from <= v_prev) then
      raise exception using errcode = '22023', message = 'Kortavgiftens datum eller sats är ogiltig.';
    end if;
    v_prev := v_from;
  end loop;
  if jsonb_array_length(new.card_fee_history) > 200 then
    raise exception using errcode = '22023', message = 'För många ändringar av kortavgiften.';
  end if;
  return new;
end
$$;

revoke all on function private.organization_settings_card_fee() from public, anon;

create trigger t10_card_fee before insert or update on public.organization_settings
  for each row execute function private.organization_settings_card_fee();

-- Efter skrivning (när RLS godkänt raden): ingen dag i en stängd månad får en annan sats.
create function private.organization_settings_card_fee_period_guard() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_month date;
  v_day date;
begin
  if new.card_fee_bp is not distinct from old.card_fee_bp
     and new.card_fee_history is not distinct from old.card_fee_history then
    return null;
  end if;
  for v_month in
    select pc.month from public.period_closes pc
    where pc.organization_id = new.organization_id and pc.reopened_at is null
    order by pc.month
  loop
    v_day := v_month;
    while v_day < (v_month + interval '1 month')::date loop
      if private.card_fee_bp_on(old.card_fee_history, old.card_fee_bp, v_day)
         is distinct from private.card_fee_bp_on(new.card_fee_history, new.card_fee_bp, v_day) then
        perform private.assert_period_open(
          new.organization_id,
          datemultirange(daterange(v_day, v_day, '[]')),
          'Kortavgiften'
        );
      end if;
      v_day := v_day + 1;
    end loop;
  end loop;
  return null;
end
$$;

revoke all on function private.organization_settings_card_fee_period_guard() from public, anon;

create trigger t40_card_fee_period_guard after update on public.organization_settings
  for each row execute function private.organization_settings_card_fee_period_guard();
