-- Report decadale all'amministrazione: una riga per report (decade) e un diario di voci
-- compilato giorno per giorno. Il coordinatore approva da Approdo; l'invio avviene solo se approvato.

create table if not exists public.report_decadi (
  id                uuid primary key default gen_random_uuid(),
  numero            integer not null unique,
  periodo_inizio    date not null,
  periodo_fine      date not null,
  data_invio        date not null,
  stato             text not null default 'in_preparazione'
                    check (stato in ('in_preparazione','bozza_pronta','approvato','inviato')),
  valutazione       text,               -- sezione 7, scritta dal coordinatore
  note_coordinatore text,               -- indicazioni per chi prepara la bozza
  html_bozza        text,               -- sorgente HTML della bozza (per rigenerare il PDF con la valutazione)
  pdf_url           text,
  pdf_drive_id      text,
  destinatari       text[] not null default array['r.bernardi@coopmetis.com','i.mei@coopmetis.com'],
  approvato_il      timestamptz,
  approvato_da      text,
  inviato_il        timestamptz,
  mail_id           text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.report_diario (
  id            uuid primary key default gen_random_uuid(),
  decade_id     uuid references public.report_decadi(id) on delete cascade,
  data          date not null,
  struttura_id  uuid references public.strutture_cas(id),
  ambito        text not null default 'altro'
                check (ambito in ('manutenzione','proprieta','convivenza','organizzazione','occupazione','amministrativa','educativo','giuridico','altro')),
  testo         text not null,
  fonte         text,
  inserito_da   text default 'automatico',
  created_at    timestamptz not null default now()
);
create index if not exists report_diario_decade_idx on public.report_diario (decade_id, data);

alter table public.report_decadi enable row level security;
alter table public.report_diario enable row level security;

do $$
declare t text;
begin
  foreach t in array array['report_decadi','report_diario'] loop
    execute format('drop policy if exists coordinatore_tutto on public.%I', t);
    execute format($p$create policy coordinatore_tutto on public.%I for all to authenticated
      using (exists (select 1 from public.utenti u where lower(u.email) = lower(auth.jwt() ->> 'email') and u.ruolo = 'Coordinatore' and u.comunita_id is null))
      with check (exists (select 1 from public.utenti u where lower(u.email) = lower(auth.jwt() ->> 'email') and u.ruolo = 'Coordinatore' and u.comunita_id is null))$p$, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('drop trigger if exists registro_attivita_trg on public.%I', t);
    execute format('create trigger registro_attivita_trg after insert or update or delete on public.%I for each row execute function public.registra_modifica()', t);
  end loop;
end $$;
