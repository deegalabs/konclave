// Trigger a client-side file download of some text (no server, local-first). Used to save a portable
// vault export (#214) as a file the user can move to another device or keep as a backup. Answers
// false when the browser refused it (no object URLs, no click), so a caller can say so and keep its
// copy-to-clipboard path in front of the member instead of claiming the file is on its way.
export function downloadText(filename: string, text: string, mime = 'application/json'): boolean {
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
    return true
  } catch {
    return false // download blocked - the caller's copy-to-clipboard path is the fallback
  }
}
