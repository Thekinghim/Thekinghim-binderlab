-- =============================================================================
-- Butiker: en adress får bara ta emot en butiks rapport en gång.
--
-- Två aktiva mottagare med samma adress för samma butik ger dubbla utskick av
-- månadsrapporten. Tjänsten (Butiker) stoppar dubbletter när en mottagare läggs
-- till eller ändras; indexet stoppar dem en gång till, även från andra vägar
-- (Rapporter, import). Pausade mottagare omfattas inte: en mottagare som fått
-- rapporter kan inte tas bort, bara pausas, och får då ligga kvar bredvid en ny.
--
-- Befintliga aktiva dubbletter pausas först (den äldsta behålls aktiv), så att
-- indexet går att skapa. Pausningen loggas i audit_log av triggern.
-- =============================================================================

with ranked as (
  select id,
         row_number() over (
           partition by organization_id, store_id, lower(email::text)
           order by created_at, id
         ) as n
  from public.report_recipients
  where kind = 'store' and store_id is not null and active
)
update public.report_recipients r
   set active = false
  from ranked
 where ranked.id = r.id and ranked.n > 1;

create unique index report_recipients_store_email_key
  on public.report_recipients (organization_id, store_id, email)
  where kind = 'store' and store_id is not null and active;
