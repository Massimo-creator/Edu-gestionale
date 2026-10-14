// Lettura del messaggio completo con comandi IMAP diretti (sola lettura: EXAMINE + BODY.PEEK).
// Serve perché con questa casella la libreria si blocca quando scarica il corpo di alcuni messaggi.

const enc = new TextEncoder();
const dec = new TextDecoder("latin1");

function cerca(buf: Uint8Array, testo: string, da = 0): number {
  const t = enc.encode(testo);
  outer: for (let i = da; i <= buf.length - t.length; i++) {
    for (let j = 0; j < t.length; j++) if (buf[i + j] !== t[j]) continue outer;
    return i;
  }
  return -1;
}

function unisci(a: Uint8Array, b: Uint8Array): Uint8Array {
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
}

function citato(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export async function scaricaSorgente(host: string, utente: string, password: string, uid: number, tempoMs = 60000): Promise<Uint8Array | null> {
  const conn = await Deno.connectTls({ hostname: host, port: 993 });
  let buf: Uint8Array = new Uint8Array(0);
  const scadenza = Date.now() + tempoMs;
  const leggi = async () => {
    if (Date.now() > scadenza) throw new Error("tempo scaduto");
    const p = new Uint8Array(65536);
    const n = await conn.read(p);
    if (n === null) throw new Error("connessione chiusa");
    buf = unisci(buf, p.subarray(0, n));
  };
  // Attende la riga finale del comando con l'etichetta indicata.
  const attendi = async (tag: string): Promise<Uint8Array> => {
    while (true) {
      const i = cerca(buf, `\r\n${tag} `);
      const inizio = dec.decode(buf.subarray(0, tag.length + 1)) === `${tag} ` ? 0 : i >= 0 ? i + 2 : -1;
      if (inizio >= 0) {
        const fine = cerca(buf, "\r\n", inizio);
        if (fine >= 0) {
          const riga = dec.decode(buf.subarray(inizio, fine));
          const risposta = buf.subarray(0, fine + 2);
          buf = buf.subarray(fine + 2);
          if (!new RegExp(`^${tag} OK`, "i").test(riga)) throw new Error(`IMAP: ${riga.replace(/LOGIN.*/i, "LOGIN ...")}`);
          return risposta;
        }
      }
      await leggi();
    }
  };
  const invia = (s: string) => conn.write(enc.encode(s + "\r\n"));
  try {
    while (cerca(buf, "\r\n") < 0) await leggi(); // saluto del server
    buf = buf.subarray(cerca(buf, "\r\n") + 2);
    await invia(`a1 LOGIN ${citato(utente)} ${citato(password)}`);
    await attendi("a1");
    await invia("a2 EXAMINE INBOX");
    await attendi("a2");
    await invia(`a3 UID FETCH ${uid} (BODY.PEEK[])`);
    // La risposta contiene un letterale {N}\r\n seguito da N byte: va letto per intero prima di cercare la fine.
    let sorgente: Uint8Array | null = null;
    while (true) {
      const graffa = cerca(buf, "BODY[] {");
      if (graffa >= 0) {
        const chiusa = cerca(buf, "}\r\n", graffa);
        if (chiusa >= 0) {
          const n = Number(dec.decode(buf.subarray(graffa + 8, chiusa)));
          const inizio = chiusa + 3;
          while (buf.length < inizio + n) await leggi();
          sorgente = buf.slice(inizio, inizio + n);
          buf = buf.subarray(inizio + n);
          break;
        }
      }
      if (cerca(buf, "\r\na3 ") >= 0 || dec.decode(buf.subarray(0, 3)) === "a3 ") break; // nessun messaggio con quell'UID
      await leggi();
    }
    await attendi("a3");
    await invia("a4 LOGOUT");
    return sorgente;
  } finally {
    try { conn.close(); } catch { /* */ }
  }
}
