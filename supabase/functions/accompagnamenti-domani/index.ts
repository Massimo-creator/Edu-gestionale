import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// La chiave condivisa con il job pianificato (pg_cron) sta solo nella cassaforte (Vault) del database:
// la controlla la funzione SQL verifica_chiave_cron, che solo il service role può chiamare.
const NOME_CHIAVE = "accompagnamenti_domani";

// Gli indirizzi si leggono dagli utenti di Approdo (stessa fonte delle altre automazioni).
// Questo elenco serve solo per chi non è tra gli utenti (es. Paola, Mediazione Linguistica).
const EXTRA: Record<string, string> = {
  "Paola": "paola@coopmetis.com",
  "Mediazione Linguistica": "mediazione@coopmetis.com",
};
const EMAIL_MASSIMO = "m.andreoni@coopmetis.com";

const ORA_INVIO = 18; // ora di Roma alla quale parte la mail

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function dataItaliaISO(d: Date): string {
  return new Date(d.toLocaleString("en-US", { timeZone: "Europe/Rome" })).toISOString().slice(0, 10);
}
function oraItalia(d: Date): string {
  return new Date(d.toLocaleString("en-US", { timeZone: "Europe/Rome" })).toTimeString().slice(0, 5);
}
function oraRomaAdesso(): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
}

// Toglie dalle note il codice tecnico della sincronizzazione con l'Excel (es. [sync:questura-sheet:...]).
function notaPulita(n: unknown): string {
  return String(n ?? "").replace(/\[sync:[^\]]*\]/g, "").replace(/\s+\n/g, "\n").trim();
}

// Se l'orario non è ancora noto (ora_da_definire) non si scrive un'ora finta.
function etichettaOra(a: any): string {
  return a.ora_da_definire ? "Ora da definire" : `Ore ${oraItalia(new Date(a.data_ora))}`;
}

// Battito per il controllo delle automazioni (non blocca mai l'invio).
async function registra(esito: "ok" | "errore", messaggio: string): Promise<void> {
  await supabase.rpc("registra_automazione", { p_nome: "accompagnamenti-domani", p_esito: esito, p_messaggio: messaggio });
}

