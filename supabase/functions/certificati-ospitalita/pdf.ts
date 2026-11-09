// Impaginazione del certificato di ospitalità (testo approvato da Massimo il 09/11/2026).
// Riceve la libreria pdf-lib dall'esterno, così si può provare anche fuori da Supabase.

export type DatiCertificato = {
  femmina: boolean;
  nominativo: string;     // COGNOME Nome
  paese: string;          // paese di nascita/nazionalità, es. "Bangladesh"
  dataNascita: string;    // gg/mm/aaaa
  cittadinanza: string;   // es. "bengalese"
  struttura: string;      // nome della struttura
  indirizzo: string;      // es. "Via Borgo 2, Verucchio (RN)"
  appData: string;        // gg/mm/aaaa
  appOra: string | null;  // hh:mm, null se da definire
  dataEmissione: string;  // es. "9 novembre 2026"
  // Minori dello stesso nucleo con l'appuntamento lo stesso giorno (decisione di Massimo, 09/11/2026)
  minori?: { nominativo: string; femmina: boolean; paese: string; dataNascita: string }[];
};

type Pezzo = { t: string; b?: boolean };

// deno-lint-ignore no-explicit-any
export async function creaPdf(lib: any, baseBytes: Uint8Array, timbroBytes: Uint8Array, d: DatiCertificato): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = lib;
  const base = await PDFDocument.load(baseBytes);
  const doc = await PDFDocument.create();
  const [pag] = await doc.copyPages(base, [0]);
  doc.addPage(pag);
  doc.setTitle(`Certificato di ospitalità - ${d.nominativo}`);
  doc.setAuthor("Cooperativa Sociale Metis");
  doc.setCreator("Approdo");
  doc.setProducer("Approdo");

  const R = await doc.embedFont(StandardFonts.Helvetica);
  const B = await doc.embedFont(StandardFonts.HelveticaBold);
  const nero = rgb(0, 0, 0);
  const { width: W, height: H } = pag.getSize();
  const SX = 56.7;
  const LARG = W - 2 * SX;
  const FIRMA_X = 428; // centro del blocco firma e timbro

  // Caratteri che il font non sa scrivere: si toglie l'accento, altrimenti si salta.
  // deno-lint-ignore no-explicit-any
  const pulisci = (s: string, f: any) =>
    Array.from(s.normalize("NFC")).map((ch) => {
      try { f.encodeText(ch); return ch; } catch { /* */ }
      const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      try { f.encodeText(base); return base; } catch { return ""; }
    }).join("");

  const font = (p: Pezzo) => (p.b ? B : R);

  // Parole fatte di frammenti (una parola può essere in parte in grassetto, es. "**Bangladesh**,").
  function parole(pezzi: Pezzo[], size: number) {
    const out: { fr: { t: string; b: boolean; w: number }[]; w: number }[] = [];
    let cur: { t: string; b: boolean; w: number }[] = [];
    const chiudi = () => { if (cur.length) { out.push({ fr: cur, w: cur.reduce((a, x) => a + x.w, 0) }); cur = []; } };
    for (const p of pezzi) {
      const parti = p.t.split(/(\s+)/);
      for (const x of parti) {
        if (x === "") continue;
        if (/^\s+$/.test(x)) { chiudi(); continue; }
        const t = pulisci(x, font(p));
        cur.push({ t, b: !!p.b, w: font(p).widthOfTextAtSize(t, size) });
      }
    }
    chiudi();
    return out;
  }

  // Scrive un paragrafo a partire dalla linea di base y (misurata dall'alto). Restituisce l'ultima linea di base.
  function paragrafo(pezzi: Pezzo[], y: number, size = 11, allinea: "sinistra" | "centro" = "sinistra", lh = 17, x0 = SX, larg = LARG): number {
    const ws = parole(pezzi, size);
    const spazio = R.widthOfTextAtSize(" ", size);
    const righe: typeof ws[] = [];
    let riga: typeof ws = [];
    let lw = 0;
    for (const w of ws) {
      const nuova = riga.length ? lw + spazio + w.w : w.w;
      if (riga.length && nuova > larg) { righe.push(riga); riga = [w]; lw = w.w; }
      else { riga.push(w); lw = nuova; }
    }
    if (riga.length) righe.push(riga);
    let yy = y;
    righe.forEach((r, i) => {
      yy = y + i * lh;
      const larghezza = r.reduce((a, w) => a + w.w, 0) + spazio * (r.length - 1);
      let x = allinea === "centro" ? x0 + (larg - larghezza) / 2 : x0;
      r.forEach((w, j) => {
        for (const f of w.fr) {
          pag.drawText(f.t, { x, y: H - yy, size, font: f.b ? B : R, color: nero });
          x += f.w;
        }
        if (j < r.length - 1) x += spazio;
      });
    });
    return yy;
  }

  const o = d.femmina ? "a" : "o";
  const PASSO = 35; // da un paragrafo all'altro (riga + spazio dopo)

  paragrafo([{ t: "CERTIFICATO DI OSPITALITÀ", b: true }], 172, 16, "centro");
  let y = paragrafo([
    { t: "Il sottoscritto " }, { t: "Dott. Massimo Andreoni", b: true },
    { t: ", in qualità di coordinatore della " }, { t: "Cooperativa Sociale Metis Società Cooperativa", b: true }, { t: "," },
  ], 228);
  y = paragrafo([{ t: "CERTIFICA", b: true }], y + 34, 12, "centro");
  const minori = d.minori ?? [];
  const pezziMinori: Pezzo[] = [];
  minori.forEach((m, i) => {
    if (i === 0) pezziMinori.push({ t: minori.length > 1 ? ", unitamente ai minori " : ", unitamente al minore " });
    else pezziMinori.push({ t: i === minori.length - 1 ? " e " : ", " });
    pezziMinori.push({ t: m.nominativo, b: true }, { t: `, ${m.femmina ? "nata" : "nato"} in ` }, { t: m.paese, b: true },
      { t: " il " }, { t: m.dataNascita, b: true });
  });
  y = paragrafo([
    { t: `che ${d.femmina ? "la sig.ra" : "il sig."} ` }, { t: d.nominativo, b: true },
    { t: `, ${d.femmina ? "nata" : "nato"} in ` }, { t: d.paese, b: true },
    { t: " il " }, { t: d.dataNascita, b: true },
    { t: ", di cittadinanza " }, { t: d.cittadinanza, b: true },
    ...pezziMinori,
    { t: `, è ${d.femmina ? "ospitata" : "ospitato"} presso la struttura di accoglienza ` }, { t: d.struttura, b: true },
    { t: ", sita in " }, { t: d.indirizzo, b: true }, { t: ", gestita dalla scrivente Cooperativa." },
  ], y + PASSO);
  const conMinori = minori.length ? `, insieme ${minori.length > 1 ? "ai minori" : "al minore"},` : "";
  const app: Pezzo[] = [
    { t: `L’interessat${o}${conMinori} ha un appuntamento presso l’Ufficio Immigrazione della Questura di Rimini il giorno ` },
    { t: d.appData, b: true },
  ];
  if (d.appOra) app.push({ t: " alle ore " }, { t: d.appOra, b: true });
  app.push({ t: "." });
  y = paragrafo(app, y + PASSO);
  y = paragrafo([{ t: `Il presente certificato è rilasciato su richiesta dell’interessat${o} per gli usi consentiti dalla legge.` }], y + PASSO);
  y = paragrafo([{ t: `Rimini, ${d.dataEmissione}` }], y + PASSO);

  const xf = FIRMA_X - 100;
  y = paragrafo([{ t: "Il Coordinatore" }], y + 52, 11, "centro", 17, xf, 200);
  y = paragrafo([{ t: "Dott. Massimo Andreoni", b: true }], y + 17, 11, "centro", 17, xf, 200);

  const timbro = await doc.embedPng(timbroBytes);
  const tw = 170;
  const th = tw * timbro.height / timbro.width;
  pag.drawImage(timbro, { x: FIRMA_X - tw / 2, y: H - (y + 11) - th, width: tw, height: th });

  return await doc.save();
}
