-- =============================================================================
-- Fas 9 Ekonomi: åtgärder efter granskningen.
--
-- 1. Avtalsfilen (lagrad XSS). Filtypen begränsas till tillåtlistan (PDF, PNG,
--    JPEG, Word). Sökvägen och filkolumnerna (storage_path, file_*) sätts bara av
--    servern via public.attach_contract_file, som kontrollerar roll, typ och att
--    sökvägen är "{org}/{avtal}/{sha256}.{ändelse}". En klient (authenticated)
--    som skriver kolumnerna direkt stoppas av en AFTER-trigger (efter
--    check-villkoren, så att en sökväg i en annan organisation fortfarande ger
--    23514). Servern kontrollerar dessutom innehållet igen när filen läses.
-- 2. En utredd avvikelse måste bära serverns fingerprint (annars skulle den
--    gälla för alltid, även när avvikelsen växer).
-- 3. En felaktig utbetalning kan arkiveras och importeras igen med samma
--    referens: referensen är unik bara bland icke arkiverade utbetalningar.
-- 4. voucher_deliveries: loggen över verifikationer som skickats till
--    bokföringsprogrammet (append-only). En månad skickas en gång per program,
--    och nummerserien (fortlöpande över räkenskapsåret) ligger fast.
-- 5. Kontoplanen får ett bankkonto (nyckel bank, BAS 1930) för verifikationen
--    per utbetalning, i de organisationer som har en kontoplan men saknar det.
--
-- Påfyllaren ser ingen av tabellerna (tillåtlistan nämner dem inte).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. contracts: filtyp och filkolumner
-- -----------------------------------------------------------------------------
alter table public.contracts
  add constraint contracts_file_content_type_allowed check (
    file_content_type is null or file_content_type in (
      'application/pdf',
      'image/png',
      'image/jpeg',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  );

-- Klientroller får inte skriva avtalsfilens kolumner direkt. Funktionen är
-- avsiktligt INTE security definer: current_user är då den inloggade rollen
-- (authenticated), men ägaren av public.attach_contract_file när den anropas
-- därifrån.
create function private.contracts_file_columns_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return null;
  end if;
  if tg_op = 'INSERT' then
    if new.storage_path is not null or new.file_name is not null
       or new.file_content_type is not null or new.file_size_bytes is not null
       or new.file_sha256 is not null then
      raise exception using
        errcode = '42501',
        message = 'Avtalsfilen bifogas bara genom att ladda upp den.';
    end if;
  elsif (new.storage_path, new.file_name, new.file_content_type, new.file_size_bytes, new.file_sha256)
        is distinct from
        (old.storage_path, old.file_name, old.file_content_type, old.file_size_bytes, old.file_sha256) then
    raise exception using
      errcode = '42501',
      message = 'Avtalsfilen bifogas bara genom att ladda upp den.';
  end if;
  return null;
end
$$;

revoke all on function private.contracts_file_columns_guard() from public, anon;

create trigger t46_file_columns after insert or update on public.contracts
  for each row execute function private.contracts_file_columns_guard();

-- Bifogar avtalsfilen (anropas av servern efter att innehållet kontrollerats).
create function public.attach_contract_file(
  p_organization_id uuid,
  p_contract_id uuid,
  p_storage_path text,
  p_file_name text,
  p_content_type text,
  p_size_bytes bigint,
  p_sha256 text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ext text;
  v_name text := btrim(coalesce(p_file_name, ''));
begin
  if (select auth.uid()) is null
     or not private.has_role(p_organization_id, 'owner', 'admin') then
    raise exception using errcode = '42501', message = 'Du har inte behörighet till det här.';
  end if;
  v_ext := case p_content_type
    when 'application/pdf' then 'pdf'
    when 'image/png' then 'png'
    when 'image/jpeg' then 'jpg'
    when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then 'docx'
  end;
  if v_ext is null then
    raise exception using
      errcode = 'BL042',
      message = 'Filen måste vara PDF, PNG, JPEG eller Word (.docx).';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
     or p_storage_path is distinct from
        p_organization_id::text || '/' || p_contract_id::text || '/' || p_sha256 || '.' || v_ext then
    raise exception using errcode = 'BL042', message = 'Ogiltig sökväg för avtalsfilen.';
  end if;
  if char_length(v_name) not between 1 and 255 then
    raise exception using errcode = 'BL042', message = 'Filnamnet måste vara 1–255 tecken.';
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 20 * 1024 * 1024 then
    raise exception using errcode = 'BL042', message = 'Filen är tom eller för stor (högst 20 MB).';
  end if;

  update public.contracts
     set storage_path = p_storage_path,
         file_name = v_name,
         file_content_type = p_content_type,
         file_size_bytes = p_size_bytes,
         file_sha256 = p_sha256
   where organization_id = p_organization_id and id = p_contract_id;
  if not found then
    raise exception using errcode = 'BL042', message = 'Avtalet finns inte.';
  end if;
end
$$;

revoke all on function public.attach_contract_file(uuid, uuid, text, text, text, bigint, text)
  from public, anon;
grant execute on function public.attach_contract_file(uuid, uuid, text, text, text, bigint, text)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 2. deviation_reviews: utredd kräver fingerprint
-- -----------------------------------------------------------------------------
alter table public.deviation_reviews
  add constraint deviation_reviews_investigated_fingerprint
    check (action <> 'investigated' or fingerprint is not null);

-- -----------------------------------------------------------------------------
-- 3. payouts: referensen unik bland icke arkiverade
-- -----------------------------------------------------------------------------
alter table public.payouts drop constraint payouts_organization_id_reference_key;
create unique index payouts_active_reference_key
  on public.payouts (organization_id, reference)
  where archived_at is null;

-- -----------------------------------------------------------------------------
-- 4. voucher_deliveries
-- -----------------------------------------------------------------------------
create table public.voucher_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  month date not null check (extract(day from month) = 1),
  provider text not null check (provider in ('local', 'fortnox', 'visma_enet', 'bokio')),
  series text not null check (series ~ '^[A-Za-z0-9]{1,10}$'),
  first_number integer not null check (first_number >= 1),
  last_number integer not null,
  verification_count integer not null,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  external_reference text check (external_reference is null or char_length(external_reference) <= 500),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  unique (organization_id, id),
  unique (organization_id, month, provider),
  check (last_number >= first_number),
  check (verification_count = last_number - first_number + 1)
);

create trigger t00_forbid_org_change before update on public.voucher_deliveries
  for each row execute function private.forbid_org_change();
create trigger t01_append_only before update or delete on public.voucher_deliveries
  for each row execute function private.forbid_mutation();
create trigger t01_no_truncate before truncate on public.voucher_deliveries
  for each statement execute function private.forbid_truncate();
create trigger t20_stamp_insert before insert on public.voucher_deliveries
  for each row execute function private.stamp_insert();
create trigger t90_audit after insert on public.voucher_deliveries
  for each row execute function private.audit();

alter table public.voucher_deliveries alter column organization_id set statistics 0;

alter table public.voucher_deliveries enable row level security;
revoke all on table public.voucher_deliveries from anon, authenticated;
grant select, insert on table public.voucher_deliveries to authenticated;

create policy voucher_deliveries_select on public.voucher_deliveries
  for select to authenticated
  using (organization_id = any (array(select private.orgs_with_role('owner', 'admin', 'viewer'))));
create policy voucher_deliveries_insert on public.voucher_deliveries
  for insert to authenticated
  with check (organization_id = any (array(select private.orgs_with_role('owner', 'admin'))));

-- -----------------------------------------------------------------------------
-- 5. Bankkonto i kontoplanen
-- -----------------------------------------------------------------------------
insert into public.ledger_accounts (organization_id, key, bas_account, name)
select la.organization_id, 'bank', '1930', 'Företagskonto/checkkonto/affärskonto'
from public.ledger_accounts la
where la.key = 'settlement'
on conflict (organization_id, key) do nothing;

revoke all on all functions in schema private from public;
