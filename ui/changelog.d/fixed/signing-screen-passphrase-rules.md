- **The signing sheet now behaves like the dialog it says it is.** It announced itself as modal but
  left focus on the button behind it, let Tab walk the page underneath, and had no Escape or focus
  return. Focus now moves into the sheet, Tab stays inside, and closing returns you to the button that
  opened it. Escape closes it only while this device is not signing or waiting on a signature: closing stops the signer.
- **The confirm can no longer change from "Sign" to "Send" in silence.** If another member signed while
  the confirm was open, its wording became "Send" without a word to a screen reader. It now closes and
  says the signatures changed, so you read it again.
- **Waiting, ready and "checking whether the payment went out" are now announced** by a screen reader.
