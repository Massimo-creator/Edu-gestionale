-- Appuntamenti con orario non ancora noto.
-- Quando ora_da_definire è true, data_ora è un segnaposto alle 12:00 di Roma (il giorno resta
-- lo stesso in ogni fuso) e non va mai mostrato come orario: interfaccia, promemoria delle 18,
-- promemoria Questura e sincronizzazione dal file di Parfait scrivono "ora da definire".
alter table public.appuntamenti_cas add column if not exists ora_da_definire boolean not null default false;
comment on column public.appuntamenti_cas.ora_da_definire is 'true se l''orario non è ancora noto: data_ora è un segnaposto alle 12:00 di Roma e non va mostrato come orario';
