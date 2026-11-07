// The rule the create screen offers: how many devices, and what it recommends when every device has
// to sign. One module so the cap the stepper enforces and the rule the warning recommends cannot
// drift apart (#839: the stepper stopped at 5 and the warning still recommended "5 of 6").

/** How many devices the create screen lets a vault have today (D73, #839). The protocol allows 32
 *  and the app's N_MAX is 16; the screen stays at 5 until a creation with more devices is tested. */
export const CREATE_DEVICE_CAP = 5

type Pe = (pt: string, en: string) => string

/** The warning under a rule where every device has to sign (t of t). */
export function noMarginWarning(t: number, pe: Pe): string {
  return pe(
    `Se um aparelho for perdido, os fundos ficam presos, sem como recuperar. Recomendamos ${t} de ${t + 1}.`,
    `If one device is lost, the funds are locked, with no way to recover. We recommend ${t} of ${t + 1}.`,
  )
}
