// Logica pura della sincronizzazione Questura: abbinamento all'ospite e scelta
// dell'appuntamento da aggiornare. Nessun accesso al database: si può provare da sola.

export const PREFISSO_MARKER = "[sync:questura-sheet:";

export type Ospite = {
  id: string;
  nome: string | null;
  cognome: string | null;
  data_nascita: string | null; // YYYY-MM-DD
  struttura_id: string | null;
  attivo: boolean | null;
};

export type Appuntamento = {
  id: string;
  ospite_id: string | null;
  stato: string;
  data_ora: string; // ISO
  titolo: string | null;
  note: string | null;
  struttura_id: string | null;
};

export type Riga = {
  cognome: string;
  nome: string;
  dataNascita: string; // testo grezzo della cella, anche con alias
  dataRinnovo: string; // YYYY-MM-DD oppure ""
  ora: string; // HH:MM oppure ""
  dataPrecedente: string; // YYYY-MM-DD oppure ""
  oraPrecedente: string; // HH:MM oppure ""
  oraCorretta: boolean; // true se lo script manda già l'ora giusta (vedi sotto)
  telefono: string;
  noteRiga: string;
};

// ---------- nomi ----------

// Stessa normalizzazione della vecchia funzione: serve a mantenere i marcatori già scritti.
export function normalizza(s: unknown): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function chiaveRiga(cognome: unknown, nome: unknown): string {
  return `${normalizza(cognome)}|${normalizza(nome)}`;
}

export function markerRiga(cognome: unknown, nome: unknown): string {
  return `${PREFISSO_MARKER}${chiaveRiga(cognome, nome)}]`;
}

function senzaAccenti(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function spezza(t: string): string[] {
  return t.replace(/\balias\b/g, " ").split(/[^a-z]+/).filter((x) => x.length > 0);
}

function unici(a: string[]): string[] {
  return [...new Set(a)];
}

// Le parole tra parentesi (alias) sono varianti facoltative, non obbligatorie.
export function parole(s: unknown): { principali: string[]; alias: string[] } {
  const testo = senzaAccenti(String(s ?? ""));
  const alias: string[] = [];
  const fuori = testo.replace(/\(([^)]*)\)/g, (_m, dentro: string) => {
    alias.push(...spezza(dentro));
    return " ";
  });
  return { principali: unici(spezza(fuori)), alias: unici(alias) };
}

