// The rule the create screen offers: how many devices, and what it recommends when every device has
// to sign. One module so the cap the stepper enforces and the rule the warning recommends cannot
// drift apart (#839: the stepper stopped at 5 and the warning still recommended "5 of 6").

/** The most devices the create screen offers (#839). The protocol and the coordinator accept up to
 *  MAX_SEATS (32); the screen stays at 5 until a creation with more devices has been tested. */
export const CREATE_DEVICE_CAP = 5

type Pe = (pt: string, en: string) => string

/** The rule to recommend instead of t of t: one device more, so losing one does not lock the funds;
 *  at the cap the screen cannot add a device, so one signature fewer on the same devices. */
export function recommendedRule(t: number): { t: number; n: number } {
  return t < CREATE_DEVICE_CAP ? { t, n: t + 1 } : { t: CREATE_DEVICE_CAP - 1, n: CREATE_DEVICE_CAP }
}

/** The warning under a rule where every device has to sign (t of t). */
export function noMarginWarning(t: number, pe: Pe): string {
  const r = recommendedRule(t)
  return pe(
    `Se um aparelho for perdido, os fundos ficam presos, sem como recuperar. Recomendamos ${r.t} de ${r.n}.`,
    `If one device is lost, the funds are locked, with no way to recover. We recommend ${r.t} of ${r.n}.`,
  )
}
