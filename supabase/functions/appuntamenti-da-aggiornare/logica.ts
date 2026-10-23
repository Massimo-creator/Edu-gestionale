// Promemoria degli appuntamenti passati e non aggiornati. Logica pura: niente database, niente invii.
// Regole decise da Massimo il 15/10/2026: un appuntamento entra quando è passato da almeno 5 giorni ed è
// ancora "Da svolgere"; va all'accompagnatore, oppure (senza accompagnatore o "In autonomia") al responsabile
// della struttura; Massimo riceve il riepilogo di tutti. La mail parte ogni giorno finché resta qualcosa.

export type Appuntamento = {
  id: string;
  tipo: string | null;
  data_ora: string;
  ospite_nome: string | null;
  titolo: string | null;
  struttura_id: string | null;
  operatore_accompagnatore: string | null;
  stato: string | null;
};
export type Struttura = { id: string; nome: string; responsabile: string | null };
export type Utente = { nome: string | null; email: string | null };

export type Voce = {
  id: string;
  tipo: string;
  ospite: string;
  struttura: string;
  quando: string; // "lunedì 13/10 alle 9:00"
  giorno: string; // AAAA-MM-GG a Roma
  giorni: number; // giorni passati
  comeResponsabile: boolean; // senza accompagnatore: arriva al responsabile della struttura
};
export type Mail = { nome: string; email: string; voci: Voce[] };
export type NonInviata = { voce: Voce; motivo: string };

const fmtGiorno = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit" });
const fmtOra = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", hour: "numeric", minute: "2-digit" });
const fmtSettimana = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", weekday: "long" });

