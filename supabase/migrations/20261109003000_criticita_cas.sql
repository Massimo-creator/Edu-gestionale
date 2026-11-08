-- Registro delle criticità delle strutture CAS, seguite di report in report
-- (report decadale all'amministrazione). Ogni criticità ha una storia di aggiornamenti.

create table if not exists public.criticita_cas (
  id                 uuid primary key default gen_random_uuid(),
  struttura_id       uuid references public.strutture_cas(id),
  ambito             text not null default 'altro'
                     check (ambito in ('manutenzione','proprieta','convivenza','organizzazione','occupazione','amministrativa','altro')),
  titolo             text not null,
  descrizione        text,
  origine            text check (origine in ('mail','segnalazione','riunione','coordinatore','approdo')),
  fonte_rif          text,          -- riferimento alla fonte (es. id conversazione mail, id segnalazione)
  responsabile       text,
  stato              text not null default 'aperta'
                     check (stato in ('aperta','in_corso','in_attesa','risolta','archiviata')),
  aperta_il          date not null default current_date,
  ultimo_agg         date,
  chiusa_il          date,
  aggiornamenti      jsonb not null default '[]'::jsonb,  -- [{ "data": "YYYY-MM-DD", "testo": "...", "fonte": "..." }]
  riservata          boolean not null default false,       -- true: resta fuori dal report all'amministrazione
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists criticita_cas_stato_idx on public.criticita_cas (stato, struttura_id);

alter table public.criticita_cas enable row level security;

drop policy if exists coordinatore_tutto on public.criticita_cas;
create policy coordinatore_tutto on public.criticita_cas
  for all to authenticated
  using (exists (select 1 from public.utenti u where lower(u.email) = lower(auth.jwt() ->> 'email')
                 and u.ruolo = 'Coordinatore' and u.comunita_id is null))
  with check (exists (select 1 from public.utenti u where lower(u.email) = lower(auth.jwt() ->> 'email')
                 and u.ruolo = 'Coordinatore' and u.comunita_id is null));

revoke all on public.criticita_cas from anon;

drop trigger if exists registro_attivita_trg on public.criticita_cas;
create trigger registro_attivita_trg after insert or update or delete on public.criticita_cas
  for each row execute function public.registra_modifica();
