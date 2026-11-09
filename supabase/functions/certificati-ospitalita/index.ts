import { createClient } from "npm:@supabase/supabase-js@2";
import * as pdfLib from "npm:pdf-lib@1.17.1";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { creaPdf, type DatiCertificato } from "./pdf.ts";

// CERTIFICATI DI OSPITALITÀ (decisioni di Massimo, 09/11/2026)
// - Il certificato si genera solo per l'appuntamento in Questura imminente: lo chiede la mail delle 15
//   (accompagnamenti-domani) il giorno prima (il venerdì per il lunedì).
// - Data di emissione = giorno dell'appuntamento. Carta intestata Metis, timbro e firma del coordinatore.
// - I minori dello stesso nucleo con l'appuntamento in Questura lo stesso giorno entrano nel certificato dell'adulto.
// - Un solo file per ospite: pdf/<ospite_id>.pdf nel bucket privato "certificati", sovrascritto ogni volta.
//   Lo script Google "Archivio PEC" lo copia una volta al giorno nella cartella Giuridico (stesso file su Drive,
//   sovrascritto) e il link torna in Approdo (tabella certificati_ospitalita).
//
// POST JSON. Authorization: Bearer <PEC_SECRET> (script Google), <chiave vault cron_certificati> o service role.
//   { azione: "genera_appuntamento", appuntamento_id }  -> PDF in base64 (oppure esito "incluso" / "escluso")
//   { azione: "da_salvare" }                            -> certificati da copiare su Drive
//   { azione: "pdf", ospite_id }                         -> PDF archiviato, in base64
//   { azione: "registra", ospite_id, drive_file_id, drive_url }   oppure   { ospite_id, problema }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PEC_SECRET = (Deno.env.get("PEC_SECRET") ?? "").trim();
const BUCKET = "certificati";
const STRUTTURE_ESCLUSE = ["imperial"]; // il certificato non serve (decisione di Massimo, 09/11/2026)

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function risposta(corpo: unknown, stato = 200): Response {
  return new Response(JSON.stringify(corpo), { status: stato, headers: { "Content-Type": "application/json" } });
}

async function autorizzato(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  if (token === SERVICE_ROLE_KEY) return true;
  if (PEC_SECRET.length >= 32 && token === PEC_SECRET) return true;
  const { data } = await sb.rpc("verifica_chiave_cron", { p_nome: "certificati", p_valore: token });
  return data === true;
}

const MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
const fmtRomaData = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" });
const fmtRomaOra = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const isoRoma = (d: Date) => fmtRomaData.format(d); // AAAA-MM-GG
const dataIt = (iso: string) => { const [a, m, g] = iso.slice(0, 10).split("-"); return `${g}/${m}/${a}`; };
const dataLettere = (iso: string) => { const [a, m, g] = iso.split("-").map(Number); return `${g} ${MESI[m - 1]} ${a}`; };

function eta(nascita: string, giornoIso: string): number {
  const [a, m, g] = nascita.split("-").map(Number);
  const [oa, om, og] = giornoIso.split("-").map(Number);
  return oa - a - ((om < m || (om === m && og < g)) ? 1 : 0);
}

// deno-lint-ignore no-explicit-any
type Riga = Record<string, any>;
const nominativo = (o: Riga) => `${String(o.cognome ?? "").trim().toUpperCase()} ${String(o.nome ?? "").trim()}`.trim();

async function cittadinanze(): Promise<Map<string, Riga>> {
  const { data, error } = await sb.from("cittadinanze").select("paese, maschile, femminile");
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((c) => [String(c.paese).toLowerCase(), c]));
}

