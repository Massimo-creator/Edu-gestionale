-- Atti del Tribunale (es. decreto di fissazione udienza sul ricorso) nella sezione atti della scheda ospite.
-- Arrivano di solito agli avvocati e vengono inoltrati per mail, non dalla PEC della Commissione:
-- per questo si aggiunge anche l'origine 'manuale' (atto registrato a mano, non dall'archivio PEC).
-- Per decreto_tribunale: data_audizione/ora_audizione = data e ora dell'udienza; decisione = oggetto del decreto.
alter table public.pec_atti drop constraint if exists pec_atti_tipo_atto_check;
alter table public.pec_atti add constraint pec_atti_tipo_atto_check
  check (tipo_atto in ('decreto_commissione', 'decreto_tribunale', 'convocazione', 'annullamento', 'revoca', 'cessazione'));

alter table public.pec_atti drop constraint if exists pec_atti_origine_check;
alter table public.pec_atti add constraint pec_atti_origine_check
  check (origine in ('automatica', 'storico', 'manuale'));
