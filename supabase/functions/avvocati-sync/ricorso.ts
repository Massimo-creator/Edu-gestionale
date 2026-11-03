// Esito di un ricorso letto dal testo della mail dell'avvocata (decisione di Massimo, 03/11/2026).
// Esempio reale: "è arrivata la sentenza per HOWLADER RAJAUL. Tutto bene, il tribunale gli ha
// riconosciuto la protezione speciale."
// Regole fisse e prudenti: l'esito conta solo se il soggetto è il Tribunale (o il giudice, la sentenza,
// il ricorso) e il verbo è al passato. Una frase sulla Commissione ("la commissione ha rigettato")
// o una richiesta ("chiediamo che venga riconosciuta") non conta. Se il testo dice sia accolto sia
// rigettato, o non è chiaro, il risultato è null e la scheda non si tocca.

export type EsitoRicorso = {
  esito: "accolto" | "rigettato";
  protezione: "protezione speciale" | "protezione sussidiaria" | "status di rifugiato" | null;
  frase: string;
};

function normale(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ");
}

function frasi(testo: string): string[] {
  return testo
    .replace(/\r/g, "")
    .split(/(?<=[.?!])\s+|\n\s*\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

const SOGGETTO = /(tribunale|giudice|sentenza|decreto del tribunale|corte)/;
const ACCOLTO = [
  /(tribunale|giudice|sentenza|corte)[^.]{0,80}\b(ha|hanno|e stat[oa])\s+(gli |le |loro )?(riconosciut|accolt|concess)/,
  /\bricorso\b[^.]{0,30}\b(e stato |e )?accolto\b/,
  /\baccolto il ricorso\b/,
  /\bricorso accolto\b/,
];
const RIGETTATO = [
  /(tribunale|giudice|sentenza|corte)[^.]{0,80}\b(ha|hanno|e stat[oa])\s+(rigettat|respint|rigettato|respinto|negat)/,
  /(tribunale|giudice|sentenza|corte)[^.]{0,80}\bnon\s+(gli |le )?ha\s+(riconosciut|accolt|concess)/,
  /\bricorso\b[^.]{0,30}\b(e stato |e )?(rigettat|respint)/,
  /\b(rigettato|respinto) il ricorso\b/,
  /\bricorso (rigettato|respinto)\b/,
];

function protezioneIn(t: string): EsitoRicorso["protezione"] {
  if (/protezione speciale/.test(t)) return "protezione speciale";
  if (/sussidiari/.test(t)) return "protezione sussidiaria";
  if (/rifugiat|status di rifugio/.test(t)) return "status di rifugiato";
  return null;
}

export function esitoRicorsoDaMail(testo: string): EsitoRicorso | null {
  const trovati: EsitoRicorso[] = [];
  for (const f of frasi(testo)) {
    const t = normale(f);
    if (/commissione/.test(t) && !SOGGETTO.test(t)) continue;
    if (!SOGGETTO.test(t) && !/\bricorso\b/.test(t)) continue;
    const acc = ACCOLTO.some((r) => r.test(t));
    const rig = RIGETTATO.some((r) => r.test(t));
    if (acc && rig) {
      // Accoglimento parziale ("ha respinto lo status ma gli ha riconosciuto la protezione speciale"):
      // conta come accolto, con la protezione che segue "riconosciut". Altrimenti non è chiaro.
      const dopo = /riconosciut\w*\s+(.{0,60})/.exec(t)?.[1] ?? "";
      const p = protezioneIn(dopo);
      if (!p) return null;
      trovati.push({ esito: "accolto", protezione: p, frase: f });
      continue;
    }
    if (acc) trovati.push({ esito: "accolto", protezione: protezioneIn(t), frase: f });
    else if (rig) trovati.push({ esito: "rigettato", protezione: null, frase: f });
  }
  if (trovati.length === 0) return null;
  if (new Set(trovati.map((x) => x.esito)).size > 1) return null;
  return trovati[0];
}

// Valori della scheda che si possono aggiornare con l'esito del ricorso.
export function esitoAggiornabile(attuale: string | null | undefined): boolean {
  const s = String(attuale ?? "").trim().toLowerCase();
  return s === "" || s === "diniego" || s === "commissione sostenuta";
}

export function testoEsito(r: EsitoRicorso): string {
  return r.esito === "accolto" ? "Diniego (ricorso accolto)" : "Diniego (ricorso rigettato)";
}
