import { createClient } from "npm:@supabase/supabase-js@2";
import { extractText, getDocumentProxy } from "npm:unpdf@0.12.1";
import { type Ospite } from "./logic.ts";
import { NOMI_ATTO, ospitiNelTesto, type TipoAtto, tipoAtto } from "./atti.ts";
import { frasiConTermini, leggiConvocazione, leggiDecreto } from "./estrai.ts";
import { chiaveUsata, chiaviConfigurate } from "./chiave.ts";
import { registraAtto, rigaAtto } from "./registro.ts";

// Archiviazione PEC. Lo script Apps Script legge le PEC inoltrate e salva i PDF su Drive;
// questa funzione riconosce atto e ospite, legge il PDF, segna le convocazioni in Approdo
// e manda gli avvisi (Resend, via send-email).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EMAIL_MASSIMO = "m.andreoni@coopmetis.com";
// Co-referenti in più, per nome del responsabile della struttura (decisione di Massimo).
const CO_REFERENTI: Record<string, string[]> = { james: ["m.bylyshi@coopmetis.com"] };
const TRATTO = "—";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function risposta(corpo: unknown, stato = 200): Response {
  return new Response(JSON.stringify(corpo), { status: stato, headers: { "Content-Type": "application/json" } });
}
function testo(v: unknown): string {
  return String(v ?? "").trim();
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function dataIt(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "non indicata";
}

const fmtRoma = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" });
const fmtRomaCompleto = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
function dataLocale(iso: string): string {
  return fmtRoma.format(new Date(iso));
}
function romaInUtc(data: string, hhmm: string): string {
  const [a, m, g] = data.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const nominale = Date.UTC(a, m - 1, g, h, mi);
  let ts = nominale;
  for (let i = 0; i < 3; i++) {
    const p = fmtRomaCompleto.formatToParts(new Date(ts));
    const v = (t: string) => Number(p.find((x) => x.type === t)!.value);
    const anticipo = (Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second")) - ts) / 60000;
    ts = nominale - Math.round(anticipo) * 60000;
  }
  return new Date(ts).toISOString();
}

async function avvisa(to: string[], oggetto: string, corpo: string, link?: string): Promise<number> {
  const html = `<pre style="font-family:Arial,Helvetica,sans-serif;font-size:14px;white-space:pre-wrap">${esc(corpo)}</pre>` +
    (link ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px"><a href="${esc(link)}">Apri il documento su Drive</a></p>` : "");
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ to: [...new Set(to)], subject: oggetto, html }),
    });
    return res.status;
  } catch (_e) {
    return 0;
  }
}

type Struttura = { id: string; nome: string; responsabile: string | null };

async function educatoriStruttura(s: Struttura | null | undefined): Promise<string[]> {
  if (!s?.responsabile) return [];
  const nome = s.responsabile.trim();
  const { data } = await supabase.from("utenti").select("email, nome").ilike("nome", nome);
  const email = (data ?? []).map((u) => String(u.email ?? "")).filter((e) => e.includes("@"));
  return [...email, ...(CO_REFERENTI[nome.toLowerCase()] ?? [])];
}

