// Riconoscimento del tipo di atto e dell'ospite a partire dall'oggetto di una PEC inoltrata.
import { dateNascita, type Ospite, parole, paroleUguali } from "./logic.ts";

export type TipoAtto = "decreto_commissione" | "revoca" | "cessazione" | "convocazione" | "altro";

export function tipoAtto(oggetto: string): TipoAtto {
  const s = oggetto.toLowerCase();
  if (/convocazion/.test(s)) return "convocazione";
  if (/revoca/.test(s)) return "revoca";
  if (/cessazione/.test(s)) return "cessazione";
  if (/commissione territoriale/.test(s) && /decreto/.test(s)) return "decreto_commissione";
  return "altro";
}

export const NOMI_ATTO: Record<TipoAtto, string> = {
  decreto_commissione: "Decreto Commissione",
  revoca: "Revoca accoglienza",
  cessazione: "Cessazione accoglienza",
  convocazione: "Convocazione",
  altro: "Atto",
};

// Toglie le parti dell'oggetto che non sono nomi (prefissi PEC, ente, nazionalità comuni).
function paroleOggetto(oggetto: string): string[] {
  const pulito = oggetto
    .replace(/posta certificata/gi, " ")
    .replace(/\b(fwd|fw|re|i|r)\s*:/gi, " ")
    .replace(/commissione territoriale per il riconoscimento della protezione internazionale/gi, " ")
    .replace(/metis/gi, " ");
  return parole(pulito).principali;
}

// Ospiti il cui nome compare per intero nell'oggetto (parole quasi uguali ammesse).
// Se nell'oggetto c'è una data di nascita, serve a scegliere tra più candidati.
export function ospitiNelTesto(oggetto: string, ospiti: Ospite[]): Ospite[] {
  const testo = paroleOggetto(oggetto);
  const nascite = dateNascita(oggetto);
  const trovati = ospiti
    .map((o) => {
      const nome = parole(`${o.cognome ?? ""} ${o.nome ?? ""}`).principali.filter((w) => w.length >= 2 && w !== "md");
      if (nome.length === 0) return null;
      // Con una sola parola utile (es. "MD Sumon") la grafia deve essere identica: "Sujon" non è "Sumon".
      const tutte = nome.length === 1
        ? testo.includes(nome[0])
        : nome.every((w) => testo.some((t) => paroleUguali(t, w)));
      return tutte ? { o, n: nome.length } : null;
    })
    .filter((x): x is { o: Ospite; n: number } => x !== null);
  if (trovati.length <= 1) return trovati.map((x) => x.o);
  if (nascite.length > 0) {
    const perData = trovati.filter((x) => x.o.data_nascita && nascite.includes(x.o.data_nascita));
    if (perData.length === 1) return [perData[0].o];
  }
  const max = Math.max(...trovati.map((x) => x.n));
  const migliori = trovati.filter((x) => x.n === max);
  if (migliori.length > 1) {
    const attivi = migliori.filter((x) => x.o.attivo !== false);
    if (attivi.length === 1) return [attivi[0].o];
  }
  return migliori.map((x) => x.o);
}
