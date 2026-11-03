import { createClient } from "npm:@supabase/supabase-js@2";
import { type Ospite, ospitiNelTesto } from "./abbina.ts";
import { leggiMail, parteNuova } from "./leggi.ts";
import { esitoAggiornabile, type EsitoRicorso, esitoRicorsoDaMail, testoEsito } from "./ricorso.ts";

// Sincronizzazione delle mail dell'avv. Paola Urbinati (decisione di Massimo, 01/11/2026).
// Lo script Apps Script "Avvocati" (progetto Archivio PEC) manda qui ogni mail nuova dell'avvocata.
// 1) azione "elabora": riconosce l'ospite, legge data e ora dell'udienza, controlla i doppioni
//    e, solo se tutto è certo, segna l'appuntamento in Approdo. Se la mail comunica l'esito di un
//    ricorso (sentenza del Tribunale), aggiorna l'esito nella scheda ospite (decisione del 03/11/2026).
// 2) azione "chiudi": registra sulla scheda i PDF salvati su Drive e manda il riepilogo a Massimo.
// In prova (dryRun) non scrive nulla: dice solo cosa farebbe.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CHIAVE = (Deno.env.get("PEC_SECRET") ?? "").trim();
const EMAIL_MASSIMO = "m.andreoni@coopmetis.com";
const TRATTO = "—"; // usato solo nei titoli degli appuntamenti, come negli altri di Approdo
const AVVOCATI: Record<string, string> = { "avv.paolaurbinati@gmail.com": "URBINATI PAOLA" };
// Tipi di appuntamento che, nello stesso giorno, contano come "già presente".
const TIPI_LEGALI = ["Ricorso", "Avvocato", "Commissione Territoriale", "Altro"];
// Riga del riepilogo con l'esito del ricorso: la azione "chiudi" la ritrova nel registro della mail.
const PREFISSO_ESITO = "Esito del ricorso letto dalla mail: ";

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
const fmtOra = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtRomaCompleto = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
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
function giornoSuccessivo(data: string): string {
  const [a, m, g] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, g + 1)).toISOString().slice(0, 10);
}

async function avvisa(oggetto: string, corpo: string): Promise<number> {
  const html = `<pre style="font-family:Arial,Helvetica,sans-serif;font-size:14px;white-space:pre-wrap">${esc(corpo)}</pre>`;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
      body: JSON.stringify({ to: [EMAIL_MASSIMO], subject: oggetto, html }),
    });
    return res.status;
  } catch {
    return 0;
  }
}

async function traccia(esito: "ok" | "errore", messaggio: string): Promise<void> {
  try {
    await supabase.rpc("registra_automazione", { p_nome: "avvocati-sync", p_esito: esito, p_messaggio: messaggio });
  } catch { /* */ }
}

type OspiteDesc = { id: string; cognome: string; nome: string; struttura_id: string | null; data_nascita: string | null; attivo: boolean };
const descrivi = (o: Ospite): OspiteDesc => ({
  id: o.id, cognome: o.cognome ?? "", nome: o.nome ?? "", struttura_id: o.struttura_id, data_nascita: o.data_nascita, attivo: o.attivo !== false,
});
const nomeApprodo = (o: OspiteDesc) => `${o.cognome} ${o.nome}`.trim();
const persona = (o: OspiteDesc) => `${o.cognome.toUpperCase()} ${o.nome}`.trim();

// Appuntamenti legali dello stesso ospite nello stesso giorno, chiunque li abbia inseriti.
async function stessoGiorno(o: OspiteDesc, data: string) {
  const nome = nomeApprodo(o).replace(/[,()]/g, " ");
  const { data: righe, error } = await supabase
    .from("appuntamenti_cas")
    .select("id, tipo, titolo, data_ora, stato, operatore_accompagnatore")
    .or(`ospite_id.eq.${o.id},ospite_nome.ilike.${nome}`)
    .gte("data_ora", romaInUtc(data, "00:00"))
    .lt("data_ora", romaInUtc(giornoSuccessivo(data), "00:00"));
  if (error) throw new Error(error.message);
  return (righe ?? []).filter((r) => TIPI_LEGALI.includes(String(r.tipo)));
}

