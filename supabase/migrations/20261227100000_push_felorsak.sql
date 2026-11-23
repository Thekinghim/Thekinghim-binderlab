-- Push-tjänstens senaste svar per enhet (t.ex. "HTTP 403 BadJwtToken"), så att en enhet som
-- inte får notiser går att felsöka. Skrivs bara av servern (systemrollen); den inloggade
-- läser sin egen rad som förut.
alter table public.push_subscriptions add column if not exists last_failure_detail text
  check (last_failure_detail is null or char_length(last_failure_detail) <= 120);
