// CERTIFICATI DI OSPITALITÀ: copia su Drive (decisioni di Massimo, 09/11/2026)
// I certificati li genera Approdo alle 15 del giorno prima dell'appuntamento in Questura (il venerdì per il lunedì)
// e li allega alla mail per l'operatore. Questo script, una volta al giorno tra le 16 e le 17, li copia nella
// cartella Giuridico dell'ospite con un nome fisso:
//   "Certificato di ospitalità - COGNOME Nome.pdf"
// Un solo file per ospite: al certificato successivo il contenuto viene sostituito (stesso file, stesso link).
// Il link torna nella scheda Approdo. Usa SEGRETO, chiamaUrl, indiceCartelle, trovaCartella (Codice.gs)
// e ABBINAMENTI_MANUALI (Cartelle.gs).

const CERT_URL = 'https://nvwqykhosumrjkdlejtb.supabase.co/functions/v1/certificati-ospitalita';
const CERT_TEMPO_MAX_MS = 5 * 60 * 1000;

function salvaCertificati() {
  const inizio = Date.now();
  const r = chiamaUrl(CERT_URL, { azione: 'da_salvare' });
  if (!r || r.status !== 'ok') { console.error('Certificati: elenco non disponibile ' + JSON.stringify(r)); return; }
  let fatti = 0, errori = 0;
  for (let i = 0; i < r.ospiti.length; i++) {
    if (Date.now() - inizio > CERT_TEMPO_MAX_MS) break; // i restanti si copiano al giro successivo
    const o = r.ospiti[i];
    try { salvaCertificato_(o); fatti++; }
    catch (e) {
      errori++;
      chiamaUrl(CERT_URL, { azione: 'registra', ospite_id: o.ospite_id, problema: 'copia su Drive: ' + String(e && e.message || e) });
    }
  }
  console.log('Certificati: ' + fatti + ' copiati su Drive, ' + errori + ' con problemi, su ' + r.ospiti.length + '.');
}

function salvaCertificato_(o) {
  const p = chiamaUrl(CERT_URL, { azione: 'pdf', ospite_id: o.ospite_id });
  if (!p || p.status !== 'ok') throw new Error('PDF non disponibile: ' + (p && p.errore || 'risposta vuota'));
  const blob = Utilities.newBlob(Utilities.base64Decode(p.pdfBase64), 'application/pdf', p.nomeFile);

  // 1) file già noto ad Approdo: si sostituisce il contenuto, il link resta lo stesso
  let file = null;
  if (o.drive_file_id) {
    try { file = DriveApp.getFileById(o.drive_file_id); if (file.isTrashed()) file = null; } catch (e) { file = null; }
  }
  // 2) altrimenti: cartella Giuridico dell'ospite (se c'è già un certificato con lo stesso nome si usa quello)
  if (!file) {
    if (!cartelle) cartelle = indiceCartelle();
    const cartella = cartellaOspite_(o);
    if (!cartella) throw new Error('cartella dell\'ospite non trovata su Drive ("' + o.cartella + '")');
    const sotto = cartella.getFoldersByName('Giuridico');
    const dest = sotto.hasNext() ? sotto.next() : cartella;
    const esistenti = dest.getFilesByName(p.nomeFile);
    file = esistenti.hasNext() ? esistenti.next() : null;
    if (!file) {
      file = dest.createFile(blob);
      registraCertificato_(o, p, file);
      return;
    }
  }
  sostituisciContenuto_(file.getId(), blob);
  if (file.getName() !== p.nomeFile) file.setName(p.nomeFile);
  registraCertificato_(o, p, file);
}

function registraCertificato_(o, p, file) {
  const r = chiamaUrl(CERT_URL, { azione: 'registra', ospite_id: o.ospite_id, generato_il: p.generato_il,
    drive_file_id: file.getId(), drive_url: file.getUrl() });
  if (!r || r.status !== 'ok') throw new Error('link non registrato in Approdo: ' + JSON.stringify(r));
}

// Stessa ricerca usata per le PEC; per i nomi scritti male vale l'abbinamento manuale di Cartelle.gs.
function cartellaOspite_(o) {
  const manuale = (typeof ABBINAMENTI_MANUALI !== 'undefined') ? ABBINAMENTI_MANUALI[o.cartella] : null;
  if (manuale) {
    const m = cartelle.filter(function (x) { return x.cartella.getName().toLowerCase() === manuale.toLowerCase(); })
      .sort(function (a, b) { return (a.presenti === b.presenti) ? 0 : (a.presenti ? -1 : 1); })[0];
    if (m) return m.cartella;
  }
  return trovaCartella(cartelle, o, '');
}

// Sostituisce il contenuto del file su Drive mantenendo lo stesso file (e lo stesso link).
function sostituisciContenuto_(id, blob) {
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media&supportsAllDrives=true', {
    method: 'patch', contentType: 'application/pdf', payload: blob.getBytes(),
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('aggiornamento del file su Drive non riuscito (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  }
}

// Da eseguire una volta sola, a mano: avvia la copia giornaliera (tra le 16 e le 17) e fa subito un primo giro.
function creaAttivatoreCertificati() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const f = t.getHandlerFunction();
    if (f === 'salvaCertificati' || f === 'aggiornaCertificati') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('salvaCertificati').timeBased().everyDays(1).atHour(16).nearMinute(15).inTimezone('Europe/Rome').create();
  salvaCertificati();
}
