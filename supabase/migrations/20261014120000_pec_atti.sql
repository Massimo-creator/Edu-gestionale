-- Atti arrivati via PEC (decreti, convocazioni, revoche, cessazioni), uno per riga.
-- Scrive solo la funzione pec-archivio (service role); in Approdo si legge e basta.

create table public.pec_atti (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ospite_id uuid references public.ospiti_cas(id) on delete set null, -- vuoto per le righe da verificare
  struttura_id uuid references public.strutture_cas(id) on delete set null,
  tipo_atto text not null check (tipo_atto in ('decreto_commissione', 'convocazione', 'revoca', 'cessazione')),
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

-- Niente doppioni: stesso RN + tipo + data della PEC (quando l'RN c'è), oppure stesso documento.
create unique index pec_atti_unico_rn on public.pec_atti (rn, tipo_atto, data_pec) where rn is not null and rn <> '';
create unique index pec_atti_unico_documento on public.pec_atti (link_documento) where link_documento is not null and link_documento <> '';

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
