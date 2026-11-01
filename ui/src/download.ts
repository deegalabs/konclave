// Trigger a client-side file download (no server, local-first). One implementation for every
// export: the portable vault export (#214) as text, and the ledger's XLSX and CSV as blobs. Answers
// false when the browser refused it (no object URLs, no click), so a caller can say so and keep its
// copy-to-clipboard path in front of the member instead of claiming the file is on its way.
export function downloadBlob(filename: string, blob: Blob): boolean {
  try {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoke on the next tick so the click has taken effect first.
    setTimeout(() => URL.revokeObjectURL(url), 0)
    return true
  } catch {
    return false // download blocked - the caller's copy-to-clipboard path is the fallback
  }
}

/** Download some text as a file; the vault export's entry point, kept for its callers. */
export function downloadText(filename: string, text: string, mime = 'application/json'): boolean {
  return downloadBlob(filename, new Blob([text], { type: mime }))
}
