-- Controllo delle automazioni (decisione di Massimo del 24/10/2026).
-- Ogni automazione registra un "battito" quando gira; la funzione controllo-automazioni ogni mattina alle 7
-- legge questi dati e scrive a Massimo solo se qualcosa non va (più un "tutto a posto" il lunedì).
-- Le tabelle le scrivono solo le funzioni (service role): nessuna regola di lettura per gli utenti dell'app.
-- NON ANCORA APPLICATA (in attesa del via di Massimo).

create table if not exists public.automazioni_stato (
  nome text primary key,
  ultimo_ok timestamptz,
  ultimo_errore timestamptz,
  errore text,
  aggiornato timestamptz not null default now()
);

create table if not exists public.automazioni_eventi (
  id bigint generated always as identity primary key,
  nome text not null,
  quando timestamptz not null default now(),
  esito text not null check (esito in ('ok', 'errore')),
  messaggio text
);
create index if not exists automazioni_eventi_quando on public.automazioni_eventi (quando desc);

alter table public.automazioni_stato enable row level security;
alter table public.automazioni_eventi enable row level security;
revoke all on public.automazioni_stato, public.automazioni_eventi from anon, authenticated;

-- Registra il passaggio di un'automazione. p_evento = false per i battiti frequenti (lettura PEC ogni 15 minuti):
-- aggiorna solo lo stato, senza riempire lo storico; gli errori finiscono sempre nello storico.
create or replace function public.registra_automazione(p_nome text, p_esito text, p_messaggio text default null, p_evento boolean default true)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.automazioni_stato as s (nome, ultimo_ok, ultimo_errore, errore, aggiornato)
  values (p_nome,
          case when p_esito = 'ok' then now() end,
          case when p_esito = 'errore' then now() end,
          case when p_esito = 'errore' then p_messaggio end,
          now())
  on conflict (nome) do update set
    ultimo_ok = coalesce(excluded.ultimo_ok, s.ultimo_ok),
    ultimo_errore = coalesce(excluded.ultimo_errore, s.ultimo_errore),
    errore = case when p_esito = 'errore' then p_messaggio else s.errore end,
    aggiornato = now();
  if p_evento or p_esito = 'errore' then
    insert into public.automazioni_eventi (nome, esito, messaggio) values (p_nome, p_esito, p_messaggio);
  end if;
end;
$$;

-- Fotografia per il controllo del mattino: stato di ogni automazione, errori delle ultime 24 ore,
-- job pianificati falliti nelle ultime 24 ore.
create or replace function public.controllo_automazioni_dati()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'adesso', now(),
    'stato', coalesce((select jsonb_agg(to_jsonb(s)) from public.automazioni_stato s), '[]'::jsonb),
    'errori', coalesce((select jsonb_agg(jsonb_build_object('nome', e.nome, 'quando', e.quando, 'messaggio', e.messaggio) order by e.quando)
                          from public.automazioni_eventi e
                         where e.esito = 'errore' and e.quando > now() - interval '24 hours'), '[]'::jsonb),
    'job_falliti', coalesce((select jsonb_agg(jsonb_build_object('job', j.jobname, 'quando', d.start_time, 'messaggio', left(d.return_message, 300)) order by d.start_time)
                               from cron.job_run_details d join cron.job j on j.jobid = d.jobid
                              where d.status <> 'succeeded' and d.start_time > now() - interval '24 hours'), '[]'::jsonb),
    'job_attivi', coalesce((select jsonb_agg(jsonb_build_object('job', j.jobname, 'attivo', j.active)) from cron.job j), '[]'::jsonb)
  );
$$;

revoke all on function public.registra_automazione(text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.controllo_automazioni_dati() from public, anon, authenticated;
grant execute on function public.registra_automazione(text, text, text, boolean) to service_role;
grant execute on function public.controllo_automazioni_dati() to service_role;

-- Chiavi dei job nella cassaforte (Vault): controllo del mattino e promemoria Questura.
select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'cron_controllo_automazioni',
  'Chiave del job controllo-automazioni (pg_cron -> funzione Edge)')
where not exists (select 1 from vault.secrets where name = 'cron_controllo_automazioni');
select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'cron_questura_promemoria',
  'Chiave del job questura-promemoria (pg_cron -> funzione Edge)')
where not exists (select 1 from vault.secrets where name = 'cron_questura_promemoria');
