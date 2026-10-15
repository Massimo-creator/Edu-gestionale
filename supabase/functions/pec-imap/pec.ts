import { Buffer } from "node:buffer";
import { leggiMessaggio } from "./mime.ts";

export type Pec = { oggetto: string; mittente: string; data: string; corpo: string; pdf: { nome: string; base64: string; tipo: string }[]; allegati: string[] };

// Il documento contenuto in una busta .p7m (CAdES, contenuto incluso). Si legge la struttura ASN.1:
// ContentInfo -> SignedData -> encapContentInfo -> [0] OCTET STRING, anche se spezzato in più pezzi.
type Tlv = { tag: number; inizio: number; fine: number; figli: number }; // figli: inizio del contenuto
function leggiTlv(b: Uint8Array, i: number): Tlv | null {
  if (i + 2 > b.length) return null;
  const tag = b[i];
  let j = i + 1;
  let len = b[j++];
  if (len === 0x80) { // lunghezza indefinita: si cerca la fine contando i figli fino a 00 00
    let k = j;
    while (k + 1 < b.length && !(b[k] === 0 && b[k + 1] === 0)) {
      const f = leggiTlv(b, k);
      if (!f) return null;
      k = f.fine;
    }
    return { tag, inizio: i, fine: k + 2, figli: j };
  }
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4) return null;
    len = 0;
    for (let x = 0; x < n; x++) len = len * 256 + b[j++];
  }
  return { tag, inizio: i, fine: j + len, figli: j };
}
function figli(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let k = t.figli;
  const lim = b[t.inizio + 1] === 0x80 ? t.fine - 2 : t.fine;
  while (k < lim) {
    const f = leggiTlv(b, k);
    if (!f || f.fine > b.length) break;
    out.push(f);
    k = f.fine;
  }
  return out;
}
function ottetti(b: Uint8Array, t: Tlv, out: Uint8Array[]): void {
  if (t.tag === 0x04) out.push(b.subarray(t.figli, t.fine));
  else if (t.tag === 0x24 || t.tag === 0xa0) for (const f of figli(b, t)) ottetti(b, f, out);
}
function pdfDaP7m(b: Uint8Array): Uint8Array | null {
  try {
    const ci = leggiTlv(b, 0); // ContentInfo
    if (!ci || ci.tag !== 0x30) return null;
    const [, contenuto] = figli(b, ci); // OID, [0]
    const sd = figli(b, contenuto)[0]; // SignedData
    const parti = figli(b, sd); // version, digestAlgorithms, encapContentInfo, ...
    const eci = parti.find((x, n) => n >= 2 && x.tag === 0x30);
    if (!eci) return null;
    const dentro = figli(b, eci).find((x) => x.tag === 0xa0);
    if (!dentro) return null;
    const pezzi: Uint8Array[] = [];
    for (const f of figli(b, dentro)) ottetti(b, f, pezzi);
    const tot = pezzi.reduce((t, p) => t + p.length, 0);
    const doc = new Uint8Array(tot);
    let o = 0;
    for (const p of pezzi) { doc.set(p, o); o += p.length; }
    // Solo se è davvero un PDF (inizia con %PDF-)
    return doc.length > 5 && doc[0] === 0x25 && doc[1] === 0x50 && doc[2] === 0x44 && doc[3] === 0x46 ? doc : null;
  } catch {
    return null;
  }
}

// Dalla busta PEC estrae il messaggio originale (postacert.eml); le ricevute vengono scartate (null).
export function apriPec(sorgente: Uint8Array): Promise<Pec | null> {
  const busta = leggiMessaggio(sorgente);
  if (busta.ricevuta) return Promise.resolve(null); // accettazione, consegna, mancata consegna: non sono atti
  const orig = busta.originale ?? busta;
  const pdf: { nome: string; base64: string; tipo: string }[] = [];
  for (const a of orig.allegati) {
    if (a.tipo === "application/pdf" || /\.pdf$/i.test(a.nome)) {
      pdf.push({ nome: a.nome, base64: a.base64, tipo: "application/pdf" });
    } else if (/\.p7m$/i.test(a.nome) || /pkcs7/i.test(a.tipo)) {
      // Atto firmato digitalmente (.p7m): si conserva l'originale e, se dentro c'è un PDF, anche il PDF leggibile.
      pdf.push({ nome: a.nome, base64: a.base64, tipo: "application/pkcs7-mime" });
      const interno = pdfDaP7m(a.bytes());
      if (interno) pdf.push({ nome: a.nome.replace(/\.p7m$/i, "").replace(/(\.pdf)?$/i, ".pdf"), base64: Buffer.from(interno).toString("base64"), tipo: "application/pdf" });
    }
  }
  // I PDF leggibili per primi: il primo viene letto per date e decisioni.
  pdf.sort((x, y) => (x.tipo === "application/pdf" ? 0 : 1) - (y.tipo === "application/pdf" ? 0 : 1));
  return Promise.resolve({
    // Si prende l'oggetto più completo tra busta e messaggio originale (in alcuni originali è troncato).
    oggetto: [orig.oggetto, busta.oggetto]
      .map((s) => s.replace(/^POSTA CERTIFICATA:\s*/i, "").trim())
      .sort((x, y) => y.length - x.length)[0],
    mittente: orig.mittente,
    data: orig.data || busta.data || new Date().toISOString(),
    corpo: orig.testo.slice(0, 8000),
    pdf,
    allegati: orig.allegati.map((x) => `${x.nome} (${x.tipo})`),
  });
}
