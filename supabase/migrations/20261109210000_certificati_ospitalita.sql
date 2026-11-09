-- Certificati di ospitalità (decisioni di Massimo, 09/11/2026). Già applicata sul progetto con le migrazioni
-- certificati_ospitalita_sesso_cittadinanze, certificati_ospitalita, certificati_ospitalita_drive_salvato.

-- Sesso nella scheda ospite (serve per sig./sig.ra, nato/nata, ospitato/ospitata)
alter table public.ospiti_cas add column if not exists sesso text check (sesso in ('M','F'));

-- Cittadinanza al maschile e al femminile a partire dalla nazionalità (paese) della scheda
create table if not exists public.cittadinanze (
  paese text primary key,
  maschile text not null,
  femminile text not null
);
alter table public.cittadinanze enable row level security;
insert into public.cittadinanze (paese, maschile, femminile) values
 ('Bangladesh','bengalese','bengalese'), ('Ucraina','ucraino','ucraina'), ('Pakistan','pakistano','pakistana'),
 ('Camerun','camerunense','camerunense'), ('Costa d''Avorio','ivoriano','ivoriana'), ('Mali','maliano','maliana'),
 ('Marocco','marocchino','marocchina'), ('Guinea','guineano','guineana'), ('Egitto','egiziano','egiziana'),
 ('Guinea Bissau','guineense','guineense'), ('Nigeria','nigeriano','nigeriana'), ('Tunisia','tunisino','tunisina'),
 ('Somalia','somalo','somala'), ('Ghana','ghanese','ghanese')
on conflict (paese) do nothing;

-- Un certificato per ospite (l'ultimo): PDF nel bucket privato "certificati", copia su Drive con link
create table if not exists public.certificati_ospitalita (
  ospite_id uuid primary key references public.ospiti_cas(id) on delete cascade,
  appuntamento_id uuid,
  data_ora_appuntamento timestamptz,
  firma text,
  storage_path text,
  drive_file_id text,
  drive_url text,
  generato_il timestamptz,
  drive_salvato_il timestamptz,
  problema text,
  problema_il timestamptz,
  problema_firma text,
  aggiornato_il timestamptz not null default now()
);
alter table public.certificati_ospitalita enable row level security;
create policy certificati_lettura on public.certificati_ospitalita for select to authenticated
  using (exists (select 1 from public.ospiti_cas o where o.id = certificati_ospitalita.ospite_id));

insert into storage.buckets (id, name, public) values ('certificati', 'certificati', false) on conflict (id) do nothing;
-- Nel bucket: modello/carta_intestata.pdf, modello/timbro.png (caricati il 09/11/2026), pdf/<ospite_id>.pdf

-- Chiave vault per chiamare certificati-ospitalita da SQL: cron_certificati.
-- Mail delle 15 (accompagnamenti-domani): job pg_cron 2 spostato a '0 13,14 * * *' (la funzione parte solo alle 15 di Roma).