function descriviRicorso(r: EsitoRicorso): string {
  if (r.esito === "rigettato") return "Ricorso rigettato";
  return `Ricorso accolto${r.protezione ? `: riconosciuta ${r.protezione === "status di rifugiato" ? "lo status di rifugiato" : "la " + r.protezione}` : ""}`;
}

// Esito del ricorso nella scheda ospite: si scrive solo se il campo è vuoto, "Diniego" o
// "Commissione sostenuta"; mai sopra un esito diverso. Restituisce le righe per il riepilogo.
async function aggiornaEsitoRicorso(o: OspiteDesc, r: EsitoRicorso, prova: boolean): Promise<string[]> {
  const nuovo = testoEsito(r);
  const righe = [`${PREFISSO_ESITO}${descriviRicorso(r)}.`, `Frase della mail: "${r.frase}"`];
  try {
    const { data, error } = await supabase.from("ospiti_cas").select("esito_audizione").eq("id", o.id).single();
    if (error) return [...righe, `Esito NON aggiornato nella scheda per un errore tecnico (${error.message}).`];
    const attuale = (data?.esito_audizione as string | null) ?? null;
    if ((attuale ?? "").trim() === nuovo) return [...righe, `Nella scheda l'esito era già "${nuovo}".`];
    if (!esitoAggiornabile(attuale)) {
      return [...righe, `Esito NON aggiornato nella scheda: c'è già "${attuale}". Verificare a mano.`];
    }
    if (prova) return [...righe, `(prova: nella scheda l'esito diventerebbe "${nuovo}")`];
    const { error: e2 } = await supabase.from("ospiti_cas")
      .update({ esito_audizione: nuovo, ricorso: true, updated_at: new Date().toISOString() }).eq("id", o.id);
    if (e2) {
      await traccia("errore", `esito ricorso non scritto: ${e2.message}`);
      return [...righe, `Esito NON aggiornato nella scheda per un errore tecnico (${e2.message}).`];
    }
    return [...righe, `Esito aggiornato automaticamente nella scheda: "${nuovo}" (prima: "${attuale ?? "vuoto"}"). Controllare sulla sentenza.`];
  } catch (e) {
    return [...righe, `Esito NON aggiornato nella scheda per un errore (${String((e as Error)?.message ?? e)}).`];
  }
}

