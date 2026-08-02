// Canonical byte codecs (redesign cleanup): hex + base64 in one home instead of four
// (was duplicated across net-sign.ts, net.ts, storage.ts). hexToBytes is lenient (trims +
// lowercases) with an odd-length guard, so it serves both the strict wire parsing and the
// internal storage IDs. All byte<->string conversion for the frontend lives here.

export function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

export function hexToBytes(s: string): Uint8Array {
  const clean = s.trim().toLowerCase()
  if (clean.length % 2 !== 0) throw new Error('odd-length hex')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function b64(bytes: Uint8Array): string {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s)
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
