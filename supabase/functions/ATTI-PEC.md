# Atti PEC: stato dei lavori

Aggiornato al 15/10/2026.

## Cosa è in produzione

- **pec-archivio** (Supabase v13): come prima, più la registrazione di ogni atto in `pec_atti`
  e gli annullamenti di convocazione come tipo a sé (avviso solo a Massimo, nessun appuntamento toccato).
  Un errore su `pec_atti` va solo nel log: mail e appuntamenti non si fermano.
- **pec-imap** (Supabase v23): invariata, tranne il controllo della chiave.
- **Chiave condivisa**: solo nel segreto `PEC_SECRET` di Supabase e nelle Proprietà dello script
  Apps Script "Archivio PEC" (proprietà `PEC_SECRET`). La chiave vecchia (0281edf3…) non è più valida.
- **Tabella `pec_atti`**: migrazione `supabase/migrations/20261014120000_pec_atti.sql`.
  Doppione = stesso PDF (stesso link); per le righe senza PDF, stessi RN + tipo + data PEC.
  Lettura con le stesse regole di `ospiti_cas`; scrive solo la funzione.

- **v13 (15/10)**: la decisione dei decreti si ferma prima di intestazione, firma e traduzioni.
- **Interfaccia (15/10, su main)**: sezione "Atti PEC" nella scheda ospite e link alla convocazione
  nell'appuntamento di Commissione.
- Correzioni del 15/10: lettura delle convocazioni di Forlì (senza virgola prima di "per un colloquio");
  gli avvisi di Approdo ("Approdo: ...") non vengono più presi per PEC (prima ne nasceva uno ogni 15 minuti).
- **Storico importato**: 85 righe dal foglio "Archivio PEC storiche", `origine = 'storico'`, tutte abbinate
  all'ospite con la logica di "abbina" (85/85, nessun caso incerto). Il 15/10 completato leggendo i PDF
  (pec-imap `storico_pec` + pec-archivio `elabora` con dryRun, nessuna mail): 39 decreti con la decisione
  (31 anche con la procedura; i decreti più vecchi non la riportano), 40 convocazioni con data e ora
  dell'audizione (2 collegate all'appuntamento già esistente). Restano senza dati le 3 revoche, i 2 annullamenti
  e la convocazione senza PDF (UID 2987). Convocazioni collegate agli appuntamenti di Commissione: 31 su 40 con data.
  19 avevano già l'appuntamento (stesso ospite, stesso giorno); per Mia Md Rakib e Talukda Dulal l'appuntamento
  esisteva con data 01/01/2000 ed è stato riportato al 17/09/2026; 10 appuntamenti "Svolto" sono stati creati il 15/10
  su conferma di Massimo (nota "[pec-archivio]"): per chi aveva più convocazioni solo l'ultima, le precedenti
  (9, rinviate) restano senza appuntamento. La Commissione di Camara Boubacar con data 01/01/2000
  è stata tolta: quella valida è l'11/11/2026 (nessuna PEC sua nell'archivio).

## Come tornare indietro

1. **Solo la registrazione degli atti**: ripubblicare pec-archivio dal commit `ee8b2e8`
   (logica della v5 con il nuovo controllo della chiave). Restano le mail e gli appuntamenti di prima;
   `pec_atti` resta com'è e semplicemente non riceve righe nuove.
2. **La v5 originale così com'era** non va rimessa: accettava la chiave vecchia scritta nel codice.
3. **Togliere solo lo storico**: `delete from public.pec_atti where origine = 'storico';`
4. **Togliere la tabella** (solo se serve davvero, perde le righe): `drop table public.pec_atti;`

## Da fare

- Le altre funzioni hanno ancora chiavi scritte nel codice (questura-sync, questura-promemoria,
  accompagnamenti-domani, chiave Resend in send-email): vanno spostate nei segreti come fatto qui.
