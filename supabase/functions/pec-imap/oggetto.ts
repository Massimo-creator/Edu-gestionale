// Oggetto da intestazione grezza: righe ricucite e parole codificate (=?utf-8?B?...?=) decodificate.
function decodificaParola(charset: string, modo: string, testo: string): string {
  try {
    let bytes: Uint8Array;
    if (modo.toUpperCase() === "B") bytes = Uint8Array.from(atob(testo), (c) => c.charCodeAt(0));
    else {
      const t = testo.replace(/_/g, " ");
      const out: number[] = [];
      for (let i = 0; i < t.length; i++) {
        if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
        else out.push(t.charCodeAt(i) & 0xff);
      }
      bytes = Uint8Array.from(out);
    }
    return new TextDecoder(charset.toLowerCase().replace(/^iso-8859-1$/, "latin1"), { fatal: false }).decode(bytes);
  } catch {
    return testo;
  }
}
export function oggettoDaIntestazioni(grezzo: string): string {
  const riga = grezzo.replace(/\r?\n[ \t]+/g, " ").match(/^subject:\s*(.*)$/im)?.[1] ?? "";
  return riga
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_t, cs, md, tx) => decodificaParola(cs, md, tx))
    .trim();
}

