// Trigger a client-side file download of some text (no server, local-first). Used to save a portable
// vault export (#214) as a file the user can move to another device or keep as a backup. Falls back
// silently if the browser blocks object URLs; callers also offer copy-to-clipboard as an alternative.
export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  try {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoke on the next tick so the click has taken effect first.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch {
    /* download blocked - the caller's copy-to-clipboard path is the fallback */
  }
}