export function giornoRoma(d: Date): string {
  return fmtGiorno.format(d);
}
function giorniTra(daIso: string, aIso: string): number {
  return Math.round((Date.parse(`${aIso}T00:00:00Z`) - Date.parse(`${daIso}T00:00:00Z`)) / 86400000);
}
function quando(d: Date): string {
  const [a, m, g] = giornoRoma(d).split("-");
  void a;
  return `${fmtSettimana.format(d)} ${g}/${m} alle ${fmtOra.format(d)}`;
}
const chiave = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function prepara(
  appuntamenti: Appuntamento[],
  strutture: Struttura[],
  utenti: Utente[],
  oggi: Date,
  soglia = 5,
): { mail: Mail[]; nonInviate: NonInviata[] } {
  const oggiIso = giornoRoma(oggi);
  const perStruttura = new Map(strutture.map((s) => [s.id, s]));
  const email = new Map(
    utenti.filter((u) => u.nome && u.email && u.email.includes("@")).map((u) => [chiave(u.nome), { nome: u.nome!.trim(), email: u.email!.trim() }]),
  );
  const mail = new Map<string, Mail>();
  const nonInviate: NonInviata[] = [];

  const ferme = appuntamenti
    .filter((a) => a.stato === "Da svolgere")
    .map((a) => ({ a, d: new Date(a.data_ora) }))
    .filter(({ d }) => giorniTra(giornoRoma(d), oggiIso) >= soglia)
    .sort((x, y) => x.d.getTime() - y.d.getTime());

  for (const { a, d } of ferme) {
    const s = a.struttura_id ? perStruttura.get(a.struttura_id) : undefined;
    const acc = (a.operatore_accompagnatore ?? "").trim();
    const conAccompagnatore = acc !== "" && chiave(acc) !== "in autonomia";
    const voce: Voce = {
      id: a.id,
      tipo: a.tipo ?? "Appuntamento",
      ospite: (a.ospite_nome || a.titolo || "nome non indicato").trim(),
      struttura: s?.nome ?? "struttura non indicata",
      quando: quando(d),
      giorno: giornoRoma(d),
      giorni: giorniTra(giornoRoma(d), oggiIso),
      comeResponsabile: !conAccompagnatore,
    };
    const persona = conAccompagnatore ? acc : (s?.responsabile ?? "").trim();
    if (!persona) {
      nonInviate.push({ voce, motivo: "senza accompagnatore e senza responsabile di struttura" });
      continue;
    }
    const dest = email.get(chiave(persona));
    if (!dest) {
      nonInviate.push({ voce, motivo: `nessuna email per "${persona}" tra gli utenti di Approdo` });
      continue;
    }
    if (!mail.has(dest.email)) mail.set(dest.email, { nome: dest.nome, email: dest.email, voci: [] });
    mail.get(dest.email)!.voci.push(voce);
  }
  return { mail: [...mail.values()], nonInviate };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function riga(v: Voce): string {
  return `– <b>${esc(v.tipo)}</b>, ${esc(v.ospite)} (${esc(v.struttura)}): ${esc(v.quando)}`;
}
const FONT = `font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5`;
const LINK = "https://approdocas.it";

function parola(n: number, uno: string, piu: string): string {
  return n === 1 ? uno : piu;
}

export function mailOperatore(m: Mail, soglia = 5): { oggetto: string; html: string } {
  const acc = m.voci.filter((v) => !v.comeResponsabile);
  const resp = m.voci.filter((v) => v.comeResponsabile);
  const n = m.voci.length;
  const giorni = soglia === 5 ? "cinque giorni" : `${soglia} ${parola(soglia, "giorno", "giorni")}`;
  const parti: string[] = [`<p>Ciao ${esc(m.nome)},</p>`];
  if (acc.length) {
    parti.push(
      `<p>in Approdo ${parola(acc.length, "c'è", "ci sono")} ${acc.length} ${parola(acc.length, "appuntamento che hai accompagnato e che risulta", "appuntamenti che hai accompagnato e che risultano")} ancora "Da svolgere", anche se la data è passata da almeno ${giorni}:</p>`,
      `<p>${acc.map(riga).join("<br>")}</p>`,
    );
  }
  if (resp.length) {
    parti.push(
      `<p>${acc.length ? parola(resp.length, "C'è anche", "Ci sono anche") : parola(resp.length, "in Approdo c'è", "in Approdo ci sono")} ${resp.length} ${parola(resp.length, "appuntamento", "appuntamenti")} senza accompagnatore nelle strutture di cui sei responsabile, ancora "Da svolgere" da almeno ${giorni}:</p>`,
      `<p>${resp.map(riga).join("<br>")}</p>`,
    );
  }
  parti.push(
    n === 1
      ? `<p>Apri l'appuntamento in Approdo e premi "Aggiorna esito": scrivi in due righe com'è andato. Se è stato rinviato, modifica la data dell'appuntamento.</p>`
      : `<p>Per ognuno apri l'appuntamento in Approdo e premi "Aggiorna esito": scrivi in due righe com'è andato. Se è stato rinviato, modifica la data dell'appuntamento.</p>`,
    `<p>Tenere aggiornati gli appuntamenti serve a tutti: è da lì che si capisce cosa è stato fatto per ogni ragazzo e cosa resta da fare.</p>`,
    `<p><a href="${LINK}">Apri Approdo</a></p>`,
    `<p style="color:#64748b;font-size:12px">Questa mail arriva ogni giorno finché ci sono appuntamenti da aggiornare.</p>`,
  );
  return {
    oggetto: `Approdo: ${n} ${parola(n, "appuntamento", "appuntamenti")} da aggiornare`,
    html: `<div style="${FONT}">${parti.join("")}</div>`,
  };
}

function dataBreve(iso: string): string {
  const [, m, g] = iso.split("-");
  return `${g}/${m}`;
}

export function mailRiepilogo(mail: Mail[], nonInviate: NonInviata[], soglia = 5): { oggetto: string; html: string } | null {
  if (mail.length === 0 && nonInviate.length === 0) return null;
  const righe = mail
    .map((m) => {
      const piuVecchio = m.voci.reduce((x, v) => (v.giorno < x ? v.giorno : x), m.voci[0].giorno);
      const resp = m.voci.filter((v) => v.comeResponsabile).length;
      return `– <b>${esc(m.nome)}</b>: ${m.voci.length} (il più vecchio del ${dataBreve(piuVecchio)})${resp ? `, di cui ${resp} senza accompagnatore come responsabile di struttura` : ""}`;
    })
    .sort();
  const parti = [
    `<p>Appuntamenti passati da almeno ${soglia} ${parola(soglia, "giorno", "giorni")} e non ancora aggiornati:</p>`,
    righe.length ? `<p>${righe.join("<br>")}</p>` : `<p>Nessuno tra quelli assegnati a un operatore.</p>`,
  ];
  if (mail.length) parti.push(`<p>Gli operatori hanno ricevuto la loro lista oggi.</p>`);
  if (nonInviate.length) {
    parti.push(
      `<p><b>Non inviati a nessuno</b> (da sistemare a mano):</p>`,
      `<p>${nonInviate.map((x) => `${riga(x.voce)}: ${esc(x.motivo)}`).join("<br>")}</p>`,
    );
  }
  parti.push(`<p><a href="${LINK}">Apri Approdo</a></p>`);
  const tot = mail.reduce((n, m) => n + m.voci.length, 0) + nonInviate.length;
  return {
    oggetto: `Approdo: appuntamenti da aggiornare, riepilogo (${tot})`,
    html: `<div style="${FONT}">${parti.join("")}</div>`,
  };
}
