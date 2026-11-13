-- Pubblicazione dei turni (13/11/2026).
-- Simona e il coordinatore lavorano sui turni di un mese in "bozza"; gli educatori vedono il mese
-- solo dopo che Simona (o il coordinatore) clicca "Pubblica". Le modifiche fatte dopo la pubblicazione
-- sono visibili subito. Un mese può essere ritirato (torna in bozza).
-- Un mese senza riga in questa tabella è considerato in bozza.
-- Lettura: tutti gli utenti autenticati (è solo lo stato del mese, nessun dato personale). Scrittura: Simona e coordinatore.

create table if not exists public.turni_pubblicazioni (
  anno int not null,
  mese int not null check (mese between 1 and 12),
  pubblicato boolean not null default false,
  pubblicato_il timestamptz,
  pubblicato_da_email text,
  pubblicato_da_nome text,
  aggiornato_il timestamptz not null default now(),
  primary key (anno, mese)
);

alter table public.turni_pubblicazioni enable row level security;

create or replace function public.puo_pubblicare_turni()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.email_corrente() in ('s.demartino@coopmetis.com', 'm.andreoni@coopmetis.com')
      or exists (select 1 from utenti u where lower(u.email) = public.email_corrente() and u.ruolo = 'Coordinatore')
$$;

drop policy if exists turni_pubblicazioni_lettura on public.turni_pubblicazioni;
create policy turni_pubblicazioni_lettura on public.turni_pubblicazioni
  for select to authenticated using (true);

drop policy if exists turni_pubblicazioni_scrittura on public.turni_pubblicazioni;
create policy turni_pubblicazioni_scrittura on public.turni_pubblicazioni
  for all to authenticated using (public.puo_pubblicare_turni()) with check (public.puo_pubblicare_turni());

-- Mesi già in uso fino a novembre 2026: pubblicati, così agli educatori non sparisce niente.
insert into public.turni_pubblicazioni (anno, mese, pubblicato, pubblicato_il, pubblicato_da_nome)
select distinct extract(year from data)::int, extract(month from data)::int, true, now(), 'Pubblicazione iniziale'
from public.turni_cas
where data < date '2026-12-01'
on conflict (anno, mese) do nothing;

-- Dicembre 2026: in bozza (Simona ci sta lavorando).
insert into public.turni_pubblicazioni (anno, mese, pubblicato)
values (2026, 12, false)
on conflict (anno, mese) do nothing;
