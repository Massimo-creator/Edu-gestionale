import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

// CONFRONTO SUI CASI: avvisi per i messaggi scritti nella scheda ospite (tutte le strutture, dal 11/11/2026).
// Chiamata dal trigger casi_messaggi_notifica (chiave vault cron_casi) a ogni nuovo messaggio.
// - Notifica push sul telefono/computer a: menzionati, incaricato del "da fare", referenti della chat della
//   struttura (tabella casi_referenti), escluso l'autore. Nessuna mail (decisione di Massimo, 11/11/2026):
//   menzioni e messaggi nuovi si vedono in Approdo (campanella, avviso all'apertura, Chat casi).
// POST { azione: "nuovo", id }  |  { azione: "prova", email }  (push di prova a una persona)

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBBLICA = "BFt99Y1E1xCIXGQ6nSPoK3N22Q8mnBtgkltSCos3ZqLqImOzK8A_TFMwjSLuDftsPwRwnPk2lzAohPEq-hgyGZM";
const SITO = "https://approdocas.it";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const risposta = (c: unknown, s = 200) => new Response(JSON.stringify(c), { status: s, headers: { "Content-Type": "application/json" } });

async function autorizzato(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  if (token === SERVICE_ROLE_KEY) return true;
  const { data } = await sb.rpc("verifica_chiave_cron", { p_nome: "casi", p_valore: token });
  return data === true;
}

let vapidPronto = false;
async function preparaVapid() {
  if (vapidPronto) return;
  const { data, error } = await sb.rpc("chiave_vapid");
  if (error || !data) throw new Error("chiave VAPID non disponibile");
  webpush.setVapidDetails("mailto:notifiche@approdocas.it", VAPID_PUBBLICA, String(data));
  vapidPronto = true;
}

// deno-lint-ignore no-explicit-any
type Riga = Record<string, any>;

async function inviaPush(emails: string[], payload: Riga): Promise<{ inviati: number; falliti: number }> {
  if (!emails.length) return { inviati: 0, falliti: 0 };
  await preparaVapid();
  const { data: iscr } = await sb.from("push_iscrizioni").select("*").in("utente_email", emails);
  let inviati = 0, falliti = 0;
  for (const s of iscr ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 86400, urgency: "high" });
      inviati++;
      await sb.from("push_iscrizioni").update({ ultimo_invio_ok: new Date().toISOString() }).eq("id", s.id);
    } catch (e) {
      falliti++;
      const code = (e as Riga)?.statusCode;
      if (code === 404 || code === 410) await sb.from("push_iscrizioni").delete().eq("id", s.id); // iscrizione scaduta
    }
  }
  return { inviati, falliti };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return risposta({ errore: "solo POST" }, 405);
  if (!(await autorizzato(req))) return risposta({ errore: "non autorizzato" }, 401);
  let corpo: Riga = {};
  try { corpo = await req.json(); } catch { /* vuoto */ }

  try {
    if (corpo.azione === "prova") {
      const r = await inviaPush([String(corpo.email || "").toLowerCase()], { title: "Approdo", body: "Notifica di prova: gli avvisi funzionano.", url: SITO, tag: "prova" });
      return risposta({ status: "ok", ...r });
    }
    if (corpo.azione !== "nuovo" || !corpo.id) return risposta({ status: "ok", ignorato: true });

    const { data: m } = await sb.from("casi_messaggi").select("*").eq("id", corpo.id).maybeSingle();
    if (!m) return risposta({ errore: "messaggio non trovato" }, 404);
    const { data: o } = await sb.from("ospiti_cas").select("id, nome, cognome, struttura_id").eq("id", m.ospite_id).maybeSingle();
    const { data: st } = await sb.from("strutture_cas").select("nome").eq("id", m.struttura_id).maybeSingle();
    const { data: ref } = await sb.from("casi_referenti").select("utente_email").eq("struttura_id", m.struttura_id);
    const { data: utenti } = await sb.from("utenti").select("email, nome, cognome").is("comunita_id", null);
    const validi = new Set((utenti ?? []).map((u: Riga) => String(u.email).toLowerCase()));
    const autore = String(m.autore_email).toLowerCase();

    const diretti = new Set<string>([...(m.menzioni ?? []), ...(m.incaricato_email ? [m.incaricato_email] : [])].map((e: string) => e.toLowerCase()));
    const referenti = (ref ?? []).map((r: Riga) => String(r.utente_email).toLowerCase());
    const destinatari = [...new Set([...diretti, ...referenti])].filter((e) => e !== autore && validi.has(e));

    const nomeOspite = o ? `${String(o.cognome ?? "").toUpperCase()} ${o.nome ?? ""}`.trim() : "un ospite";
    const chi = m.autore_nome || autore;
    const breve = String(m.testo).length > 140 ? String(m.testo).slice(0, 137) + "..." : String(m.testo);
    const url = `${SITO}/?ospite=${m.ospite_id}`;

    const titolo = `${nomeOspite} · ${st?.nome ?? ""}`.trim();
    const aDiretti = destinatari.filter((e) => diretti.has(e));
    const aReferenti = destinatari.filter((e) => !diretti.has(e));
    const p1 = await inviaPush(aDiretti, {
      title: titolo,
      body: `${m.da_fare ? "DA FARE · " : ""}${chi} ti ha menzionato: ${breve}`,
      url, tag: `caso-${m.ospite_id}`,
    });
    const p2 = await inviaPush(aReferenti, {
      title: titolo,
      body: `${m.da_fare ? "DA FARE · " : ""}${chi}: ${breve}`,
      url, tag: `caso-${m.ospite_id}`,
    });

    return risposta({ status: "ok", destinatari: destinatari.length, inviati: p1.inviati + p2.inviati, falliti: p1.falliti + p2.falliti });
  } catch (e) {
    return risposta({ errore: String((e as Error)?.message ?? e) }, 500);
  }
});
