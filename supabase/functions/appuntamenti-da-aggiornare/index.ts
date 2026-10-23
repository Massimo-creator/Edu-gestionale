import { createClient } from "npm:@supabase/supabase-js@2";
import { type Appuntamento, mailOperatore, mailRiepilogo, prepara, type Struttura, type Utente } from "./logica.ts";

// Dal lunedì al venerdì alle 12:15 (ora di Roma): a ogni operatore la lista dei suoi appuntamenti passati da almeno
// 5 giorni e ancora "Da svolgere"; a Massimo il riepilogo. Chiamata dal job pianificato (pg_cron).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// La chiave condivisa con il job pianificato sta solo nella cassaforte (Vault) del database, mai nel codice:
// la controlla la funzione SQL verifica_chiave_cron, che solo il service role può chiamare.
const NOME_CHIAVE = "appuntamenti_da_aggiornare";
const EMAIL_MASSIMO = "m.andreoni@coopmetis.com";
const ORA_INVIO = 12; // il job gira alle 10:15 e alle 11:15 UTC: parte solo quando a Roma sono le 12
const SOGLIA = 5;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function risposta(corpo: unknown, stato = 200): Response {
  return new Response(JSON.stringify(corpo), { status: stato, headers: { "Content-Type": "application/json" } });
}
function oraRoma(): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
}
async function invia(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ to, subject, html }),
    });
    return res.ok;
  } catch (_e) {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: valida, error: errChiave } = await supabase.rpc("verifica_chiave_cron", { p_nome: NOME_CHIAVE, p_valore: token });
  if (errChiave) return risposta({ status: "errore", errore: `controllo chiave non riuscito: ${errChiave.message}` }, 500);
  if (valida !== true) return new Response("Unauthorized", { status: 401 });

  // prova=1: non invia nulla e restituisce le mail che partirebbero (con giorni=N si prova un'altra soglia);
  // forza=1: ignora il controllo dell'ora.
  const url = new URL(req.url);
  const prova = url.searchParams.get("prova") === "1";
  const forza = url.searchParams.get("forza") === "1";
  const giorni = url.searchParams.has("giorni") ? Number(url.searchParams.get("giorni")) : NaN;
  const soglia = prova && Number.isInteger(giorni) && giorni >= 0 && giorni <= 60 ? giorni : SOGLIA;

  if (!prova && !forza && oraRoma() !== ORA_INVIO) {
    return risposta({ status: "ok", inviate: 0, motivo: `a Roma non sono le ${ORA_INVIO}` });
  }

  const [app, str, ute] = await Promise.all([
    supabase.from("appuntamenti_cas")
      .select("id, tipo, data_ora, ospite_nome, titolo, struttura_id, operatore_accompagnatore, stato")
      .eq("stato", "Da svolgere").lt("data_ora", new Date().toISOString()),
    supabase.from("strutture_cas").select("id, nome, responsabile"),
    supabase.from("utenti").select("nome, email").is("comunita_id", null),
  ]);
  const errore = app.error ?? str.error ?? ute.error;
  if (errore) return risposta({ status: "errore", errore: errore.message }, 500);

  const { mail, nonInviate } = prepara(
    (app.data ?? []) as Appuntamento[], (str.data ?? []) as Struttura[], (ute.data ?? []) as Utente[], new Date(), soglia,
  );
  const operatori = mail.map((m) => ({ a: m.email, nome: m.nome, voci: m.voci.length, ...mailOperatore(m, soglia) }));
  const riepilogo = mailRiepilogo(mail, nonInviate, soglia);

  if (prova) {
    return risposta({ status: "ok", prova: true, soglia, operatori, riepilogo: riepilogo && { a: EMAIL_MASSIMO, ...riepilogo }, nonInviate });
  }

  let inviate = 0;
  const fallite: string[] = [];
  for (const m of operatori) {
    if (await invia(m.a, m.oggetto, m.html)) inviate++;
    else fallite.push(m.a);
  }
  if (riepilogo) {
    if (await invia(EMAIL_MASSIMO, riepilogo.oggetto, riepilogo.html)) inviate++;
    else fallite.push(EMAIL_MASSIMO);
  }
  return risposta({ status: "ok", inviate, fallite, appuntamenti: operatori.reduce((n, m) => n + m.voci, 0) + nonInviate.length });
});
