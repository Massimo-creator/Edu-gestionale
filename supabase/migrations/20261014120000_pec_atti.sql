-- Atti arrivati via PEC (decreti, convocazioni, revoche, cessazioni), uno per riga.
-- Scrive solo la funzione pec-archivio (service role); in Approdo si legge e basta.

create table public.pec_atti (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ospite_id uuid references public.ospiti_cas(id) on delete set null, -- vuoto per le righe da verificare
  struttura_id uuid references public.strutture_cas(id) on delete set null,
  tipo_atto text not null check (tipo_atto in ('decreto_commissione', 'convocazione', 'annullamento', 'revoca', 'cessazione')),
  rn text,
  data_pec date,
  oggetto_pec text,
  link_documento text, -- link Drive del PDF
  decisione text, -- decreti: testo dopo "DECIDE"
  procedura text,
  data_audizione date, -- convocazioni
  ora_audizione time,
  appuntamento_id uuid references public.appuntamenti_cas(id) on delete set null,
  stato text not null default 'archiviata' check (stato in ('archiviata', 'da_verificare')),
  motivo text check (motivo in ('non_trovato', 'ambiguo', 'cartella_mancante', 'senza_pdf')),
  origine text not null default 'automatica' check (origine in ('automatica', 'storico'))
);

comment on table public.pec_atti is 'Atti arrivati via PEC. Scrittura solo da pec-archivio (service role).';

-- Niente doppioni (decisione di Massimo, 14/10/2026): è un doppione solo lo stesso PDF.
-- Due PDF diversi con lo stesso RN nello stesso giorno si registrano tutti e due.
-- Per le righe senza documento (da verificare, annullamenti senza PDF) vale RN + tipo + data della PEC.
create unique index pec_atti_unico_documento on public.pec_atti (link_documento) where link_documento is not null and link_documento <> '';
create unique index pec_atti_unico_senza_documento on public.pec_atti (rn, tipo_atto, data_pec)
  where (link_documento is null or link_documento = '') and rn is not null and rn <> '';

create index pec_atti_ospite on public.pec_atti (ospite_id, data_pec desc);
create index pec_atti_appuntamento on public.pec_atti (appuntamento_id) where appuntamento_id is not null;

-- Permessi. Chi vede un ospite ne vede gli atti: il controllo passa da ospiti_cas, quindi valgono
-- esattamente le sue regole (coordinatori e operatori CAS tutto, educatori le loro strutture).
-- Le righe senza ospite (da verificare) le vede solo il coordinatore.
alter table public.pec_atti enable row level security;

revoke all on public.pec_atti from anon;
revoke insert, update, delete, truncate, references, trigger on public.pec_atti from authenticated;
grant select on public.pec_atti to authenticated;

create policy pec_atti_lettura on public.pec_atti
  for select to authenticated
  using (
    (ospite_id is not null and exists (select 1 from public.ospiti_cas o where o.id = pec_atti.ospite_id))
    or (ospite_id is null and exists (
      select 1 from public.utenti u
      where u.email = (auth.jwt() ->> 'email') and u.ruolo = 'Coordinatore' and u.comunita_id is null
    ))
  );
