-- Ruolo "Amministrazione" (sola lettura in Approdo), 17/11/2026
alter table utenti drop constraint utenti_ruolo_check;
alter table utenti add constraint utenti_ruolo_check check (ruolo = any (array['Coordinatore','Educatore','Amministratore','Amministrazione','Tirocinante','Borsista','Volontario','SuperAdmin','Segreteria','Responsabile RU']));
