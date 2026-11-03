// Logica pura della sincronizzazione Questura: abbinamento all'ospite e scelta
// dell'appuntamento da aggiornare. Nessun accesso al database: si può provare da sola.
// (In pec-archivio servono solo le funzioni sui nomi e sulle date di nascita.)

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