async function testoPdf(base64: string): Promise<string> {
  if (!base64) return "";
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const { text } = await extractText(await getDocumentProxy(bytes), { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : String(text ?? "");
  } catch (_e) {
    return "";
  }
}

// Riga dell'oggetto da usare nella risposta di avvenuta consegna, come indicata nella PEC.
function rigaConsegna(corpoPec: string): string {
  return (corpoPec.match(/OGGETTO:\s*([^\n]*Avvenuta[^\n]*(?:\n\s+[^\n]+)?)/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
}

type OspiteDesc = { id: string; cognome: string; nome: string; cartella: string; data_nascita: string | null; attivo: boolean; struttura: string | null; struttura_id: string | null };

// Segna in Approdo l'audizione letta dalla convocazione, senza doppioni.
// Restituisce il messaggio per la mail e l'id dell'appuntamento creato o già presente per quel giorno.
// In prova non scrive nulla: fa solo i controlli e trova l'appuntamento eventualmente già presente.
type Audizione = { testo: string; id: string | null };
async function segnaAudizione(o: OspiteDesc, data: string, ora: string, rn: string, dataPec: string, prova = false): Promise<Audizione> {
  const oggi = fmtRoma.format(new Date());
  if (data < oggi) return { testo: `NON segnata in Approdo: la data letta (${dataIt(data)}) è già passata.`, id: null };
  const nomeApprodo = `${o.cognome} ${o.nome}`.trim();
  const { data: esistenti, error } = await supabase
    .from("appuntamenti_cas")
    .select("id, data_ora, stato, ospite_id, ospite_nome")
    .eq("tipo", "Commissione Territoriale")
    .or(`ospite_id.eq.${o.id},ospite_nome.ilike.${nomeApprodo.replace(/[,()]/g, " ")}`);
  if (error) return { testo: `NON segnata in Approdo per un errore tecnico (${error.message}).`, id: null };
  const stessa = (esistenti ?? []).find((a) => dataLocale(a.data_ora as string) === data);
  if (stessa) return { testo: `Già presente in Approdo per il ${dataIt(data)}: non l'ho inserita di nuovo.`, id: stessa.id as string };
  const altre = (esistenti ?? []).filter((a) => a.stato === "Da svolgere" && dataLocale(a.data_ora as string) >= oggi);
  if (altre.length > 0) {
    const elenco = altre.map((a) => dataIt(dataLocale(a.data_ora as string))).join(", ");
    return { testo: `NON segnata in Approdo: c'è già un'audizione aperta il ${elenco}. Massimo decide quale tenere.`, id: null };
  }
  if (prova) return { testo: `Verrebbe segnata in Approdo: Commissione Territoriale il ${dataIt(data)} alle ${ora}.`, id: null };
  const { data: creato, error: errIns } = await supabase.from("appuntamenti_cas").insert({
    struttura_id: o.struttura_id,
    ospite_id: o.id,
    ospite_nome: nomeApprodo,
    titolo: `Commissione ${TRATTO} ${nomeApprodo}`,
    tipo: "Commissione Territoriale",
    data_ora: romaInUtc(data, ora),
    stato: "Da svolgere",
    note: `${rn ? rn + ". " : ""}Convocazione letta automaticamente dalla PEC del ${dataPec || "data non indicata"}. [pec-archivio]`,
  }).select("id").single();
  if (errIns) return { testo: `NON segnata in Approdo per un errore tecnico (${errIns.message}).`, id: null };
  return { testo: `Segnata in Approdo: Commissione Territoriale il ${dataIt(data)} alle ${ora}.`, id: creato.id as string };
}

// Annullamenti: si elencano le audizioni in Commissione ancora aperte dell'ospite, senza toccarle.
async function righeAnnullamento(o: OspiteDesc | null): Promise<string[]> {
  const intro = "In Approdo NON ho modificato nessun appuntamento.";
  if (!o?.id) return [intro];
  const { data, error } = await supabase
    .from("appuntamenti_cas")
    .select("data_ora, stato")
    .eq("tipo", "Commissione Territoriale")
    .eq("ospite_id", o.id)
    .eq("stato", "Da svolgere");
  if (error) return [intro, `Non sono riuscito a controllare le audizioni aperte (${error.message}).`];
  const oggi = fmtRoma.format(new Date());
  const date = (data ?? []).map((a) => dataLocale(a.data_ora as string)).filter((d) => d >= oggi).sort().map(dataIt);
  return date.length
    ? [intro, `Audizioni in Commissione ancora aperte per questo ospite: ${date.join(", ")}.`, "Cosa fare: verificare quale audizione è annullata e aggiornarla a mano in Approdo."]
    : [intro, "Per questo ospite non risultano audizioni in Commissione aperte in Approdo."];
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!chiaviConfigurate) return risposta({ status: "errore", errore: "chiave PEC_SECRET non configurata nei segreti di Supabase" }, 500);
  if (!chiaveUsata(req)) return new Response("Unauthorized", { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Corpo non valido", { status: 400 });
  }
  const azione = testo(body.azione);
  const oggetto = testo(body.oggetto);
  const prova = body.dryRun === true;

  const { data: ospitiDb, error } = await supabase
    .from("ospiti_cas")
    .select("id, nome, cognome, data_nascita, struttura_id, attivo");
  if (error) return risposta({ status: "errore", errore: error.message }, 500);
  const { data: struttureDb } = await supabase.from("strutture_cas").select("id, nome, responsabile");
  const strutture = new Map<string, Struttura>((struttureDb ?? []).map((s) => [s.id as string, s as Struttura]));
  const descrivi = (o: Ospite): OspiteDesc => ({
    id: o.id,
    cognome: o.cognome ?? "",
    nome: o.nome ?? "",
    cartella: `${(o.cognome ?? "").toUpperCase()} ${o.nome ?? ""}`.trim(),
    data_nascita: o.data_nascita,
    attivo: o.attivo !== false,
    struttura: o.struttura_id ? strutture.get(o.struttura_id)?.nome ?? null : null,
    struttura_id: o.struttura_id,
  });

  // 0) elenco degli ospiti attivi, per il riordino delle cartelle su Drive
  if (azione === "ospiti") {
    const attivi = ((ospitiDb ?? []) as Ospite[]).filter((o) => o.attivo !== false).map(descrivi);
    return risposta({ status: "ok", ospiti: attivi });
  }

  // 1) abbinamento: tipo di atto e ospite
  if (azione === "abbina") {
    const tipo: TipoAtto = tipoAtto(oggetto);
    if (tipo === "altro") return risposta({ status: "ok", tipo, esito: "ignorato" });
    const trovati = ospitiNelTesto(oggetto, (ospitiDb ?? []) as Ospite[]);
    const rn = /\bRN\d{5,}\b/.exec(oggetto)?.[0] ?? "";
    if (trovati.length === 1) {
      return risposta({ status: "ok", tipo, nomeAtto: NOMI_ATTO[tipo], esito: "trovato", rn, chiave: rn ? `${rn}|${tipo}` : "", ospite: descrivi(trovati[0]) });
    }
    return risposta({
      status: "ok", tipo, nomeAtto: NOMI_ATTO[tipo], rn,
      esito: trovati.length === 0 ? "non_trovato" : "ambiguo",
      candidati: trovati.slice(0, 5).map(descrivi),
    });
  }

  // 2) atto archiviato: lettura del PDF, audizione in Approdo, avviso a Massimo + educatori
  if (azione === "elabora") {
    const tipo = testo(body.tipo) as TipoAtto;
    const o = body.ospite as OspiteDesc;
    const link = testo(body.link);
    const dataPec = testo(body.dataPec);
    const corpoPec = testo(body.corpoPec);
    const rn = testo(body.rn);
    const persona = `${o.cognome.toUpperCase()} ${o.nome}`;
    const contenuto = await testoPdf(testo(body.pdfBase64));
    const s = (struttureDb ?? []).find((x) => x.nome === o.struttura) as Struttura | undefined;
    // Annullamenti: avviso solo a Massimo (decisione di Massimo, 14/10/2026)
    const to = tipo === "annullamento" ? [EMAIL_MASSIMO] : [EMAIL_MASSIMO, ...(await educatoriStruttura(s))];
    const consegna = rigaConsegna(corpoPec);
    const nonLetto = "Non sono riuscito a leggerlo automaticamente dal documento: aprire il PDF.";

    let oggettoMail = "";
    const righe: string[] = [];
    // Dati letti dal PDF, per la riga in pec_atti
    const letto: { decisione?: string | null; procedura?: string | null; dataAudizione?: string | null; oraAudizione?: string | null; appuntamentoId?: string | null; esitoApprodoProva?: string } = {};
    if (tipo === "decreto_commissione") {
      const d = leggiDecreto(contenuto);
      letto.decisione = d.decisione;
      letto.procedura = d.procedura;
      oggettoMail = `Approdo: decreto Commissione da consegnare: ${persona}`;
      righe.push(
        `È arrivato il decreto della Commissione Territoriale per ${persona} (${o.struttura ?? "struttura non indicata"}). PEC del ${dataPec}.`,
        "",
        "Decisione (testo del decreto):",
        d.decisione ? `"DECIDE ${d.decisione}"` : nonLetto,
        "",
        "Procedura (testo del decreto):",
        d.procedura ? `"${d.procedura}"` : nonLetto,
        "",
        "Termine per il ricorso: il decreto riporta termini diversi a seconda della procedura. Verificare il termine nel documento e con l'avvocato.",
      );
    } else if (tipo === "convocazione") {
      const c = leggiConvocazione(contenuto);
      oggettoMail = `Approdo: convocazione in Commissione da consegnare: ${persona}`;
      const audizione = c ? await segnaAudizione(o, c.data, c.ora, rn, dataPec, prova) : null;
      const esitoApprodo = c
        ? (prova ? `(prova: in Approdo verrebbe controllata e segnata l'audizione del ${dataIt(c.data)} alle ${c.ora})` : audizione!.testo)
        : "NON segnata in Approdo: data e ora non lette dal documento.";
      if (c) {
        letto.dataAudizione = c.data;
        letto.oraAudizione = c.ora;
        letto.appuntamentoId = audizione!.id;
        if (prova) letto.esitoApprodoProva = audizione!.testo;
      }
      righe.push(
        `È arrivata la convocazione in audizione per ${persona} (${o.struttura ?? "struttura non indicata"}). PEC del ${dataPec}.`,
        "",
        c ? `Audizione: ${dataIt(c.data)} alle ore ${c.ora}` : "Audizione: " + nonLetto,
        c ? `Luogo: ${c.luogo}` : "",
        c ? `Testo della lettera: "${c.frase}"` : "",
        c ? "Data letta automaticamente dalla lettera: controllare sul documento." : "",
        "",
        esitoApprodo,
      );
    } else if (tipo === "annullamento") {
      oggettoMail = `Approdo: annullamento convocazione in Commissione: ${persona}`;
      righe.push(
        `È arrivato l'annullamento della convocazione in audizione per ${persona} (${o.struttura ?? "struttura non indicata"}). PEC del ${dataPec}.`,
        `Oggetto della PEC: ${oggetto || "non indicato"}`,
        "",
        ...(await righeAnnullamento(o)),
      );
    } else {
      const frasi = frasiConTermini(contenuto);
      oggettoMail = `Approdo: ${NOMI_ATTO[tipo].toLowerCase()}: ${persona}`;
      righe.push(
        `È arrivata una comunicazione di ${NOMI_ATTO[tipo].toLowerCase()} per ${persona} (${o.struttura ?? "struttura non indicata"}). PEC del ${dataPec}.`,
        "",
        frasi.length ? "Termini indicati nell'atto (testo del documento):" : "Termini: nel documento non ho trovato frasi con \"entro … giorni\". Leggere il PDF.",
        ...frasi.map((f) => `- "${f}"`),
      );
    }

    if (tipo === "decreto_commissione" || tipo === "convocazione") {
      righe.push(
        "",
        "Cosa fare:",
        `1. Consegnare ${tipo === "convocazione" ? "la lettera di convocazione" : "il decreto"} all'ospite e fargli firmare la ricevuta.`,
        "2. Rispondere alla Commissione via PEC (notificherifugiati.fc@pec.interno.it) allegando la copia firmata.",
        consegna ? `   Oggetto da usare: ${consegna}` : "   L'oggetto da usare è indicato nel testo della PEC.",
        "3. Se l'ospite rifiuta, è irreperibile o è stato trasferito, la risposta va fatta con l'oggetto corrispondente indicato nella PEC.",
      );
    }
    righe.push("", "Il documento è già salvato nella cartella dell'ospite su Drive.");
    const corpo = righe.filter((r, i, a) => !(r === "" && a[i - 1] === "")).join("\n");

    const riga = rigaAtto({
      tipo, ospite: o, rn, oggetto, dataPec, link,
      decisione: letto.decisione, procedura: letto.procedura,
      dataAudizione: letto.dataAudizione, oraAudizione: letto.oraAudizione, appuntamentoId: letto.appuntamentoId,
    });
    if (prova) {
      return risposta({
        status: "ok", dryRun: true, to, oggetto: oggettoMail, corpo, caratteriLetti: contenuto.length,
        ...(letto.esitoApprodoProva ? { esitoApprodo: letto.esitoApprodoProva } : {}),
        rigaPecAtti: riga,
      });
    }
    const stato = await avvisa(to, oggettoMail, corpo, link);
    const registro = await registraAtto(supabase, riga);
    return risposta({ status: "ok", inviato: stato === 200, destinatari: to, registro });
  }

  // 3) problema: avviso solo a Massimo
  if (azione === "problema") {
    const esito = testo(body.esito); // non_trovato | ambiguo | cartella_mancante | senza_pdf
    const tipo = testo(body.tipo) as TipoAtto;
    const nomeAtto = NOMI_ATTO[tipo] ?? "Atto";
    const o = (body.ospite ?? null) as OspiteDesc | null;
    const persona = o ? `${o.cognome.toUpperCase()} ${o.nome}` : "";
    // Gli annullamenti di solito arrivano senza PDF: non è un problema, si avvisa Massimo e si registra l'atto.
    if (tipo === "annullamento" && esito === "senza_pdf" && o) {
      const corpoAnn = [
        `È arrivato l'annullamento della convocazione in audizione per ${persona} (${o.struttura ?? "struttura non indicata"}). PEC del ${testo(body.dataPec) || "data non indicata"}.`,
        `Oggetto della PEC: ${oggetto || "non indicato"}`,
        "La PEC non ha un PDF allegato: non c'è nulla da salvare su Drive.",
        "",
        ...(await righeAnnullamento(o)),
      ].join("\n");
      const rigaAnn = rigaAtto({ tipo, ospite: o, rn: testo(body.rn), oggetto, dataPec: testo(body.dataPec) });
      if (prova) return risposta({ status: "ok", dryRun: true, to: [EMAIL_MASSIMO], corpo: corpoAnn, rigaPecAtti: rigaAnn });
      const statoAnn = await avvisa([EMAIL_MASSIMO], `Approdo: annullamento convocazione in Commissione: ${persona}`, corpoAnn);
      const registroAnn = await registraAtto(supabase, rigaAnn);
      return risposta({ status: "ok", inviato: statoAnn === 200, registro: registroAnn });
    }
    const motivi: Record<string, string> = {
      non_trovato: "Nell'oggetto della PEC non ho riconosciuto nessun ospite di Approdo.",
      ambiguo: "Nell'oggetto della PEC compaiono nomi che corrispondono a più ospiti di Approdo, quindi non so a chi assegnarla.",
      cartella_mancante: `Ho riconosciuto l'ospite ${persona}, ma su Drive non ho trovato la sua cartella né in "Utenti presenti" né in "Utenti usciti".`,
      senza_pdf: `Ho riconosciuto l'ospite ${persona}, ma la mail non ha un PDF allegato da archiviare.`,
    };
    const corpo = [
      `${motivi[esito] ?? "Non sono riuscito ad archiviare la PEC."} Per questo NON l'ho archiviata.`,
      "",
      `Atto: ${nomeAtto}`,
      `Oggetto della mail: ${oggetto}`,
      `Data: ${testo(body.dataPec) || "non indicata"}`,
      ...(Array.isArray(body.candidati) && body.candidati.length
        ? ["", "Ospiti possibili:", ...(body.candidati as OspiteDesc[]).map((c) => `- ${c.cartella}, ${c.struttura ?? "struttura non indicata"}, nato il ${dataIt(c.data_nascita)}`)]
        : []),
      "",
      "Cosa fare: salvare a mano il documento nella cartella dell'ospite. La mail in Gmail ha l'etichetta \"PEC da verificare\".",
    ].join("\n");
    const riga = rigaAtto({ tipo, ospite: o, rn: testo(body.rn), oggetto, dataPec: testo(body.dataPec), motivo: esito || "non_trovato" });
    if (prova) return risposta({ status: "ok", dryRun: true, to: [EMAIL_MASSIMO], corpo, rigaPecAtti: riga });
    const stato = await avvisa([EMAIL_MASSIMO], `Approdo: PEC non archiviata, da verificare: ${nomeAtto}${persona ? " " + persona : ""}`, corpo);
    const registro = await registraAtto(supabase, riga);
    return risposta({ status: "ok", inviato: stato === 200, registro });
  }

  return new Response("azione non valida", { status: 400 });
});
