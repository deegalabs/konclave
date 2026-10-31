// #313: "Copied" only when the clipboard really took the text. `navigator.clipboard.writeText`
// rejects on a non-secure context, a denied permission or an unfocused document; a fire-and-forget
// `void` on it left the rejection unhandled and the screen claiming success, which on Add funds could
// send a treasurer to paste a stale clipboard value where they believed the vault's address was.
// One function, so a screen cannot claim success without awaiting the write.

/** Write `text` to the clipboard. True when the browser confirmed it; false on any refusal. */
export async function copyText(text: string): Promise<boolean> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (!clip?.writeText) return false
  try {
    await clip.writeText(text)
    return true
  } catch {
    return false
  }
}
