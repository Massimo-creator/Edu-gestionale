// Lettura leggera di un messaggio MIME, senza librerie: le PEC grandi (decreti firmati da 1-2 MB)
// superano i limiti di calcolo con il parser completo. Qui gli allegati in base64 restano in base64,
// senza decodificarli e ricodificarli.

import { Buffer } from "node:buffer";
import { oggettoDaIntestazioni } from "./oggetto.ts";

type Parte = { intestazioni: string; corpo: string };

const dec = new TextDecoder("latin1");

function separa(testo: string): Parte {
  const i = testo.search(/\r?\n\r?\n/);
  if (i < 0) return { intestazioni: testo, corpo: "" };
  const salto = testo.slice(i).match(/^\r?\n\r?\n/)![0].length;
  return { intestazioni: testo.slice(0, i), corpo: testo.slice(i + salto) };
}

function intestazione(intestazioni: string, nome: string): string {
  const ricucite = intestazioni.replace(/\r?\n[ \t]+/g, " ");
  const m = ricucite.match(new RegExp(`^${nome}:\\s*(.*)$`, "im"));
  return m ? m[1].trim() : "";
}

function parametro(valore: string, nome: string): string {
  // nome="..." oppure nome=... ; anche la forma RFC 2231 (nome*=utf-8''...)
  const m = valore.match(new RegExp(`(?:^|[;\\s])${nome}\\*?=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"));
  let v = m ? (m[1] ?? m[2] ?? "") : "";
  if (!m) {
    // Nome spezzato in pezzi (RFC 2231): filename*0="..."; filename*1=...; anche filename*0*=utf-8''...
    const pezzi: [number, string, boolean][] = [];
    const re = new RegExp(`(?:^|[;\\s])${nome}\\*(\\d+)(\\*?)=\\s*(?:"([^"]*)"|([^;\\s]+))`, "gi");
    for (const x of valore.matchAll(re)) pezzi.push([Number(x[1]), x[3] ?? x[4] ?? "", x[2] === "*"]);
    pezzi.sort((a, b) => a[0] - b[0]);
    v = pezzi.map(([n, s, codificato]) => {
      if (!codificato) return s;
      const t = n === 0 ? s.replace(/^[\w-]*'[^']*'/, "") : s;
      try { return decodeURIComponent(t); } catch { return t; }
    }).join("");
  }
  const rfc2231 = v.match(/^[\w-]+''(.*)$/);
  if (rfc2231) { try { v = decodeURIComponent(rfc2231[1]); } catch { /* */ } }
  return oggettoDaIntestazioni("Subject: " + v);
}

function sottoParti(p: Parte): Parte[] {
  const tipo = intestazione(p.intestazioni, "content-type");
  if (!/^multipart\//i.test(tipo)) return [p];
  const confine = parametro(tipo, "boundary");
  if (!confine) return [p];
  const pezzi = p.corpo.split(new RegExp(`\\r?\\n?--${confine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*\\r?\\n?`));
  const out: Parte[] = [];
  for (const pezzo of pezzi.slice(1)) {
    if (!pezzo.trim()) continue;
    out.push(...sottoParti(separa(pezzo)));
  }
  return out;
}

function base64Pulito(s: string): string {
  return s.replace(/[^A-Za-z0-9+/=]/g, "");
}

function testoParte(p: Parte): string {
  const cte = intestazione(p.intestazioni, "content-transfer-encoding").toLowerCase();
  const charset = parametro(intestazione(p.intestazioni, "content-type"), "charset") || "utf-8";
  let bytes: Uint8Array;
  if (cte === "base64") bytes = Buffer.from(base64Pulito(p.corpo), "base64");
  else if (cte === "quoted-printable") {
    const t = p.corpo.replace(/=\r?\n/g, "");
    const out: number[] = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
      else out.push(t.charCodeAt(i) & 0xff);
    }
    bytes = Uint8Array.from(out);
  } else bytes = Uint8Array.from(p.corpo, (c) => c.charCodeAt(0) & 0xff);
  try { return new TextDecoder(charset.toLowerCase().replace(/^iso-8859-1$/, "latin1")).decode(bytes); } catch { return dec.decode(bytes); }
}

function datiParte(p: Parte): { base64: string; bytes: () => Uint8Array } {
  const cte = intestazione(p.intestazioni, "content-transfer-encoding").toLowerCase();
  if (cte === "base64") {
    const b64 = base64Pulito(p.corpo);
    return { base64: b64, bytes: () => Buffer.from(b64, "base64") };
  }
  const grezzi = Uint8Array.from(p.corpo, (c) => c.charCodeAt(0) & 0xff);
  return { base64: Buffer.from(grezzi).toString("base64"), bytes: () => grezzi };
}

export type MessaggioLeggero = {
  intestazioni: string;
  oggetto: string;
  mittente: string;
  data: string;
  ricevuta: boolean;
  testo: string;
  allegati: { nome: string; tipo: string; base64: string; bytes: () => Uint8Array }[];
  originale: MessaggioLeggero | null; // postacert.eml, se presente
};

export function leggiMessaggio(sorgente: Uint8Array | string, profondita = 0): MessaggioLeggero {
  const testo = typeof sorgente === "string" ? sorgente : dec.decode(sorgente);
  const radice = separa(testo);
  const parti = sottoParti(radice);
  const allegati: MessaggioLeggero["allegati"] = [];
  let corpo = "";
  let html = "";
  let originale: MessaggioLeggero | null = null;
  for (const p of parti) {
    const tipo = intestazione(p.intestazioni, "content-type");
    const disp = intestazione(p.intestazioni, "content-disposition");
    const nome = parametro(disp, "filename") || parametro(tipo, "name");
    if (/^message\/rfc822/i.test(tipo) || /postacert\.eml$/i.test(nome)) {
      if (profondita < 2) {
        const d = datiParte(p);
        originale = leggiMessaggio(dec.decode(d.bytes()), profondita + 1);
      }
      continue;
    }
    if (nome) {
      const d = datiParte(p);
      allegati.push({ nome, tipo: tipo.split(";")[0].trim().toLowerCase(), base64: d.base64, bytes: d.bytes });
    } else if (!corpo && /^text\/plain/i.test(tipo || "text/plain")) {
      corpo = testoParte(p);
    } else if (!html && /^text\/html/i.test(tipo)) {
      html = testoParte(p);
    }
  }
  if (!corpo && html) {
    // Solo HTML (es. le notifiche della Commissione): testo ricavato togliendo i tag.
    corpo = html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, "\n")
      .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_t, n) => String.fromCharCode(Number(n))).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  }
  const dataTesto = intestazione(radice.intestazioni, "date");
  const quando = new Date(dataTesto);
  return {
    intestazioni: radice.intestazioni,
    oggetto: oggettoDaIntestazioni(radice.intestazioni.match(/^subject:.*(?:\r?\n[ \t].*)*/im)?.[0] ?? ""),
    mittente: oggettoDaIntestazioni("Subject: " + intestazione(radice.intestazioni, "from")),
    data: isNaN(quando.getTime()) ? "" : quando.toISOString(),
    ricevuta: /^x-ricevuta:/im.test(radice.intestazioni),
    testo: corpo,
    allegati,
    originale,
  };
}
