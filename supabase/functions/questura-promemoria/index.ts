import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// La chiave condivisa con il job pianificato (pg_cron) sta solo nella cassaforte (Vault) del database:
// la controlla la funzione SQL verifica_chiave_cron, che solo il service role può chiamare.
const NOME_CHIAVE = "questura_promemoria";

const EMAIL_DESTINATARIO = "m.andreoni@coopmetis.com";
const GIORNI_ANTICIPO = 2;

const CHECKLIST = [
  "2 foto tessera",
  "Marca da bollo da 16€",
  "Vecchio permesso di soggiorno",
  "Certificato di ospitalità",
];

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function dataItaliaISO(d: Date): string {
  return new Date(d.toLocaleString("en-US", { timeZone: "Europe/Rome" })).toISOString().slice(0, 10);
}
function oraItalia(d: Date): string {
  return new Date(d.toLocaleString("en-US", { timeZone: "Europe/Rome" })).toTimeString().slice(0, 5);
}

// Battito per il controllo delle automazioni (non blocca mai l'invio).
async function registra(esito: "ok" | "errore", messaggio: string): Promise<void> {
  await supabase.rpc("registra_automazione", { p_nome: "questura-promemoria", p_esito: esito, p_messaggio: messaggio });
}

Deno.serve(async (req: Request) => {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: valida, error: errChiave } = await supabase.rpc("verifica_chiave_cron", { p_nome: NOME_CHIAVE, p_valore: token });
  if (errChiave) {
    return new Response(JSON.stringify({ status: "errore", messaggio: `controllo chiave non riuscito: ${errChiave.message}` }), { status: 500 });
  }
  if (valida !== true) {
    return new Response("Unauthorized", { status: 401 });
  }
  // prova=1: non invia nulla e restituisce la mail che partirebbe.
  const prova = new URL(req.url).searchParams.get("prova") === "1";

  const oggiItalia = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" }));
  const target = new Date(oggiItalia);
  target.setDate(target.getDate() + GIORNI_ANTICIPO);
  const targetKey = target.toISOString().slice(0, 10);

  const { data: appuntamenti, error } = await supabase
    .from("appuntamenti_cas")
    .select("id, data_ora, ora_da_definire, ospite_nome, struttura_id, strutture_cas(nome)")
    .eq("tipo", "Questura");

  if (error) {
    if (!prova) await registra("errore", `lettura dal database non riuscita: ${error.message}`);
    return new Response(JSON.stringify({ status: "errore", messaggio: error.message }), { status: 500 });
  }

  const rilevanti = (appuntamenti || []).filter((a: any) => dataItaliaISO(new Date(a.data_ora)) === targetKey);

  if (rilevanti.length === 0) {
    if (!prova) await registra("ok", `nessun appuntamento tra ${GIORNI_ANTICIPO} giorni`);
    return new Response(JSON.stringify({ status: "ok", inviato: false, motivo: "nessun appuntamento tra " + GIORNI_ANTICIPO + " giorni" }), { status: 200 });
  }

  const gruppi: Record<string, { struttura: string; voci: { ora: string; nome: string }[] }> = {};

  for (const a of rilevanti as any[]) {
    const chiave = a.struttura_id || "sconosciuta";
    const nomeStruttura = (a.strutture_cas && a.strutture_cas.nome) || "⚠️ Struttura da verificare";
    if (!gruppi[chiave]) gruppi[chiave] = { struttura: nomeStruttura, voci: [] };
    // Se l'orario non è ancora noto non si scrive un'ora finta.
    gruppi[chiave].voci.push({ ora: a.ora_da_definire ? "da definire" : oraItalia(new Date(a.data_ora)), nome: a.ospite_nome || "(nome non indicato)" });
  }

  const dataFormattata = target.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });

  let corpo = `<p>Promemoria appuntamenti Questura tra ${GIORNI_ANTICIPO} giorni (<b>${dataFormattata}</b>). Copia ogni blocco nel gruppo WhatsApp della struttura corrispondente:</p>`;

  for (const g of Object.values(gruppi)) {
    const righe = g.voci
      .sort((x, y) => x.ora.localeCompare(y.ora))
      .map((v) => (v.ora === "da definire" ? `• Ora da definire — ${v.nome}` : `• Ore ${v.ora} — ${v.nome}`))
      .join("<br>");
    corpo += `
      <hr>
      <p style="font-family:monospace; white-space:pre-wrap;">
📋 <b>Promemoria Questura — ${dataFormattata}</b><br>
Struttura: <b>${g.struttura}</b><br><br>
${righe}<br><br>
📎 Documenti da portare per ciascuno:<br>
${CHECKLIST.map((c) => "- " + c).join("<br>")}
      </p>
    `;
  }

  if (prova) {
    return new Response(JSON.stringify({ status: "ok", prova: true, a: EMAIL_DESTINATARIO, oggetto: `Promemoria Questura — ${dataFormattata}`, appuntamenti: rilevanti.length }), { status: 200 });
  }

  let ok = false;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        apikey: SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: EMAIL_DESTINATARIO,
        subject: `Promemoria Questura — ${dataFormattata}`,
        html: corpo,
      }),
    });
    ok = res.ok;
  } catch (_e) {
    ok = false;
  }
  await registra(ok ? "ok" : "errore", ok ? `promemoria inviato (${rilevanti.length} appuntamenti)` : "invio del promemoria non riuscito");

  return new Response(JSON.stringify({ status: "ok", inviato: ok }), { status: 200 });
});
