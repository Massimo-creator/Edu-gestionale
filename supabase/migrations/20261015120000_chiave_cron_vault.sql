-- Chiavi dei job pianificati (pg_cron) tenute nella cassaforte del database (Vault), mai nel codice.
-- Il job legge la chiave da vault.decrypted_secrets; la funzione Edge la controlla con verifica_chiave_cron,
-- che può chiamare solo il service role.

create or replace function public.verifica_chiave_cron(p_nome text, p_valore text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select length(p_valore) >= 32 and s.decrypted_secret = p_valore
       from vault.decrypted_secrets s
      where s.name = 'cron_' || p_nome
      limit 1),
    false);
$$;

revoke all on function public.verifica_chiave_cron(text, text) from public, anon, authenticated;
grant execute on function public.verifica_chiave_cron(text, text) to service_role;

-- Chiave del promemoria "appuntamenti da aggiornare": generata qui, nessuno la vede né la copia.
select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'cron_appuntamenti_da_aggiornare',
  'Chiave del job appuntamenti-da-aggiornare (pg_cron -> funzione Edge)')
where not exists (select 1 from vault.secrets where name = 'cron_appuntamenti_da_aggiornare');

-- Job pianificato (creato con cron.schedule il 16/10/2026): dal lunedì al venerdì alle 10:15 e alle 11:15 UTC
-- (niente mail il sabato e la domenica, decisione di Massimo del 16/10/2026);
-- la funzione parte davvero solo quando a Roma sono le 12, quindi alle 12:15 con ora legale e solare.
-- select cron.schedule('appuntamenti-da-aggiornare-giornaliero', '15 10,11 * * 1-5', $$
--   select net.http_post(
--     url := 'https://nvwqykhosumrjkdlejtb.supabase.co/functions/v1/appuntamenti-da-aggiornare',
--     headers := jsonb_build_object('Content-Type','application/json',
--       'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_appuntamenti_da_aggiornare')),
--     body := '{}'::jsonb, timeout_milliseconds := 60000);
-- $$);
-- Per fermarlo: select cron.unschedule('appuntamenti-da-aggiornare-giornaliero');
