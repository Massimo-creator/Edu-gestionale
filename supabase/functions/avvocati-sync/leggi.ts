// Lettura delle mail dell'avvocata: solo regole fisse sul testo, nessuna interpretazione.
// Si scrive in Approdo solo se nella mail c'è UNA data futura e UN orario legati alla parola
// "udienza", "audizione" o "appuntamento". In tutti gli altri casi: da verificare.

export type TipoEvento = "Ricorso" | "Avvocato";
export type Lettura = {
  esito: "pronto" | "manca_ora" | "manca_data" | "piu_date" | "piu_ore" | "nessun_evento";
  tipo: TipoEvento | null;
  data: string | null; // YYYY-MM-DD
  ora: string | null; // HH:MM
  frase: string | null; // frase della mail da cui si è letto (testo originale)
  dateTrovate: string[];
  oreTrovate: string[];
};

const MESI: Record<string, number> = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
};

const PAROLA_EVENTO = /\b(udienza|udienze|audizione|appuntamento|aspetto)\b/i;
const PAROLA_TRIBUNALE = /\b(udienza|audizione|tribunale|giudice)\b/i;
// Orari e date di contorno da scartare: treni, scadenze per i documenti.
const CONTORNO_ORA = /(treno|partenza|partire|arriva|arrivo|ritorno|rientro)\W+(?:\w+\W+){0,3}$/i;
const CONTORNO_DATA = /(termine|entro|scadenza|deposit\w*)\W+(?:\w+\W+){0,3}$/i;

function dataValida(a: number, m: number, g: number): string | null {
  const t = new Date(Date.UTC(a, m - 1, g));
  if (t.getUTCFullYear() !== a || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== g) return null;
  return `${a}-${String(m).padStart(2, "0")}-${String(g).padStart(2, "0")}`;
}

// Anno mancante ("04 novembre"): il primo giorno con quella data a partire dalla data della mail.
function conAnno(g: number, m: number, rif: string): string | null {
  const annoRif = Number(rif.slice(0, 4));
  for (const a of [annoRif, annoRif + 1]) {
    const d = dataValida(a, m, g);
    if (d && d >= rif) return d;
  }
  return null;
}

type Trovato = { valore: string; pos: number };

function dateNellaFrase(f: string, rif: string): Trovato[] {
  const out: Trovato[] = [];
  const re1 = /(?<!\d)(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?!\d)/g;
  for (const m of f.matchAll(re1)) {
    const d = dataValida(Number(m[3]), Number(m[2]), Number(m[1]));
    if (d) out.push({ valore: d, pos: m.index! });
  }
  const re2 = /(?<!\d)(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+(\d{4}))?/gi;
  for (const m of f.matchAll(re2)) {
    const g = Number(m[1]), me = MESI[m[2].toLowerCase()];
    const d = m[3] ? dataValida(Number(m[3]), me, g) : conAnno(g, me, rif);
    if (d) out.push({ valore: d, pos: m.index! });
  }
  return out.filter((x) => !CONTORNO_DATA.test(f.slice(Math.max(0, x.pos - 40), x.pos)));
}

function oreNellaFrase(f: string): Trovato[] {
  const out: Trovato[] = [];
  // "alle 11.30", "ore 11.15", "per le 10.00", "alle ore 12:10", "alle 13"
  const re = /\b(?:alle\s+ore|ore|alle|per\s+le|dalle)\s+(\d{1,2})(?:[.:](\d{2}))?(?![\d.\/-]\d)/gi;
  for (const m of f.matchAll(re)) {
    const h = Number(m[1]), mi = Number(m[2] ?? 0);
    if (h < 7 || h > 20 || mi > 59) continue;
    const prima = f.slice(Math.max(0, m.index! - 40), m.index!);
    if (CONTORNO_ORA.test(prima)) continue;
    out.push({ valore: `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`, pos: m.index! });
  }
  return out;
}

function frasi(testo: string): string[] {
  // Le abbreviazioni ("sig.", "avv.", "dr.ssa") non chiudono la frase.
  return testo
    .replace(/\r/g, "")
    .replace(/\b(sig|sigg|avv|dott|dr|dott\.ssa|dr\.ssa|sig\.ra|prof|n|nr|art|ecc)\.\s+/gi, "$1§ ")
    .split(/(?<=[.?!])\s+|\n\s*\n/)
    .map((s) => s.replace(/§/g, "."))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

function unici(a: string[]): string[] {
  return [...new Set(a)];
}

// rif = data della mail (YYYY-MM-DD, ora di Roma). Le date precedenti a rif non contano.
export function leggiMail(testo: string, rif: string): Lettura {
  const elenco = frasi(testo);
  const conEvento = elenco.map((f, i) => ({ f, i })).filter((x) => PAROLA_EVENTO.test(x.f));
  if (conEvento.length === 0) {
    return { esito: "nessun_evento", tipo: null, data: null, ora: null, frase: null, dateTrovate: [], oreTrovate: [] };
  }
  const date: string[] = [], ore: string[] = [], usate: string[] = [];
  for (const { f } of conEvento) {
    const d = dateNellaFrase(f, rif).map((x) => x.valore).filter((x) => x >= rif);
    const o = oreNellaFrase(f).map((x) => x.valore);
    if (d.length || o.length) usate.push(f);
    date.push(...d);
    ore.push(...o);
  }
  const dateU = unici(date), oreU = unici(ore);
  const tipo: TipoEvento = conEvento.some((x) => PAROLA_TRIBUNALE.test(x.f)) ? "Ricorso" : "Avvocato";
  const base = { tipo, frase: usate.join(" ") || null, dateTrovate: dateU, oreTrovate: oreU };
  if (dateU.length === 0) return { esito: "manca_data", data: null, ora: oreU[0] ?? null, ...base };
  if (dateU.length > 1) return { esito: "piu_date", data: null, ora: null, ...base };
  if (oreU.length === 0) return { esito: "manca_ora", data: dateU[0], ora: null, ...base };
  if (oreU.length > 1) return { esito: "piu_ore", data: dateU[0], ora: null, ...base };
  return { esito: "pronto", data: dateU[0], ora: oreU[0], ...base };
}

// Toglie dalla mail la parte citata delle risposte ("Il giorno ... ha scritto:", righe con ">").
// Negli inoltri (Fwd / I:) il testo inoltrato è il contenuto: si tengono, senza le intestazioni.
export function parteNuova(corpo: string, oggetto: string): string {
  const inoltro = /^\s*(fwd?|i)\s*:/i.test(oggetto);
  let t = String(corpo ?? "").replace(/\r/g, "");
  if (inoltro) {
    t = t.replace(/^-{5,}\s*(Forwarded message|Messaggio inoltrato)\s*-{5,}$/gim, "")
      .replace(/^(Da|From|Date|Data|Subject|Oggetto|To|A|Cc):.*$/gim, "");
  }
  const taglio = t.search(/^\s*(Il giorno .{5,200}?ha scritto:|Il .{3,80} \d{1,2}:\d{2} .{3,200}?ha scritto:|On .{5,200}?wrote:)\s*$/ims);
  if (taglio >= 0) t = t.slice(0, taglio);
  return t.split("\n").filter((r) => !/^\s*>/.test(r)).join("\n").trim();
}
