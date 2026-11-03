-- =============================================================================
-- Avtal: "Dra av VMB-moms före delning" (per avtal).
--
-- * vmb_before_split: vid vinstdelning (commission_base 'profit_after_costs')
--     false (standard): butikens andel = andel × vinst efter inköp och kortavgifter, utan
--                       VMB-avdrag (VMB-momsen bärs då helt av operatören).
--     true:             butikens andel = andel × (vinst efter kostnader − VMB-moms).
--   Allt räknas utan VMB som standard; valet slås på per avtal. Befintliga avtal får false
--   (ägarens beslut): butikens andel blir andelen av vinsten efter inköp och kortavgifter.
-- * portal_agreements returnerar kolumnen, så att butiksrapporten i portalen räknar
--   som appen.
--
-- Ändringen räknas som ett villkor (t40_period_guard skyddar stängda månader, t90_audit
-- loggar den).
-- =============================================================================

alter table public.store_agreements
  add column vmb_before_split boolean not null default false;

comment on column public.store_agreements.vmb_before_split is
  'Vinstdelning: false (standard) = andelen räknas på vinsten efter inköp och kortavgifter utan VMB-avdrag, true = VMB-momsen dras från vinsten före delningen.';

comment on column public.store_agreements.commission_base is
  'Underlag för commission_bp: net_excl_vat = andel av försäljningen exkl. moms per order; profit_after_costs = butikens andel av vinsten efter inköp och kortavgifter (och VMB-moms när vmb_before_split) per butik och månad.';

drop function public.portal_agreements(uuid);

create function public.portal_agreements(p_store_id uuid)
returns table (
  valid_from date,
  valid_to date,
  commission_bp integer,
  monthly_rent_ore bigint,
  commission_base public.commission_base,
  loss_treatment public.loss_treatment,
  vmb_before_split boolean
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_org uuid := private.portal_require_store(p_store_id);
begin
  return query
    select a.valid_from, a.valid_to, a.commission_bp, a.monthly_rent_ore,
           a.commission_base, a.loss_treatment, a.vmb_before_split
    from public.store_agreements a
    where a.organization_id = v_org and a.store_id = p_store_id
    order by a.valid_from;
end
$$;

revoke all on function public.portal_agreements(uuid) from public, anon;
grant execute on function public.portal_agreements(uuid) to authenticated;