// Controlli sui dati di una persona: restituisce i motivi per cui il certificato non si può scrivere.
function controlli(o: Riga, citt: Map<string, Riga>, conCittadinanza: boolean): string[] {
  const m: string[] = [];
  if (o.sesso !== "M" && o.sesso !== "F") m.push(`manca il sesso nella scheda di ${nominativo(o)}`);
  if (!o.data_nascita) m.push(`manca la data di nascita di ${nominativo(o)}`);
  if (!String(o.nazionalita ?? "").trim()) m.push(`manca la nazionalità di ${nominativo(o)}`);
  else if (conCittadinanza && !citt.get(String(o.nazionalita).trim().toLowerCase())) {
    m.push(`la nazionalità "${o.nazionalita}" non è nella tabella delle cittadinanze`);
  }
  return m;
}

type Esito =
  | { esito: "ok"; ospite_id: string; nominativo: string; nomeFile: string; pdf: Uint8Array; inclusi: string[] }
  | { esito: "incluso"; ospite_id: string; nominativo: string; in: string }
  | { esito: "escluso"; ospite_id: string | null; nominativo: string; motivo: string };

let modello: { base: Uint8Array; timbro: Uint8Array } | null = null;
async function caricaModello() {
  if (modello) return modello;
  const [b, t] = await Promise.all([
    sb.storage.from(BUCKET).download("modello/carta_intestata.pdf"),
    sb.storage.from(BUCKET).download("modello/timbro.png"),
  ]);
  if (b.error || t.error) throw new Error(`modello non trovato: ${(b.error ?? t.error)!.message}`);
  modello = { base: new Uint8Array(await b.data!.arrayBuffer()), timbro: new Uint8Array(await t.data!.arrayBuffer()) };
  return modello;
}

