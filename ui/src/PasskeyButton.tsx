// The passkey shortcut, as ONE button used by both unlock surfaces (#469).
//
// It was `className="rm-backup"` in two places - the class belonging to "back up before removing",
// borrowed because it looked about right. So the most reassuring control in the product wore the
// styling of an unrelated one, and any change to it would have had to be made twice.
//
// The look is deliberate: this is the control that says "your fingerprint opens this", so it gets
// the icon and the width to be recognised at a glance, the way an OS sign-in sheet does. It stays
// SECONDARY to the passphrase field below it, because the passphrase is the key and this is only a
// shortcut - a member without an enrolled device must never feel they are missing the real door.

import { useT } from './i18n'

/** A fingerprint, drawn rather than fetched: it must render on a locked screen with nothing loaded,
 *  and it is the same stroked 24-grid the rail icons use. */
function FingerprintIcon() {
  const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' } as const
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" {...s}>
      <path d="M12 10.5v3.2a7 7 0 0 1-.9 3.4" />
      <path d="M9 9.3a3.6 3.6 0 0 1 6 2.7v1.4a10 10 0 0 1-.6 3.4" />
      <path d="M6.2 11.6a5.9 5.9 0 0 1 2.2-4.9" />
      <path d="M17.8 12.4v1.1a13 13 0 0 1-.5 3.4" />
      <path d="M4.6 7.6A8.6 8.6 0 0 1 19 10.4" />
    </svg>
  )
}

export interface PasskeyButtonProps {
  busy: boolean
  onClick: () => void
}

export default function PasskeyButton({ busy, onClick }: PasskeyButtonProps) {
  const t = useT()
  return (
    <button type="button" className="passkey-btn" disabled={busy} onClick={onClick}>
      <FingerprintIcon />
      <span>{busy ? t('vaults.passkeyBusy') : t('vaults.passkeyUnlock')}</span>
    </button>
  )
}
