-- =============================================================================
-- Avtal: vinstdelning (50/50 av vinsten efter kostnader).
--
-- * loss_treatment: vad som händer när månadens vinst är negativ.
--     'zero' (standard): butiken får 0 kr.
--     'proportional':    butiken bär sin andel av förlusten.
-- * En vinstdelning måste ha en andel (commission_bp).
-- * portal_agreements returnerar underlag och förlusthantering, så att
--   butiksportalen kan visa avtalet ("50 % av vinsten efter kostnader").
--
-- commission_base behåller standardvärdet 'net_excl_vat' i databasen: rader som
-- läggs in utan underlag (seed, tester, äldre kod) behåller sin betydelse. Appen
-- (Butiker) skapar nya avtal som 'profit_after_costs' 5 000 bp.
--
-- Befintliga avtal ändras inte här. Att byta ett avtal (t.ex. Sega gubben) görs
-- av ägaren i Butiker; ändringen loggas (t90_audit) och stängda månader skyddas
-- av t40_period_guard (alla kolumner utom metadata räknas som villkor).
-- =============================================================================

create type public.loss_treatment as enum ('zero', 'proportional');

alter table public.store_agreements
  add column loss_treatment public.loss_treatment not null default 'zero';

alter table public.store_agreements
  add constraint store_agreements_split_share_check
    check (commission_base <> 'profit_after_costs' or commission_bp is not null);

comment on column public.store_agreements.commission_base is
  'Underlag för commission_bp: net_excl_vat = andel av försäljningen exkl. moms per order; profit_after_costs = butikens andel av vinsten efter VMB-moms, inköp och kortavgifter per butik och månad.';
comment on column public.store_agreements.loss_treatment is
  'Vinstdelning med negativ vinst: zero = butiken får 0, proportional = butiken bär sin andel av förlusten.';

-- Portalen: avtalet med underlag och förlusthantering. Returtypen ändras, så
-- funktionen skapas om (samma kontroll av butiksanvändaren som tidigare).
drop function public.portal_agreements(uuid);

create function public.portal_agreements(p_store_id uuid)
returns table (
  valid_from date,
  valid_to date,
  commission_bp integer,
  monthly_rent_ore bigint,
  commission_base public.commission_base,
  loss_treatment public.loss_treatment
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select a.valid_from, a.valid_to, a.commission_bp, a.monthly_rent_ore,
           a.commission_base, a.loss_treatment
    from public.store_agreements a
    where a.organization_id = v_org and a.store_id = p_store_id
    order by a.valid_from;
end
$$;

revoke all on function public.portal_agreements(uuid) from public, anon;
grant execute on function public.portal_agreements(uuid) to authenticated;