async function inviaMail(to: string, subject: string, html: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to, subject, html }),
  });
  return res.ok;
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

  // Parametri per le prove: prova=1 non invia nulla e mostra cosa invierebbe (con data=AAAA-MM-GG si sceglie il giorno);
  // forza=1 ignora il controllo dell'ora.
  const url = new URL(req.url);
  const prova = url.searchParams.get("prova") === "1";
  const forza = url.searchParams.get("forza") === "1";
  const dataProva = url.searchParams.get("data") || "";

  // Il job gira sia alle 16 che alle 17 UTC: parte solo quando a Roma sono le 18, con ora legale e solare.
  if (!prova && !forza && oraRomaAdesso() !== ORA_INVIO) {
    return new Response(JSON.stringify({ status: "ok", inviate: 0, motivo: `a Roma non sono le ${ORA_INVIO}` }), { status: 200 });
  }

  const oggiItalia = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Rome" }));
  let domani = new Date(oggiItalia);
  domani.setDate(domani.getDate() + 1);
  let domaniKey = domani.toISOString().slice(0, 10);
  if (prova && /^\d{4}-\d{2}-\d{2}$/.test(dataProva)) {
    domaniKey = dataProva;
    domani = new Date(`${dataProva}T12:00:00Z`);
  }

  const [{ data: appuntamenti, error }, { data: utenti, error: errUtenti }] = await Promise.all([
    supabase
      .from("appuntamenti_cas")
      .select("id, tipo, data_ora, ora_da_definire, ospite_nome, operatore_accompagnatore, note")
      .not("operatore_accompagnatore", "is", null),
    supabase.from("utenti").select("nome, email").is("comunita_id", null),
  ]);

  if (error || errUtenti) {
    if (!prova) await registra("errore", `lettura dal database non riuscita: ${(error ?? errUtenti)!.message}`);
    return new Response(JSON.stringify({ status: "errore", messaggio: (error ?? errUtenti)!.message }), { status: 500 });
  }

  // nome (minuscolo) -> email: prima gli utenti di Approdo, poi l'elenco EXTRA
  const indirizzi = new Map<string, string>();
  for (const [nome, email] of Object.entries(EXTRA)) indirizzi.set(nome.toLowerCase(), email);
  for (const u of utenti ?? []) {
    const nome = String(u.nome ?? "").trim().toLowerCase();
    const email = String(u.email ?? "").trim();
    if (nome && email.includes("@")) indirizzi.set(nome, email);
  }

  const rilevanti = (appuntamenti || []).filter((a: any) =>
    a.operatore_accompagnatore &&
    a.operatore_accompagnatore !== "In autonomia" &&
    dataItaliaISO(new Date(a.data_ora)) === domaniKey
  );

  if (rilevanti.length === 0) {
    if (!prova) await registra("ok", "nessun accompagnamento domani");
    return new Response(JSON.stringify({ status: "ok", inviate: 0, motivo: "nessun accompagnamento domani" }), { status: 200 });
  }

  const perOperatore: Record<string, any[]> = {};
  for (const a of rilevanti as any[]) {
    const nome = a.operatore_accompagnatore;
    if (!perOperatore[nome]) perOperatore[nome] = [];
    perOperatore[nome].push(a);
  }

  const dataFormattata = domani.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
  let inviate = 0;
  const nonMappati: string[] = [];
  const fallite: string[] = [];
  const anteprima: { operatore: string; email: string; righe: string[] }[] = [];

  for (const [nome, lista] of Object.entries(perOperatore)) {
    const email = indirizzi.get(nome.trim().toLowerCase());
    if (!email) { nonMappati.push(nome); continue; }

    const righeTesto = lista
      .sort((x: any, y: any) => new Date(x.data_ora).getTime() - new Date(y.data_ora).getTime())
      .map((a: any) => `• ${etichettaOra(a)} — ${a.tipo} — ${a.ospite_nome || "(nome non indicato)"}${notaPulita(a.note) ? " (" + notaPulita(a.note) + ")" : ""}`);

    if (prova) {
      anteprima.push({ operatore: nome, email, righe: righeTesto });
      continue;
    }

    const html = `<p>Ciao ${nome},</p><p>Domani (<b>${dataFormattata}</b>) hai questi accompagnamenti:</p><p>${righeTesto.join("<br>")}</p><p>Buona serata,<br>Approdo</p>`;
    if (await inviaMail(email, `Approdo — Accompagnamenti di domani (${dataFormattata})`, html)) inviate++;
    else fallite.push(`${nome} (${email})`);
  }

  // Se per un accompagnatore non c'è un indirizzo, o la mail non parte, lo si segnala a Massimo.
  if ((nonMappati.length > 0 || fallite.length > 0) && !prova) {
    const parti = [];
    if (nonMappati.length) parti.push(`<p>Per questi accompagnatori non ho un indirizzo email: <b>${nonMappati.join(", ")}</b>. Vanno aggiunti tra gli utenti di Approdo.</p>`);
    if (fallite.length) parti.push(`<p>Per questi accompagnatori l'invio non è riuscito: <b>${fallite.join(", ")}</b>.</p>`);
    await inviaMail(EMAIL_MASSIMO, "Approdo — Accompagnamenti di domani NON inviati", parti.join(""));
  }

  if (prova) {
    return new Response(JSON.stringify({ status: "ok", prova: true, giorno: domaniKey, anteprima, nonMappati }), { status: 200 });
  }
  if (nonMappati.length || fallite.length) {
    await registra("errore", [
      nonMappati.length ? `senza indirizzo: ${nonMappati.join(", ")}` : "",
      fallite.length ? `invio non riuscito: ${fallite.join(", ")}` : "",
    ].filter(Boolean).join("; "));
  } else {
    await registra("ok", `${inviate} mail inviate`);
  }
  return new Response(JSON.stringify({ status: "ok", inviate, nonMappati, fallite }), { status: 200 });
});
