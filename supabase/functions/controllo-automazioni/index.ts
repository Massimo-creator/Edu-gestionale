import { createClient } from "npm:@supabase/supabase-js@2";
import { type Dati, mailAllarme, mailSettimanale, valuta } from "./logica.ts";

// Ogni mattina alle 7 (ora di Roma) controlla che le automazioni di Approdo stiano girando e scrive a Massimo
// solo se qualcosa non va. Il lunedì manda comunque un riepilogo "tutto a posto". Decisione di Massimo del 24/10/2026.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// La chiave condivisa con il job pianificato sta solo nella cassaforte (Vault) del database.
const NOME_CHIAVE = "controllo_automazioni";
const EMAIL_MASSIMO = "m.andreoni@coopmetis.com";
const ORA_INVIO = 7; // il job gira alle 5 e alle 6 UTC: parte solo quando a Roma sono le 7

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function risposta(corpo: unknown, stato = 200): Response {
  return new Response(JSON.stringify(corpo), { status: stato, headers: { "Content-Type": "application/json" } });
}
function adessoRoma(): { ora: number; lunedi: boolean } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date());
  return { ora: Number(p.find((x) => x.type === "hour")!.value), lunedi: p.find((x) => x.type === "weekday")!.value === "Mon" };
}
async function invia(subject: string, html: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ to: EMAIL_MASSIMO, subject, html }),
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

  // prova=1: non invia nulla e restituisce cosa invierebbe; forza=1: ignora il controllo dell'ora;
  // lunedi=1 (solo con prova): mostra anche la mail settimanale.
  const url = new URL(req.url);
  const prova = url.searchParams.get("prova") === "1";
  const forza = url.searchParams.get("forza") === "1";
  const roma = adessoRoma();
  if (!prova && !forza && roma.ora !== ORA_INVIO) return risposta({ status: "ok", inviate: 0, motivo: `a Roma non sono le ${ORA_INVIO}` });
  const lunedi = roma.lunedi || (prova && url.searchParams.get("lunedi") === "1");

  const { data, error } = await supabase.rpc("controllo_automazioni_dati");
  if (error) {
    // Se non riesce nemmeno a leggere, lo dice.
    if (!prova) await invia("⚠️ Approdo: il controllo delle automazioni non è riuscito", `<p>Errore: ${error.message}</p>`);
    return risposta({ status: "errore", errore: error.message }, 500);
  }
  const esito = valuta(data as Dati);
  const mail = esito.problemi.length ? mailAllarme(esito) : lunedi ? mailSettimanale(esito) : null;

  if (prova) return risposta({ status: "ok", prova: true, esito, mail });

  const inviata = mail ? await invia(mail.oggetto, mail.html) : null;
  await supabase.rpc("registra_automazione", {
    p_nome: "controllo-automazioni",
    p_esito: inviata === false ? "errore" : "ok",
    p_messaggio: inviata === false ? "mail del controllo non inviata" : `${esito.problemi.length} problemi`,
  });
  return risposta({ status: "ok", problemi: esito.problemi.length, mail: mail?.oggetto ?? null, inviata });
});
