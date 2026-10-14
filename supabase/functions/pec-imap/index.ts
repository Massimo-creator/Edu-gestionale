import { createClient } from "npm:@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1.0.164";
import { apriPec } from "./pec.ts";
import { oggettoDaIntestazioni } from "./oggetto.ts";
import { scaricaSorgente } from "./grezzo.ts";
import { chiaveUsata, chiaviConfigurate } from "./chiave.ts";

// Lettura della casella PEC Aruba in SOLA LETTURA: la casella viene aperta con EXAMINE,
// quindi nessun messaggio viene segnato come letto, spostato o cancellato.
// Le credenziali stanno nei segreti di Supabase (PEC_PROFUGHI_PASSWORD), mai nel codice.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CASELLA = Deno.env.get("PEC_PROFUGHI_USER") ?? "profughi.metis@pec.it";
const PASSWORD = Deno.env.get("PEC_PROFUGHI_PASSWORD") ?? "";
const HOST = "imaps.pec.aruba.it";
const MAX_PER_GIRO = 8;
const MAX_STORICO = Number(Deno.env.get("PEC_MAX_STORICO") ?? 25);
const FINE_STORICO = 3056; // ultimo UID presente quando è partito l'archivio automatico (08/10/2026)
const CHIAVE_STORICO = `storico:${CASELLA}`;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function risposta(corpo: unknown, stato = 200): Response {
  return new Response(JSON.stringify(corpo), { status: stato, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!chiaviConfigurate) return risposta({ status: "errore", errore: "chiave PEC_SECRET non configurata nei segreti di Supabase" }, 500);
  if (!chiaveUsata(req)) return new Response("Unauthorized", { status: 401 });
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch { /* corpo vuoto */ }
  const azione = String(body.azione ?? "");

  // Conferma: lo script ha elaborato fino a questo UID.
  if (azione === "conferma") {
    const uid = Number(body.uid);
    if (!uid) return risposta({ status: "errore", errore: "uid mancante" }, 400);
    const { data: st } = await supabase.from("pec_stato").select("ultimo_uid").eq("casella", CASELLA).maybeSingle();
    if (!st || uid > Number(st.ultimo_uid)) {
      await supabase.from("pec_stato").upsert({ casella: CASELLA, ultimo_uid: uid, aggiornato: new Date().toISOString() });
    }
    return risposta({ status: "ok" });
  }

  // Storico: PEC già presenti nella casella prima dell'avvio dell'archivio (UID <= FINE_STORICO),
  // a partire da una data. Cursore separato, così la lettura delle PEC nuove non viene toccata.
  if (azione === "conferma_storico") {
    const uid = Number(body.uid);
    if (!uid) return risposta({ status: "errore", errore: "uid mancante" }, 400);
    await supabase.from("pec_stato").update({ ultimo_uid: uid, aggiornato: new Date().toISOString() }).eq("casella", CHIAVE_STORICO);
    return risposta({ status: "ok" });
  }

  // Date di ingresso degli ospiti (per lo storico: si archivia solo ciò che è arrivato dopo l'ingresso).
  if (azione === "ingressi") {
    const { data, error } = await supabase.from("ospiti_cas").select("id, attivo, data_ingresso");
    if (error) return risposta({ status: "errore", errore: error.message }, 500);
    const ingressi: Record<string, { attivo: boolean; data_ingresso: string | null }> = {};
    (data ?? []).forEach((o) => { ingressi[String(o.id)] = { attivo: o.attivo !== false, data_ingresso: o.data_ingresso ?? null }; });
    return risposta({ status: "ok", ingressi });
  }

  // Diagnosi: prova diversi modi di leggere un messaggio, ognuno su una connessione nuova, con un tempo massimo.
  if (azione === "diagnosi") {
    const uid = String(Number(body.uid));
    const tutte: Record<string, Record<string, unknown>> = {
      uid: { uid: true }, envelope: { uid: true, envelope: true }, data: { uid: true, internalDate: true },
      dimensione: { uid: true, size: true }, intestazioni: { uid: true, headers: ["subject", "date"] },
      sorgente: { uid: true, source: true }, struttura: { uid: true, bodyStructure: true },
    };
    const scelte = Array.isArray(body.prove) ? (body.prove as string[]) : Object.keys(tutte);
    const esiti: Record<string, string> = {};
    for (const [nome, q] of Object.entries(tutte).filter(([n]) => scelte.includes(n))) {
      const c = new ImapFlow({ host: "imaps.pec.aruba.it", port: 993, secure: true, auth: { user: CASELLA, pass: PASSWORD }, logger: false });
      const t = Date.now();
      try {
        await c.connect();
        await c.mailboxOpen("INBOX", { readOnly: true });
        const r = await Promise.race([
          (async () => { const out: unknown[] = []; for await (const m of c.fetch(uid, q, { uid: true })) out.push(m.source ? `${m.uid}:${m.source.length}b` : m.size ? `${m.uid}:${m.size}b` : m.uid); return "ok " + JSON.stringify(out); })(),
          new Promise<string>((res) => setTimeout(() => res("TEMPO SCADUTO"), 25000)),
        ]);
        esiti[nome] = `${r} (${Date.now() - t}ms)`;
      } catch (e) {
        esiti[nome] = "errore " + String((e as Error)?.message ?? e);
      }
      try { c.close(); } catch { /* */ }
    }
    return risposta({ status: "ok", uid, esiti });
  }

  if (azione !== "nuove" && azione !== "storico" && azione !== "storico_pec" && azione !== "struttura") return new Response("azione non valida", { status: 400 });
  if (!PASSWORD) return risposta({ status: "errore", errore: "password della casella PEC non impostata nei segreti di Supabase" }, 500);

  const client = new ImapFlow({
    host: "imaps.pec.aruba.it", port: 993, secure: true,
    auth: { user: CASELLA, pass: PASSWORD }, logger: false,
  });
  const t0 = Date.now();
  const tappa = (n: string) => console.log(`[pec-imap] ${azione} ${n} ${Date.now() - t0}ms`);
  try {
    await client.connect();
    tappa("connesso");
    const box = await client.mailboxOpen("INBOX", { readOnly: true });
    tappa("casella aperta");
    const uidvalidity = Number(box.uidValidity);

    if (azione === "storico") {
      // Elenco leggero (solo busta: oggetto, data, dimensione) dei prossimi messaggi da esaminare.
      const da = String(body.da ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(da)) { await client.logout(); return risposta({ status: "errore", errore: "data di partenza mancante" }, 400); }
      const { data: cur } = await supabase.from("pec_stato").select("uidvalidity, ultimo_uid").eq("casella", CHIAVE_STORICO).maybeSingle();
      if (cur && Number(cur.uidvalidity) !== uidvalidity) {
        await client.logout();
        return risposta({ status: "errore", errore: "la casella è cambiata (UIDVALIDITY diverso): storico da riavviare" }, 409);
      }
      if (!cur) await supabase.from("pec_stato").insert({ casella: CHIAVE_STORICO, uidvalidity, ultimo_uid: 0, aggiornato: new Date().toISOString() });
      const dopo = Number(cur?.ultimo_uid ?? 0);
      if (dopo >= FINE_STORICO) { await client.logout(); return risposta({ status: "ok", messaggi: [], restanti: 0, finito: true }); }
      const limite = new Date(da + "T00:00:00Z").getTime();
      const passo = Math.max(1, Math.min(100, Number(body.passo ?? MAX_STORICO)));
      const fino = Math.min(FINE_STORICO, dopo + passo);
      const messaggi: { uid: number; oggetto: string; data: string; dimensione: number }[] = [];
      tappa(`elenco ${dopo + 1}:${fino}`);
      // Niente "envelope": su alcuni messaggi della casella la sua lettura si blocca. Si leggono le intestazioni grezze.
      for await (const m of client.fetch(`${dopo + 1}:${fino}`, { uid: true, internalDate: true, size: true, headers: ["subject"] }, { uid: true })) {
        if (m.uid <= dopo || m.uid > fino) continue;
        const quando = new Date(m.internalDate ?? 0);
        const nelPeriodo = quando.getTime() >= limite;
        const oggetto = nelPeriodo ? oggettoDaIntestazioni(m.headers ? new TextDecoder("latin1").decode(m.headers) : "") : "";
        messaggi.push({ uid: m.uid, oggetto, data: quando.toISOString(), dimensione: Number(m.size ?? 0) });
      }
      await client.logout();
      messaggi.sort((a, b) => a.uid - b.uid);
      // Lo script, finiti questi messaggi, conferma "fino": il prossimo giro riparte da lì.
      return risposta({ status: "ok", messaggi, fino, finito: false, mancanti: FINE_STORICO - fino });
    }

    if (azione === "struttura") {
      // Solo le righe di struttura MIME (tipi, nomi, confini), per capire come è fatta una PEC.
      const uid = Number(body.uid);
      await client.logout();
      const sorgente = await scaricaSorgente(HOST, CASELLA, PASSWORD, uid);
      const testo = sorgente ? new TextDecoder("latin1").decode(sorgente) : "";
      const righe = testo.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)
        .filter((r) => /^(content-type|content-disposition|content-transfer-encoding|mime-version|--)/i.test(r))
        .map((r) => r.slice(0, 200));
      return risposta({ status: "ok", byte: sorgente?.length ?? 0, righe: righe.slice(0, 80) });
    }

    if (azione === "storico_pec") {
      // Una sola PEC completa (con i PDF), richiesta dallo script solo se l'oggetto è un atto da archiviare.
      const uid = Number(body.uid);
      if (!uid || uid > FINE_STORICO) { await client.logout(); return risposta({ status: "errore", errore: "uid non valido" }, 400); }
      await client.logout();
      tappa(`scarico ${uid}`);
      const sorgente = await scaricaSorgente(HOST, CASELLA, PASSWORD, uid);
      tappa(`scaricato ${sorgente ? sorgente.length : 0} byte`);
      const pec = sorgente ? await apriPec(sorgente) : null;
      tappa("letto");
      return risposta({ status: "ok", messaggio: pec ? { uid, ...pec } : { uid, saltato: true } });
    }

    const { data: st } = await supabase.from("pec_stato").select("uidvalidity, ultimo_uid").eq("casella", CASELLA).maybeSingle();

    // Prima volta (o casella ricreata): si parte da adesso, le PEC vecchie non si toccano.
    if (!st || Number(st.uidvalidity) !== uidvalidity) {
      const ultimo = Number(box.uidNext) - 1;
      await supabase.from("pec_stato").upsert({ casella: CASELLA, uidvalidity, ultimo_uid: ultimo, aggiornato: new Date().toISOString() });
      await client.logout();
      return risposta({ status: "ok", inizializzato: true, ultimo_uid: ultimo, messaggi: [] });
    }

    const da = Number(st.ultimo_uid) + 1;
    const uids: number[] = [];
    if (da < Number(box.uidNext)) {
      for await (const m of client.fetch(`${da}:*`, { uid: true }, { uid: true })) {
        if (m.uid >= da) uids.push(m.uid);
      }
    }
    uids.sort((a, b) => a - b);
    await client.logout();
    const messaggi = [];
    for (const uid of uids.slice(0, MAX_PER_GIRO)) {
      const sorgente = await scaricaSorgente(HOST, CASELLA, PASSWORD, uid);
      const pec = sorgente ? await apriPec(sorgente) : null;
      messaggi.push(pec ? { uid, ...pec } : { uid, saltato: true });
    }
    return risposta({ status: "ok", messaggi, altri: Math.max(0, uids.length - MAX_PER_GIRO) });
  } catch (e) {
    try { await client.logout(); } catch { /* */ }
    return risposta({ status: "errore", errore: String((e as Error)?.message ?? e) }, 500);
  }
});
