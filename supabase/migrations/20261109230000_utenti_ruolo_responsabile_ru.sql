-- Ruolo "Responsabile RU" per Simona De Martino, responsabile risorse umane (Massimo, 09/11/2026).
-- Già applicata sul progetto (migrazione utenti_ruolo_responsabile_ru).
alter table public.utenti drop constraint utenti_ruolo_check;
alter table public.utenti add constraint utenti_ruolo_check check (ruolo = any (array['Coordinatore','Educatore','Amministratore','Tirocinante','Borsista','Volontario','SuperAdmin','Segreteria','Responsabile RU']));
update public.utenti set ruolo = 'Responsabile RU' where lower(email) = 's.demartino@coopmetis.com';