const MOTIVI: Record<string, string> = {
  manca_ora: "nella mail c'è la data ma non l'orario",
  manca_data: "nella mail non ho trovato una data futura",
  piu_date: "nella mail ci sono più date e non so quale sia quella dell'appuntamento",
  piu_ore: "nella mail ci sono più orari e non so quale sia quello dell'appuntamento",
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (CHIAVE.length < 32) return risposta({ status: "errore", errore: "chiave PEC_SECRET non configurata" }, 500);
  if ((req.headers.get("Authorization") || "") !== `Bearer ${CHIAVE}`) return new Response("Unauthorized", { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Corpo non valido", { status: 400 });
  }
  const azione = testo(body.azione);
  const prova = body.dryRun === true;
  const messageId = testo(body.messageId);
  if (!messageId) return risposta({ status: "errore", errore: "messageId mancante" }, 400);

  // ---------------- 1) elabora ----------------
  if (azione === "elabora") {
    // Doppione 1: la stessa mail non si elabora due volte.
    if (!prova) {
      const { data: gia } = await supabase.from("avvocati_mail").select("id").eq("gmail_message_id", messageId).limit(1);
      if ((gia ?? []).length) return risposta({ status: "ok", esito: "gia_elaborata" });
    }
    const oggetto = testo(body.oggetto);
    const mittente = testo(body.mittente).toLowerCase();
    const avvocato = Object.entries(AVVOCATI).find(([m]) => mittente.includes(m))?.[1] ?? null;
    const dataMail = new Date(testo(body.dataMail) || Date.now());
    const giornoMail = fmtRoma.format(dataMail);
    const nuova = parteNuova(testo(body.corpo), oggetto);
    const allegati = Array.isArray(body.allegati) ? (body.allegati as string[]).map(String) : [];
    const lettura = leggiMail(nuova, giornoMail);

    const { data: ospitiDb, error } = await supabase.from("ospiti_cas").select("id, nome, cognome, data_nascita, struttura_id, attivo");
    if (error) return risposta({ status: "errore", errore: error.message }, 500);
    let trovati = ospitiNelTesto(oggetto, (ospitiDb ?? []) as Ospite[]);
    if (trovati.length === 0) trovati = ospitiNelTesto(nuova, (ospitiDb ?? []) as Ospite[]);
    const ospite = trovati.length === 1 ? descrivi(trovati[0]) : null;

    const righe: string[] = [];
    let esito = "nessuna_azione";
    let appuntamentoId: string | null = null;
    const intestazione = `Mail dell'avv. ${avvocato ?? mittente} del ${dataIt(giornoMail)} ${fmtOra.format(dataMail)}.\nOggetto: ${oggetto}`;

    // Esito di un ricorso comunicato nella mail (sentenza del Tribunale).
    const ricorso = esitoRicorsoDaMail(nuova);
    let righeRicorso: string[] = [];
    if (ricorso && ospite) {
      righeRicorso = await aggiornaEsitoRicorso(ospite, ricorso, prova);
    } else if (ricorso && !ospite) {
      righeRicorso = [`${PREFISSO_ESITO}${descriviRicorso(ricorso)}.`, "NON aggiornato in Approdo: non so a quale ospite si riferisce."];
    }

    if (!ospite) {
      esito = trovati.length > 1 ? "ospite_ambiguo" : "ospite_non_trovato";
      righe.push(trovati.length > 1
        ? `Nell'oggetto compaiono più ospiti di Approdo (${trovati.map((t) => `${t.cognome} ${t.nome}`).join(", ")}): non so a chi riferirla.`
        : "Non ho riconosciuto nessun ospite di Approdo nell'oggetto né nel testo.");
      if (lettura.esito !== "nessun_evento") righe.push("NON ho segnato nulla in Approdo.");
    } else if (lettura.esito === "pronto" && lettura.data! < fmtRoma.format(new Date())) {
      esito = "data_passata";
      righe.push(`La mail indica il ${dataIt(lettura.data)} alle ${lettura.ora}, data già passata: NON l'ho segnato in Approdo.`);
    } else if (lettura.esito === "pronto") {
      const data = lettura.data!, ora = lettura.ora!;
      const esistenti = await stessoGiorno(ospite, data);
      const stessaOra = esistenti.find((a) => fmtOra.format(new Date(a.data_ora as string)) === ora);
      if (stessaOra) {
        esito = "gia_presente";
        appuntamentoId = stessaOra.id as string;
        righe.push(`${lettura.tipo === "Ricorso" ? "Udienza" : "Appuntamento"} del ${dataIt(data)} alle ${ora}: già presente in Approdo ("${stessaOra.titolo}"). Non l'ho inserito di nuovo.`);
      } else if (esistenti.length) {
        esito = "orario_diverso";
        appuntamentoId = esistenti[0].id as string;
        righe.push(
          `La mail indica il ${dataIt(data)} alle ${ora}, ma in Approdo per quel giorno c'è già:`,
          ...esistenti.map((a) => `- ${a.titolo}, ore ${fmtOra.format(new Date(a.data_ora as string))} (${a.stato})`),
          "NON ho modificato nulla: controlla quale orario è giusto.",
        );
      } else if (prova) {
        esito = "da_inserire";
        righe.push(`Verrebbe segnato in Approdo: ${lettura.tipo} il ${dataIt(data)} alle ${ora}.`);
      } else {
        const bologna = /bologna/i.test(nuova) ? " Bologna" : "";
        const titolo = lettura.tipo === "Ricorso"
          ? `Udienza Tribunale${bologna} ${TRATTO} ${nomeApprodo(ospite)}`
          : `Avv. ${avvocato ? avvocato.split(" ")[0].charAt(0) + avvocato.split(" ")[0].slice(1).toLowerCase() : ""} ${TRATTO} ${nomeApprodo(ospite)}`;
        const { data: creato, error: e2 } = await supabase.from("appuntamenti_cas").insert({
          struttura_id: ospite.struttura_id,
          ospite_id: ospite.id,
          ospite_nome: nomeApprodo(ospite),
          titolo,
          tipo: lettura.tipo,
          data_ora: romaInUtc(data, ora),
          stato: "Da svolgere",
          nome_avvocato: avvocato,
          ora_da_definire: false,
          note: `Letto automaticamente dalla mail dell'avv. ${avvocato ?? mittente} del ${dataIt(giornoMail)} (oggetto: ${oggetto}). ` +
            `Testo della mail: "${(lettura.frase ?? "").slice(0, 400)}". Accompagnatore da definire. [avvocati-sync:${messageId}]`,
        }).select("id").single();
        if (e2) {
          esito = "errore";
          righe.push(`NON segnato in Approdo per un errore tecnico (${e2.message}).`);
          await traccia("errore", `inserimento non riuscito: ${e2.message}`);
        } else {
          esito = "inserito";
          appuntamentoId = creato.id as string;
          righe.push(`Segnato in Approdo: ${lettura.tipo} il ${dataIt(data)} alle ${ora}. Accompagnatore da assegnare.`);
        }
      }
      righe.push(`Testo della mail: "${lettura.frase ?? ""}"`);
    } else if (lettura.esito !== "nessun_evento") {
      esito = "da_verificare";
      righe.push(
        `Per ${persona(ospite)} la mail parla di un appuntamento, ma ${MOTIVI[lettura.esito]}. NON ho segnato nulla in Approdo.`,
        lettura.frase ? `Testo della mail: "${lettura.frase}"` : "",
      );
      if (lettura.data) {
        const esistenti = await stessoGiorno(ospite, lettura.data);
        righe.push(esistenti.length
          ? `In Approdo per il ${dataIt(lettura.data)} c'è già: ${esistenti.map((a) => `${a.titolo}, ore ${fmtOra.format(new Date(a.data_ora as string))}`).join("; ")}.`
          : `In Approdo per il ${dataIt(lettura.data)} non c'è nulla per questo ospite.`);
      }
    }
    if (righeRicorso.length) righe.push(...(righe.length ? [""] : []), ...righeRicorso);

    // Si avvisa Massimo solo se c'è qualcosa da sapere: un appuntamento, un esito, un problema o allegati.
    const daAvvisare = esito !== "nessuna_azione" || allegati.length > 0 || righeRicorso.length > 0;
    if (!prova) {
      const { error: e3 } = await supabase.from("avvocati_mail").insert({
        gmail_message_id: messageId,
        thread_id: testo(body.threadId) || null,
        mittente,
        oggetto,
        data_mail: dataMail.toISOString(),
        ospite_id: ospite?.id ?? null,
        esito,
        appuntamento_id: appuntamentoId,
        dettaglio: righe.filter(Boolean).join("\n"),
      });
      if (e3 && e3.code === "23505") return risposta({ status: "ok", esito: "gia_elaborata" });
      if (e3) await traccia("errore", `registro mail non scritto: ${e3.message}`);
    }
    return risposta({
      status: "ok", esito, prova, daAvvisare,
      ospite, appuntamentoId,
      lettura: { esito: lettura.esito, tipo: lettura.tipo, data: lettura.data, ora: lettura.ora },
      esitoRicorso: ricorso ? { esito: ricorso.esito, protezione: ricorso.protezione } : null,
      intestazione, righe: righe.filter(Boolean),
    });
  }

  // ---------------- 2) chiudi: allegati e riepilogo ----------------
  if (azione === "chiudi") {
    const ospite = (body.ospite ?? null) as OspiteDesc | null;
    const file = (Array.isArray(body.file) ? body.file : []) as { nome: string; link: string; nuovo: boolean }[];
    const righe = (Array.isArray(body.righe) ? body.righe : []).map(String);
    const intestazione = testo(body.intestazione);
    const oggettoMail = testo(body.oggetto);
    const appuntamentoId = testo(body.appuntamentoId) || null;
    const problemaCartella = testo(body.problemaCartella);
    const nonSalvati = (Array.isArray(body.nonSalvati) ? body.nonSalvati : []).map(String);
    // Esito del ricorso letto dalla mail (azione "elabora"), da scrivere sull'atto del Tribunale.
    const rigaEsito = righe.find((r) => r.startsWith(PREFISSO_ESITO));
    const decisioneMail = rigaEsito
      ? `${rigaEsito.slice(PREFISSO_ESITO.length).replace(/\.$/, "")} (letto dalla mail dell'avvocata)`
      : null;

    const allegatiRighe: string[] = [];
    for (const f of file) {
      const nome = f.nome.toLowerCase();
      // Ogni PDF dell'avvocata va collegato alla scheda dell'ospite (decisione di Massimo, 03/11/2026):
      // le convocazioni riconoscibili dal nome come convocazione, tutti gli altri come atto del Tribunale.
      // Gli allegati che non sono PDF (immagini, documenti Word) restano solo su Drive.
      const tipo = /udienz|audizion|fissazion|rinvio|convoc/.test(nome) ? "convocazione"
        : /\.pdf$/.test(nome) ? "decreto_tribunale" : null;
      let nota = f.nuovo ? "salvato" : "era già presente, non duplicato";
      if (!prova && ospite && tipo) {
        const { error } = await supabase.from("pec_atti").insert({
          ospite_id: ospite.id, struttura_id: ospite.struttura_id, tipo_atto: tipo,
          data_pec: testo(body.dataMail).slice(0, 10) || null, oggetto_pec: `${oggettoMail} (mail avv. Urbinati)`,
          link_documento: f.link, appuntamento_id: tipo === "convocazione" ? appuntamentoId : null,
          decisione: tipo === "decreto_tribunale" ? decisioneMail : null,
          stato: "archiviata", origine: "automatica",
        });
        if (!error) nota += ", collegato alla scheda dell'ospite";
        else if (error.code !== "23505") nota += `, collegamento non riuscito (${error.message})`;
      } else if (!tipo) {
        nota += ", non collegato alla scheda (non è un PDF)";
      }
      allegatiRighe.push(`- ${f.nome}: ${prova ? "verrebbe salvato nella cartella Giuridico" : nota}${f.link ? "\n  " + f.link : ""}`);
    }
    for (const n of nonSalvati) allegatiRighe.push(`- ${n}: NON salvato. ${problemaCartella || ""}`.trim());

    const corpo = [
      prova ? "PROVA: nulla è stato scritto in Approdo né su Drive.\n" : "",
      intestazione, "", ...righe,
      ...(allegatiRighe.length ? ["", "Allegati:", ...allegatiRighe] : []),
    ].filter((r, i, a) => !(r === "" && a[i - 1] === "")).join("\n");
    const ospiteTxt = ospite ? persona(ospite) : "ospite non riconosciuto";
    const oggettoAvviso = decisioneMail
      ? `Approdo${prova ? " (prova)" : ""}: esito ricorso, ${ospiteTxt}`
      : `Approdo${prova ? " (prova)" : ""}: mail avv. Urbinati, ${ospiteTxt}`;
    const stato = await avvisa(oggettoAvviso, corpo);
    if (stato !== 200) await traccia("errore", `riepilogo non inviato (stato ${stato}): ${oggettoMail}`);
    return risposta({ status: "ok", inviato: stato === 200 });
  }

  return new Response("azione non valida", { status: 400 });
});