async function generaPerAppuntamento(appId: string): Promise<Esito> {
  const { data: a, error: ea } = await sb.from("appuntamenti_cas")
    .select("id, ospite_id, ospite_nome, data_ora, ora_da_definire, tipo").eq("id", appId).maybeSingle();
  if (ea) throw new Error(ea.message);
  if (!a) return { esito: "escluso", ospite_id: null, nominativo: "", motivo: "appuntamento non trovato" };
  if (!a.ospite_id) return { esito: "escluso", ospite_id: null, nominativo: a.ospite_nome ?? "", motivo: "l'appuntamento non è collegato a un ospite in Approdo" };

  const campi = "id, nome, cognome, sesso, data_nascita, nazionalita, struttura_id, nucleo_familiare, attivo";
  const { data: o, error: eo } = await sb.from("ospiti_cas").select(campi).eq("id", a.ospite_id).maybeSingle();
  if (eo) throw new Error(eo.message);
  if (!o) return { esito: "escluso", ospite_id: a.ospite_id, nominativo: a.ospite_nome ?? "", motivo: "ospite non trovato" };
  const nome = nominativo(o);
  const { data: s } = await sb.from("strutture_cas").select("nome, indirizzo").eq("id", o.struttura_id).maybeSingle();
  if (!s) return { esito: "escluso", ospite_id: o.id, nominativo: nome, motivo: "struttura non indicata nella scheda" };
  if (STRUTTURE_ESCLUSE.includes(String(s.nome).toLowerCase())) return { esito: "escluso", ospite_id: o.id, nominativo: nome, motivo: `struttura ${s.nome}: certificato non previsto` };
  if (!String(s.indirizzo ?? "").trim()) return { esito: "escluso", ospite_id: o.id, nominativo: nome, motivo: `manca l'indirizzo della struttura ${s.nome}` };

  const giorno = isoRoma(new Date(a.data_ora));
  const citt = await cittadinanze();

  // Persone dello stesso nucleo con la Questura lo stesso giorno
  let nucleo: Riga[] = [];
  const chiaveNucleo = String(o.nucleo_familiare ?? "").trim();
  if (chiaveNucleo) {
    const { data: membri } = await sb.from("ospiti_cas").select(campi).eq("nucleo_familiare", chiaveNucleo).eq("attivo", true).neq("id", o.id);
    const ids = (membri ?? []).map((m) => m.id);
    if (ids.length) {
      const { data: app } = await sb.from("appuntamenti_cas").select("ospite_id, data_ora")
        .eq("tipo", "Questura").neq("stato", "Annullato").in("ospite_id", ids);
      const stessoGiorno = new Set((app ?? []).filter((x) => isoRoma(new Date(x.data_ora)) === giorno).map((x) => x.ospite_id));
      nucleo = (membri ?? []).filter((m) => stessoGiorno.has(m.id));
    }
  }
  const minorenne = (p: Riga) => p.data_nascita && eta(p.data_nascita, giorno) < 18;

  // Un minore va nel certificato dell'adulto del nucleo (se c'è); altrimenti non si genera nulla in automatico.
  if (minorenne(o)) {
    const adulti = nucleo.filter((p) => p.data_nascita && !minorenne(p))
      .sort((x, y) => (x.sesso === "F" ? -1 : 0) - (y.sesso === "F" ? -1 : 0));
    if (adulti.length) return { esito: "incluso", ospite_id: o.id, nominativo: nome, in: nominativo(adulti[0]) };
    return { esito: "escluso", ospite_id: o.id, nominativo: nome, motivo: "minorenne senza un adulto del nucleo con l'appuntamento lo stesso giorno: certificato da fare a mano" };
  }

  const minori = nucleo.filter((p) => minorenne(p));
  const motivi = controlli(o, citt, true);
  for (const m of minori) motivi.push(...controlli(m, citt, false));
  if (motivi.length) return { esito: "escluso", ospite_id: o.id, nominativo: nome, motivo: motivi.join("; ") };

  const femmina = o.sesso === "F";
  const c = citt.get(String(o.nazionalita).trim().toLowerCase())!;
  const dt = new Date(a.data_ora);
  const dati: DatiCertificato = {
    femmina,
    nominativo: nome,
    paese: String(o.nazionalita).trim(),
    dataNascita: dataIt(o.data_nascita),
    cittadinanza: femmina ? c.femminile : c.maschile,
    struttura: String(s.nome).trim(),
    indirizzo: String(s.indirizzo).trim().replace(/\s+-\s+/g, ", "),
    appData: dataIt(giorno),
    appOra: a.ora_da_definire ? null : fmtRomaOra.format(dt),
    dataEmissione: dataLettere(giorno), // data di emissione = giorno dell'appuntamento
    minori: minori.map((m) => ({ nominativo: nominativo(m), femmina: m.sesso === "F", paese: String(m.nazionalita).trim(), dataNascita: dataIt(m.data_nascita) })),
  };
  const mod = await caricaModello();
  const pdf = await creaPdf(pdfLib, mod.base, mod.timbro, dati);
  const percorso = `pdf/${o.id}.pdf`;
  const { error: errUp } = await sb.storage.from(BUCKET).upload(percorso, pdf, { contentType: "application/pdf", upsert: true });
  if (errUp) throw new Error(errUp.message);
  const ora = new Date().toISOString();
  const { error: errReg } = await sb.from("certificati_ospitalita").upsert({
    ospite_id: o.id, appuntamento_id: a.id, data_ora_appuntamento: a.data_ora, storage_path: percorso,
    generato_il: ora, problema: null, problema_il: null, aggiornato_il: ora,
  });
  if (errReg) throw new Error(errReg.message);
  return { esito: "ok", ospite_id: o.id, nominativo: nome, nomeFile: `Certificato di ospitalità - ${nome}.pdf`, pdf, inclusi: dati.minori!.map((m) => m.nominativo) };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!(await autorizzato(req))) return new Response("Unauthorized", { status: 401 });
  let body: Riga;
  try { body = await req.json(); } catch { return risposta({ status: "errore", errore: "corpo non valido" }, 400); }
  const azione = String(body.azione ?? "");

  try {
    if (azione === "genera_appuntamento") {
      const e = await generaPerAppuntamento(String(body.appuntamento_id ?? ""));
      if (e.esito === "ok") {
        const out: Riga = { status: "ok", esito: "ok", ospite_id: e.ospite_id, nominativo: e.nominativo, nomeFile: e.nomeFile, inclusi: e.inclusi };
        if (body.anteprima === true) {
          const { data: link } = await sb.storage.from(BUCKET).createSignedUrl(`pdf/${e.ospite_id}.pdf`, 900);
          out.link_anteprima = link?.signedUrl ?? null;
        } else out.pdfBase64 = encodeBase64(e.pdf);
        return risposta(out);
      }
      if (e.esito === "escluso" && e.ospite_id) {
        const ora = new Date().toISOString();
        await sb.from("certificati_ospitalita").upsert({ ospite_id: e.ospite_id, problema: e.motivo, problema_il: ora, aggiornato_il: ora });
      }
      return risposta({ status: "ok", ...e });
    }

    if (azione === "da_salvare") {
      const { data, error } = await sb.from("certificati_ospitalita")
        .select("ospite_id, drive_file_id, generato_il, drive_salvato_il, ospiti_cas(nome, cognome)")
        .not("storage_path", "is", null).not("generato_il", "is", null);
      if (error) throw new Error(error.message);
      const ospiti = (data ?? [])
        .filter((r) => !r.drive_salvato_il || Date.parse(r.drive_salvato_il) < Date.parse(r.generato_il))
        .map((r) => {
          // deno-lint-ignore no-explicit-any
          const o = (r as any).ospiti_cas ?? {};
          return { ospite_id: r.ospite_id, cognome: o.cognome ?? "", nome: o.nome ?? "", cartella: nominativo(o), drive_file_id: r.drive_file_id || null };
        });
      return risposta({ status: "ok", ospiti });
    }

    if (azione === "pdf") {
      const id = String(body.ospite_id ?? "");
      const { data: r } = await sb.from("certificati_ospitalita").select("storage_path, generato_il, ospiti_cas(nome, cognome)").eq("ospite_id", id).maybeSingle();
      if (!r?.storage_path) return risposta({ status: "errore", errore: "certificato non trovato" }, 404);
      const { data: f, error } = await sb.storage.from(BUCKET).download(r.storage_path);
      if (error) throw new Error(error.message);
      // deno-lint-ignore no-explicit-any
      const nome = nominativo((r as any).ospiti_cas ?? {});
      return risposta({ status: "ok", nomeFile: `Certificato di ospitalità - ${nome}.pdf`, generato_il: r.generato_il,
        pdfBase64: encodeBase64(new Uint8Array(await f!.arrayBuffer())) });
    }

    if (azione === "registra") {
      const id = String(body.ospite_id ?? "");
      if (!id) return risposta({ status: "errore", errore: "ospite_id mancante" }, 400);
      const ora = new Date().toISOString();
      if (body.problema) {
        await sb.from("certificati_ospitalita").update({ problema: String(body.problema).slice(0, 500), problema_il: ora, aggiornato_il: ora }).eq("ospite_id", id);
        try { await sb.rpc("registra_automazione", { p_nome: "certificati-ospitalita", p_esito: "errore", p_messaggio: String(body.problema).slice(0, 300) }); } catch { /* */ }
        return risposta({ status: "ok" });
      }
      // Si segna come salvata la versione generata fino a quel momento (generato_il letto prima della copia).
      const salvato = body.generato_il ? String(body.generato_il) : ora;
      const { error } = await sb.from("certificati_ospitalita").update({
        drive_file_id: String(body.drive_file_id ?? ""), drive_url: String(body.drive_url ?? ""),
        drive_salvato_il: salvato, problema: null, problema_il: null, aggiornato_il: ora,
      }).eq("ospite_id", id);
      if (error) throw new Error(error.message);
      try { await sb.rpc("registra_automazione", { p_nome: "certificati-ospitalita", p_esito: "ok", p_evento: false }); } catch { /* */ }
      return risposta({ status: "ok" });
    }

    return risposta({ status: "errore", errore: "azione non valida" }, 400);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    try { await sb.rpc("registra_automazione", { p_nome: "certificati-ospitalita", p_esito: "errore", p_messaggio: msg.slice(0, 300) }); } catch { /* */ }
    return risposta({ status: "errore", errore: msg }, 500);
  }
});