function distanza(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

// Parole uguali, oppure quasi uguali (un carattere di differenza) se lunghe almeno 4 lettere.
export function paroleUguali(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && distanza(a, b) <= 1;
}

function contiene(insieme: string[], p: string): boolean {
  return insieme.some((x) => paroleUguali(x, p));
}

export function confrontaNomi(
  riga: { cognome: string; nome: string },
  o: { cognome: string | null; nome: string | null },
): { compatibile: boolean; condivise: number; condiviseLunghe: number } {
  const c = parole(riga.cognome);
  const n = parole(riga.nome);
  const principaliFile = unici([...c.principali, ...n.principali]);
  const tuttiFile = unici([...principaliFile, ...c.alias, ...n.alias]);
  const d = parole(`${o.cognome ?? ""} ${o.nome ?? ""}`);
  const tuttiDb = unici([...d.principali, ...d.alias]);

  const trovate = principaliFile.filter((p) => contiene(tuttiDb, p));
  const fileInDb = principaliFile.length > 0 && trovate.length === principaliFile.length;
  const dbInFile = d.principali.length > 0 && d.principali.every((p) => contiene(tuttiFile, p));
  const minimo = Math.min(2, principaliFile.length, d.principali.length);
  return {
    compatibile: (fileInDb || dbInFile) && trovate.length >= minimo && trovate.length > 0,
    condivise: trovate.length,
    condiviseLunghe: trovate.filter((p) => p.length >= 4).length,
  };
}

// Ospiti con il nome più simile a quello scritto nel file, da proporre nell'avviso
// quando il nome non viene riconosciuto. Si preferiscono gli ospiti attivi.
export function suggerisci(riga: { cognome: string; nome: string }, ospiti: Ospite[], max = 3): Ospite[] {
  const file = unici([...parole(riga.cognome).principali, ...parole(riga.nome).principali]);
  if (file.length === 0) return [];
  const lunghezzaFile = file.reduce((t, w) => t + w.length, 0);
  // Distanza nei due sensi: ogni parola del file cerca la più vicina in Approdo e viceversa,
  // così un nome con parole in più o in meno non risulta "simile" per una sola parola in comune.
  const punteggi = ospiti
    .map((o) => {
      const db = parole(`${o.cognome ?? ""} ${o.nome ?? ""}`).principali;
      if (db.length === 0) return { o, s: 1 };
      const andata = file.reduce((t, w) => t + Math.min(...db.map((d) => distanza(w, d))), 0);
      const ritorno = db.reduce((t, d) => t + Math.min(...file.map((w) => distanza(w, d))), 0);
      const lunghezza = lunghezzaFile + db.reduce((t, w) => t + w.length, 0);
      return { o, s: (andata + ritorno) / lunghezza };
    })
    .filter((x) => x.s <= 0.35);
  const attivi = punteggi.filter((x) => x.o.attivo !== false);
  const scelti = attivi.length > 0 ? attivi : punteggi;
  scelti.sort((a, b) => a.s - b.s);
  return scelti.slice(0, max).map((x) => x.o);
}

// ---------- date di nascita ----------

// Estrae tutte le date valide da una cella (anche "30-01-2002 (alias 01/05/2005)").
// Le date malformate ("15/101995", "0/1/1900") vengono ignorate.
export function dateNascita(grezzo: unknown, annoMax = new Date().getFullYear()): string[] {
  const s = String(grezzo ?? "");
  const out: string[] = [];
  const aggiungi = (a: string, m: string, g: string) => {
    const anno = Number(a), mese = Number(m), giorno = Number(g);
    if (anno < 1930 || anno > annoMax || mese < 1 || mese > 12 || giorno < 1 || giorno > 31) return;
    const t = new Date(Date.UTC(anno, mese - 1, giorno));
    if (t.getUTCFullYear() !== anno || t.getUTCMonth() !== mese - 1 || t.getUTCDate() !== giorno) return;
    out.push(`${String(anno).padStart(4, "0")}-${String(mese).padStart(2, "0")}-${String(giorno).padStart(2, "0")}`);
  };
  for (const x of s.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) aggiungi(x[1], x[2], x[3]);
  for (const x of s.matchAll(/(?<!\d)(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?!\d)/g)) aggiungi(x[3], x[2], x[1]);
  return unici(out);
}

// ---------- abbinamento all'ospite ----------

export type Esito =
  | { tipo: "collegato"; ospite: Ospite; criterio: "data_nascita+nome" | "solo_nome" }
  | { tipo: "da_verificare"; motivo: "non_trovato" | "omonimi" | "data_nascita_diversa"; dettaglio: string };

export function abbina(riga: Riga, ospiti: Ospite[]): Esito {
  const nascite = dateNascita(riga.dataNascita);
  const confronti = ospiti.map((o) => ({ o, ...confrontaNomi(riga, o) }));

  // 1) data di nascita coincidente + nome in comune.
  //    Il 1 gennaio è spesso una data segnaposto: in quel caso serve il nome compatibile per intero.
  if (nascite.length > 0) {
    const perData = confronti.filter((c) => {
      if (!c.o.data_nascita || !nascite.includes(c.o.data_nascita)) return false;
      const debole = c.o.data_nascita.endsWith("-01-01");
      return debole ? c.compatibile : c.condiviseLunghe >= 1;
    });
    if (perData.length === 1) return { tipo: "collegato", ospite: perData[0].o, criterio: "data_nascita+nome" };
    if (perData.length > 1) {
      const max = Math.max(...perData.map((c) => c.condivise));
      const migliori = perData.filter((c) => c.condivise === max);
      if (migliori.length === 1) return { tipo: "collegato", ospite: migliori[0].o, criterio: "data_nascita+nome" };
      return { tipo: "da_verificare", motivo: "omonimi", dettaglio: `${migliori.length} ospiti con stessa data di nascita e nome simile` };
    }
  }

  // 2) solo nome (compatibile per intero)
  let perNome = confronti.filter((c) => c.compatibile);
  if (perNome.length > 1) {
    const attivi = perNome.filter((c) => c.o.attivo !== false);
    if (attivi.length === 1) perNome = attivi;
  }
  if (perNome.length === 0) {
    return { tipo: "da_verificare", motivo: "non_trovato", dettaglio: "nessun ospite con questo nome in Approdo" };
  }
  if (perNome.length > 1) {
    return { tipo: "da_verificare", motivo: "omonimi", dettaglio: `${perNome.length} ospiti con questo nome in Approdo` };
  }
  const unico = perNome[0].o;
  if (nascite.length > 0 && unico.data_nascita && !nascite.includes(unico.data_nascita)) {
    return {
      tipo: "da_verificare",
      motivo: "data_nascita_diversa",
      dettaglio: `data di nascita nel file ${nascite.join(" / ")}, in Approdo ${unico.data_nascita}`,
    };
  }
  return { tipo: "collegato", ospite: unico, criterio: "solo_nome" };
}

// ---------- scelta dell'appuntamento da aggiornare ----------

const fmtRoma = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" });

export function dataLocale(iso: string): string {
  return fmtRoma.format(new Date(iso));
}

export function oggiRoma(adesso: Date = new Date()): string {
  return fmtRoma.format(adesso);
}

function haMarkerSync(a: Appuntamento): boolean {
  return (a.note ?? "").includes(PREFISSO_MARKER);
}

export type Trovato =
  | { tipo: "esistente"; app: Appuntamento; via: "marker" | "data_precedente" | "unico_aperto" }
  | { tipo: "nessuno" }
  | { tipo: "conflitto"; motivo: string };

export function trovaDaAggiornare(p: {
  marker: string;
  conMarker: Appuntamento[];
  delOspite: Appuntamento[];
  dataPrecedente: string;
  oggi: string;
}): Trovato {
  const { marker, conMarker, delOspite, dataPrecedente, oggi } = p;

  // a) un appuntamento aperto già collegato a questa riga del file
  const apertiMarker = conMarker.filter((a) => a.stato === "Da svolgere");
  if (apertiMarker.length > 0) {
    const perData = dataPrecedente ? apertiMarker.filter((a) => dataLocale(a.data_ora) === dataPrecedente) : [];
    const scelto = perData.length > 0
      ? perData[0]
      : [...apertiMarker].sort((x, y) => y.data_ora.localeCompare(x.data_ora))[0];
    return { tipo: "esistente", app: scelto, via: "marker" };
  }

  // b) un appuntamento aperto dello stesso ospite, senza marcatore di un'altra riga
  const adottabili = delOspite.filter((a) => {
    if (a.stato !== "Da svolgere") return false;
    if (haMarkerSync(a) && !(a.note ?? "").includes(marker)) return false;
    return true;
  });

  if (dataPrecedente) {
    const perData = adottabili.filter((a) => dataLocale(a.data_ora) === dataPrecedente);
    if (perData.length === 1) {
      // se la data precedente è già passata è storico: si lascia e si crea il nuovo
      return dataPrecedente < oggi ? { tipo: "nessuno" } : { tipo: "esistente", app: perData[0], via: "data_precedente" };
    }
    if (perData.length > 1) {
      return { tipo: "conflitto", motivo: `più appuntamenti aperti dello stesso ospite il ${dataPrecedente}` };
    }
  }

  const futuri = adottabili.filter((a) => dataLocale(a.data_ora) >= oggi);
  if (futuri.length === 1) return { tipo: "esistente", app: futuri[0], via: "unico_aperto" };
  if (futuri.length > 1) return { tipo: "conflitto", motivo: `${futuri.length} appuntamenti aperti per lo stesso ospite, non so quale sostituire` };
  return { tipo: "nessuno" };
}

// ---------- ore ----------

// Lo script attuale legge le ore con il fuso sbagliato e le manda con 9 ore in più
// (9:00 arriva come 18:00, 14:15 come 23:15; le celle scritte come testo arrivano vuote).
// Qui si toglie lo scarto, a meno che lo script dichiari di mandare l'ora già giusta (oraCorretta: true).
export const SCARTO_ORE_SCRIPT = 9;

function oraValida(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

export function spostaOra(hhmm: string, ore: number): string {
  const v = oraValida(hhmm);
  if (!v) return "";
  const totale = (((Number(v.slice(0, 2)) + ore) % 24) + 24) % 24;
  return `${String(totale).padStart(2, "0")}:${v.slice(3)}`;
}

// Ora vera (ora di Roma) della riga, oppure "" se manca o non è leggibile.
export function oraVera(riga: Riga): string {
  if (riga.ora === "") return "";
  return riga.oraCorretta ? oraValida(riga.ora) : spostaOra(riga.ora, -SCARTO_ORE_SCRIPT);
}

const fmtRomaCompleto = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function anticipoRomaMinuti(ts: number): number {
  const parti = fmtRomaCompleto.formatToParts(new Date(ts));
  const v = (t: string) => Number(parti.find((x) => x.type === t)!.value);
  const comeUtc = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
  return Math.round((comeUtc - ts) / 60000);
}

// Data e ora di Roma (ora legale compresa) -> istante UTC in formato ISO.
export function romaInUtc(data: string, hhmm: string): string {
  const [a, m, g] = data.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const nominale = Date.UTC(a, m - 1, g, h, mi);
  let ts = nominale;
  for (let i = 0; i < 3; i++) ts = nominale - anticipoRomaMinuti(ts) * 60000;
  return new Date(ts).toISOString();
}

// Ora di Roma (HH:MM) di un istante salvato in Approdo.
export function oraLocale(iso: string): string {
  const parti = fmtRomaCompleto.formatToParts(new Date(iso));
  const v = (t: string) => parti.find((x) => x.type === t)!.value;
  return `${v("hour")}:${v("minute")}`;
}

// Se l'ora è vuota o non è cambiata dall'ultimo controllo, in aggiornamento resta l'ora già presente in Approdo.
// Senza ora, un appuntamento nuovo parte dalle 09:00 (ora di Roma).
export function calcolaDataOra(riga: Riga, esistente?: Appuntamento): string {
  const vera = oraVera(riga);
  const invariata = riga.ora !== "" && riga.ora === riga.oraPrecedente;
  if (esistente && (vera === "" || invariata)) {
    return romaInUtc(riga.dataRinnovo, oraLocale(esistente.data_ora));
  }
  return romaInUtc(riga.dataRinnovo, vera || "09:00");
}

const TRATTO = "—";

export type Piano =
  | { azione: "creato"; inserisci: Record<string, unknown>; daVerificare: boolean; dettaglio: string }
  | { azione: "aggiornato"; id: string; modifica: Record<string, unknown>; dettaglio: string }
  | { azione: "eliminato"; id: string; dettaglio: string }
  | { azione: "nessuna_modifica"; dettaglio: string }
  | { azione: "non_riconosciuto"; dettaglio: string }
  | { azione: "conflitto"; dettaglio: string };

export function costruisciPiano(p: {
  riga: Riga;
  abbinamento: Esito;
  conMarker: Appuntamento[];
  delOspite: Appuntamento[];
  oggi: string;
}): Piano {
  const { riga, abbinamento, conMarker, delOspite, oggi } = p;
  const marker = markerRiga(riga.cognome, riga.nome);
  const nomeCompleto = `${riga.nome.trim()} ${riga.cognome.trim()}`.trim();

  // Regola decisa da Massimo: se il nome del file non porta a un solo ospite di Approdo
  // non si scrive nulla, si avvisa e basta. Quando il nome viene corretto nel file la riga
  // viene rimandata e l'appuntamento entra in Approdo collegato all'ospite giusto.
  if (abbinamento.tipo === "da_verificare") {
    if (!riga.dataRinnovo) {
      return { azione: "nessuna_modifica", dettaglio: "data svuotata per un nome non riconosciuto: nulla da fare" };
    }
    return { azione: "non_riconosciuto", dettaglio: abbinamento.dettaglio };
  }

  const trovato = trovaDaAggiornare({ marker, conMarker, delOspite, dataPrecedente: riga.dataPrecedente, oggi });

  if (trovato.tipo === "conflitto") {
    return { azione: "conflitto", dettaglio: `${trovato.motivo}: non ho scritto nulla` };
  }

  // Data svuotata: si elimina solo un appuntamento ancora aperto e futuro.
  if (!riga.dataRinnovo) {
    if (trovato.tipo === "esistente" && dataLocale(trovato.app.data_ora) >= oggi) {
      return { azione: "eliminato", id: trovato.app.id, dettaglio: `eliminato l'appuntamento del ${dataLocale(trovato.app.data_ora)}` };
    }
    return { azione: "nessuna_modifica", dettaglio: "data svuotata, nessun appuntamento aperto da eliminare" };
  }

  const ospite = abbinamento.ospite;
  const noteBase = [riga.noteRiga, riga.telefono ? `Tel: ${riga.telefono}` : ""].filter(Boolean);

  if (trovato.tipo === "esistente") {
    const a = trovato.app;
    const nuova = calcolaDataOra(riga, a);
    const modifica: Record<string, unknown> = {};
    const note: string[] = [];

    if (new Date(nuova).getTime() !== new Date(a.data_ora).getTime()) modifica.data_ora = nuova;

    if (!a.ospite_id) {
      modifica.ospite_id = ospite.id;
      if (!a.struttura_id) modifica.struttura_id = ospite.struttura_id;
      if ((a.titolo ?? "").includes("DA VERIFICARE")) modifica.titolo = `Questura ${TRATTO} ${nomeCompleto}`;
    } else if (a.ospite_id !== ospite.id) {
      note.push("attenzione: l'appuntamento è collegato a un altro ospite, non l'ho cambiato");
    }
    if (!(a.note ?? "").includes(marker)) {
      modifica.note = `${a.note ? a.note + "\n\n" : ""}${marker}`;
    }

    const spostamento = dataLocale(a.data_ora) !== riga.dataRinnovo
      ? `spostato dal ${dataLocale(a.data_ora)} al ${riga.dataRinnovo}`
      : "";
    const origine = trovato.via === "marker" ? "" : " (appuntamento esistente riconosciuto, non creato di nuovo)";
    const dettaglio = [spostamento, ...note].filter(Boolean).join("; ") + origine;

    if (Object.keys(modifica).length === 0) {
      return { azione: "nessuna_modifica", dettaglio: `già allineato${origine}${note.length ? "; " + note.join("; ") : ""}` };
    }
    return { azione: "aggiornato", id: a.id, modifica, dettaglio: dettaglio || "aggiornato" };
  }

  // nessun appuntamento da aggiornare: se ne crea uno nuovo, collegato all'ospite
  return {
    azione: "creato",
    daVerificare: false,
    dettaglio: "creato un nuovo appuntamento",
    inserisci: {
      struttura_id: ospite.struttura_id,
      titolo: `Questura ${TRATTO} ${nomeCompleto}`,
      tipo: "Questura",
      data_ora: calcolaDataOra(riga),
      ospite_nome: nomeCompleto,
      ospite_id: ospite.id,
      note: [...noteBase, "Sincronizzato automaticamente dal foglio scadenze PDS.", "", marker].join("\n"),
    },
  };
}
