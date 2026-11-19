-- =============================================================================
-- Avräkningen: betalt belopp, dagens uträkning och rättelser
--
-- En betald avräkning låser beloppet, men månaden kan räknas om efteråt (ett rättat
-- inköpspris, en sen order) och butiken kan ha fått en rapport med ett annat belopp. Appen
-- ska visa skillnaden och låta ägaren lägga den som en egen rad på nästa avräkning.
--
--   paid_amount_ore   beloppet som betalades, när det inte är avräkningens belopp (ägaren
--                     betalade beloppet i rapporten butiken fick). null = amount_ore.
--   live_amount_ore   månadens belopp räknat med dagens underlag, sparat av det nattliga
--                     jobbet för betalda avräkningar (Att göra läser det). null = inte räknat.
--   live_checked_at   när live_amount_ore räknades.
--   corrected_ore     summan av skillnader från den här betalda avräkningen som redan
--                     lagts som rättelse på en senare avräkning.
--   corrections       rättelser som lagts PÅ den här avräkningen:
--                     [{"sourceId": uuid, "month": "ÅÅÅÅ-MM", "amountOre": 79020,
--                       "paidOre": 838808, "liveOre": 917828, "at": iso, "by": uuid}]
--                     De står som egna rader i uträkningen (statement) och ingår i amount_ore.
--
-- Bara nya kolumner med standardvärden. Den gamla koden rör dem inte: den markerar som
-- betald och ångrar som förut. Vakten byts mot en som också låser de nya kolumnerna.
-- =============================================================================

alter table public.store_settlements
  add column paid_amount_ore bigint,
  add column live_amount_ore bigint,
  add column live_checked_at timestamptz,
  add column corrected_ore bigint not null default 0,
  add column corrections jsonb not null default '[]'::jsonb
    check (jsonb_typeof(corrections) = 'array'),
  add constraint store_settlements_paid_amount_when_paid
    check (paid_amount_ore is null or paid_on is not null);

grant update (paid_amount_ore, live_amount_ore, live_checked_at, corrected_ore, corrections)
  on table public.store_settlements to authenticated;

create or replace function private.store_settlements_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.paid_on is not null then
      raise exception using errcode = 'BL080', message = 'En ny avräkning kan inte vara betald.';
    end if;
    new.paid_by := null;
    new.paid_marked_at := null;
    return new;
  end if;
  if (new.store_id, new.month) is distinct from (old.store_id, old.month) then
    raise exception using errcode = 'BL080', message = 'Avräkningens butik och månad ändras inte.';
  end if;
  if old.paid_on is not null and new.paid_on is not null
     and (new.amount_ore, new.statement, new.calc_version, new.computed_at,
          new.corrections, new.paid_amount_ore)
         is distinct from (old.amount_ore, old.statement, old.calc_version, old.computed_at,
                           old.corrections, old.paid_amount_ore) then
    raise exception using errcode = 'BL081', message = 'Avräkningen är betald och räknas inte om.';
  end if;
  if new.paid_on is distinct from old.paid_on then
    if new.paid_on is not null and old.paid_on is null
       and (new.amount_ore, new.statement, new.corrections)
           is distinct from (old.amount_ore, old.statement, old.corrections) then
      raise exception using errcode = 'BL081', message = 'Markera som betald utan att ändra beloppet.';
    end if;
    if new.paid_on is not null
       and new.paid_on > ((now() at time zone 'Europe/Stockholm')::date + 1) then
      raise exception using errcode = '22023', message = 'Betaldatumet kan inte vara i framtiden.';
    end if;
    if new.paid_on is null then
      -- En skillnad som redan ligger som rättelse på en senare avräkning skulle betalas två
      -- gånger om den här blev obetald och räknades om.
      if old.corrected_ore <> 0 then
        raise exception using
          errcode = 'BL081',
          message = 'Skillnaden ligger som rättelse på en senare avräkning. Ta bort rättelsen först.';
      end if;
      new.paid_by := null;
      new.paid_marked_at := null;
      new.paid_amount_ore := null;
      new.live_amount_ore := null;
      new.live_checked_at := null;
    else
      new.paid_by := auth.uid();
      new.paid_marked_at := now();
    end if;
  else
    new.paid_by := old.paid_by;
    new.paid_marked_at := old.paid_marked_at;
    if new.paid_on is null and new.paid_amount_ore is not null then
      raise exception using errcode = 'BL081', message = 'Betalt belopp sätts när avräkningen markeras som betald.';
    end if;
  end if;
  return new;
end
$$;
