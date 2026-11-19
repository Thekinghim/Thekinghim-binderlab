-- =============================================================================
-- Larm: ägare och admin prenumererar från start
--
-- Notiser-sidan visade standardvalet (push och e-post) som om det gällde, men larmjobbet
-- läste bara sparade rader i alert_subscriptions. Utan sparad rad fick ingen något larm:
-- i produktionen fanns 0 prenumerationer medan larmen räknade "aviserat 10 gånger".
--
-- 1. Varje ägare och admin får en rad när medlemskapet skapas eller rollen ändras till
--    ägare/admin (trigger på memberships). Standard, samma som sidan alltid har visat:
--    push och e-post till inloggningsadressen, varningar och kritiska, tysta timmar 22–07
--    där kritiska släpps igenom. Push går fram först när personen har slagit på notiser på
--    en enhet; e-post först när Binderlab har en e-postleverantör. Vakten på Hem och Drift
--    säger till när ingen nås ("Ingen får larm just nu").
-- 2. De som redan är ägare eller admin och saknar rad får den nu.
--
-- En rad som redan finns rörs aldrig (on conflict do nothing): den som har stängt av sina
-- larm (active = false) eller valt egna kanaler behåller sitt val. Inget tas bort och ingen
-- kolumn ändras, så den gamla koden fungerar som förut medan den är igång.
-- =============================================================================

create or replace function private.default_alert_subscription() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role in ('owner', 'admin') then
    insert into public.alert_subscriptions
      (organization_id, user_id, channels, min_severity, quiet_start, quiet_end,
       critical_during_quiet, notify_resolved, reminders, active)
    values
      (new.organization_id, new.user_id, array['push', 'email']::text[], 'warning', '22:00', '07:00',
       true, false, true, true)
    on conflict (organization_id, user_id) do nothing;
  end if;
  return new;
end
$$;

revoke all on function private.default_alert_subscription() from public, anon, authenticated;

comment on function private.default_alert_subscription() is
  'Ägare och admin får en larmprenumeration (push och e-post) när medlemskapet skapas eller rollen höjs. En befintlig rad rörs inte.';

create trigger t85_default_alert_subscription
  after insert or update of role on public.memberships
  for each row execute function private.default_alert_subscription();

-- Befintliga ägare och admin utan rad.
insert into public.alert_subscriptions
  (organization_id, user_id, channels, min_severity, quiet_start, quiet_end,
   critical_during_quiet, notify_resolved, reminders, active)
select m.organization_id, m.user_id, array['push', 'email']::text[], 'warning', '22:00', '07:00',
       true, false, true, true
from public.memberships m
where m.role in ('owner', 'admin')
on conflict (organization_id, user_id) do nothing;
