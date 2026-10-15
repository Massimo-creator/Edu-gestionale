// Lettura dei contenuti degli atti. Solo testo copiato dal documento, mai riformulato.

function pulisci(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

export type Convocazione = { data: string; ora: string; luogo: string; frase: string };

// "La S.V. è invitata a presentarsi il giorno 28-10-2026, alle ore 09:00, presso la Commissione ..., per un colloquio"
// Le lettere di Forlì non hanno la virgola: "... sita in P.zza Ordelaffi, 2 - 47121 Forli per un colloquio personale".
export function leggiConvocazione(testo: string): Convocazione | null {
  const t = pulisci(testo);
  const m = /presentarsi\s+il\s+giorno\s+(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4}),?\s+alle\s+ore\s+(\d{1,2})[:.](\d{2}),?\s+presso\s+(.+?)(?:,\s+per\s|\s+per\s+(?:un|il)\s+colloquio)/i.exec(t);
  if (!m) return null;
  const [g, me, a, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  if (me < 1 || me > 12 || g < 1 || g > 31 || h > 23 || mi > 59) return null;
  const data = `${a}-${String(me).padStart(2, "0")}-${String(g).padStart(2, "0")}`;
  const ora = `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  const luogo = m[6].replace(/^la\s+/i, "").trim();
  const inizio = t.lastIndexOf("La S.V.", m.index) >= 0 ? t.lastIndexOf("La S.V.", m.index) : m.index;
  const fineLuogo = m.index + m[0].lastIndexOf(m[6]) + m[6].length;
  return { data, ora, luogo, frase: t.slice(inizio, fineLuogo).trim() };
}

// Decreto della Commissione: dispositivo dopo "DECIDE" e procedura applicata.
export function leggiDecreto(testo: string): { decisione: string | null; procedura: string | null } {
  const t = pulisci(testo);
  let decisione: string | null = null;
  const i = t.search(/\bDECIDE\b/);
  if (i >= 0) {
    let resto = t.slice(i + "DECIDE".length).trim();
    // Si ferma anche prima dell'intestazione o della firma di pagina (decreti del 2024: "Ministero dell'Interno…",
    // "Forlì, 26/07/2024 IL PRESIDENTE…", "Documento Firmato Digitalmente") e prima delle traduzioni ("DECIDES not to grant…").
    const fine = resto.search(/(\\?-{5,}|Per consentire|\bDECIDES\b|Decides to|\bATTESTA\b|PRESO ATTO|Ministero dell|Forl[ìi]’?,\s*\d{1,2}\/\d{1,2}\/\d{4}|IL PRESIDENTE|Documento Firmato)/);
    if (fine > 0) resto = resto.slice(0, fine);
    decisione = resto.trim().slice(0, 600) || null;
  }
  const p = /(la domanda è decisa in applicazione della procedura [^;.]+)/i.exec(t);
  return { decisione, procedura: p ? p[1].trim() : null };
}

// Revoche, cessazioni e simili: frasi con un termine "entro ... giorni".
export function frasiConTermini(testo: string, max = 3): string[] {
  const t = pulisci(testo);
  const frasi = t.split(/(?<=[.;])\s+(?=[A-ZÀ-Ú])/);
  const out: string[] = [];
  for (const f of frasi) {
    if (/\bentro\b[^.;]{0,40}\bgiorni\b/i.test(f) && !out.includes(f)) out.push(f.length > 500 ? f.slice(0, 500) + "…" : f);
    if (out.length >= max) break;
  }
  return out;
}
