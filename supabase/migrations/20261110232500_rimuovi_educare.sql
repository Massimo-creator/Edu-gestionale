-- Rimozione del vecchio EduCare (richiesta di Massimo, 10/11/2026). Già applicata sul progetto.
-- Dati esportati prima in JSON (educare_export_2026-11-10.json); codice conservato nel ramo educare-archivio.
drop table if exists public.messaggi, public.acquisti, public.attivita, public.diario, public.equipe, public.eventi, public.mansioni, public.menu, public.minori, public.note, public.operatori, public.pei, public.relazioni, public.tasks, public.turni;
delete from public.utenti where comunita_id is not null;
alter table public.utenti drop constraint if exists utenti_comunita_id_fkey;
drop table if exists public.comunita;
