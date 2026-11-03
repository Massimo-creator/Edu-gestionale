// Abbinamento all'ospite: stessa logica della funzione pec-archivio (copiata, per non toccarla).

export type Ospite = {
  id: string;
  nome: string | null;
  cognome: string | null;
  data_nascita: string | null; // YYYY-MM-DD
  struttura_id: string | null;
  attivo: boolean | null;
};

function senzaAccenti(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function spezza(t: string): string[] {
  return t.replace(/\balias\b/g, " ").split(/[^a-z]+/).filter((x) => x.length > 0);
}

function unici(a: string[]): string[] {
  return [...new Set(a)];
}

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

export function paroleUguali(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && distanza(a, b) <= 1;
}

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

function paroleTesto(testo: string): string[] {
  const pulito = testo
    .replace(/\b(fwd|fw|re|i|r)\s*:/gi, " ")
    .replace(/metis/gi, " ");
  return parole(pulito).principali;
}

// Ospiti il cui nome compare per intero nel testo (parole quasi uguali ammesse).
export function ospitiNelTesto(testo: string, ospiti: Ospite[]): Ospite[] {
  const t = paroleTesto(testo);
  const nascite = dateNascita(testo);
  const trovati = ospiti
    .map((o) => {
      const nome = parole(`${o.cognome ?? ""} ${o.nome ?? ""}`).principali.filter((w) => w.length >= 2 && w !== "md");
      if (nome.length === 0) return null;
      const tutte = nome.length === 1
        ? t.includes(nome[0])
        : nome.every((w) => t.some((x) => paroleUguali(x, w)));
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
