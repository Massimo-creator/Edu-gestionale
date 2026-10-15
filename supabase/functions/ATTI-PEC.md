# Atti PEC: stato dei lavori

Aggiornato al 15/10/2026.

## Cosa è in produzione

- **pec-archivio** (Supabase v12): come prima, più la registrazione di ogni atto in `pec_atti`
  e gli annullamenti di convocazione come tipo a sé (avviso solo a Massimo, nessun appuntamento toccato).
  Un errore su `pec_atti` va solo nel log: mail e appuntamenti non si fermano.
- **pec-imap** (Supabase v23): invariata, tranne il controllo della chiave.
- **Chiave condivisa**: solo nel segreto `PEC_SECRET` di Supabase e nelle Proprietà dello script
  Apps Script "Archivio PEC" (proprietà `PEC_SECRET`). La chiave vecchia (0281edf3…) non è più valida.
- **Tabella `pec_atti`**: migrazione `supabase/migrations/20261014120000_pec_atti.sql`.
  Doppione = stesso PDF (stesso link); per le righe senza PDF, stessi RN + tipo + data PEC.
  Lettura con le stesse regole di `ospiti_cas`; scrive solo la funzione.

- Correzioni del 15/10: lettura delle convocazioni di Forlì (senza virgola prima di "per un colloquio");
  gli avvisi di Approdo ("Approdo: ...") non vengono più presi per PEC (prima ne nasceva uno ogni 15 minuti).
- **Storico importato**: 85 righe dal foglio "Archivio PEC storiche", `origine = 'storico'`, tutte abbinate
  all'ospite con la logica di "abbina" (85/85, nessun caso incerto). Il 15/10 completato leggendo i PDF
  (pec-imap `storico_pec` + pec-archivio `elabora` con dryRun, nessuna mail): 39 decreti con la decisione
  (31 anche con la procedura; i decreti più vecchi non la riportano), 40 convocazioni con data e ora
  dell'audizione (2 collegate all'appuntamento già esistente). Restano senza dati le 3 revoche, i 2 annullamenti
  e la convocazione senza PDF (UID 2987).

## Come tornare indietro

1. **Solo la registrazione degli atti**: ripubblicare pec-archivio dal commit `ee8b2e8`
   (logica della v5 con il nuovo controllo della chiave). Restano le mail e gli appuntamenti di prima;
   `pec_atti` resta com'è e semplicemente non riceve righe nuove.
2. **La v5 originale così com'era** non va rimessa: accettava la chiave vecchia scritta nel codice.
3. **Togliere solo lo storico**: `delete from public.pec_atti where origine = 'storico';`
4. **Togliere la tabella** (solo se serve davvero, perde le righe): `drop table public.pec_atti;`

## Da fare

- Pubblicare su pec-archivio la correzione di `leggiDecreto` (si ferma prima di intestazione, firma e
  traduzioni della decisione): è nel ramo, non ancora in produzione.
- Pubblicare l'interfaccia (sezione "Atti PEC" nella scheda ospite e link alla convocazione nell'appuntamento
  di Commissione): è in `index.html` nel ramo, non ancora in produzione.
- Togliere la tabella d'appoggio dal SQL Editor: `drop schema importazioni cascade;`
- Le altre funzioni hanno ancora chiavi scritte nel codice (questura-sync, questura-promemoria,
  accompagnamenti-domani, chiave Resend in send-email): vanno spostate nei segreti come fatto qui.
