-- Stato "sospeso" per il report decadale (richiesta di Massimo, 10/11/2026): il report non parte finché non viene riapprovato.
alter table public.report_decadi drop constraint report_decadi_stato_check;
alter table public.report_decadi add constraint report_decadi_stato_check check (stato = any (array['in_preparazione','bozza_pronta','sospeso','approvato','inviato']));
