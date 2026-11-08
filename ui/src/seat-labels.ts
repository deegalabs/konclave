// Who sits where, as this device names it.

type Listed = { member_list?: { name: string; pubkey: string }[]; own_members?: string[] } | null | undefined

/** A seat is who this device saw create it: its own list where the lists differ, by position. */
export function seatRoster(vault: Listed): { name: string; pubkey: string }[] {
  return vault?.own_members?.map((name) => ({ name, pubkey: name })) ?? vault?.member_list ?? []
}

/** This device's own seat in that list, by number: a name moves with a rename, a seat does not. */
export function mySeatName(own: string[] | undefined, seat: number | undefined, name: string | null): string | null {
  return (own && seat !== undefined ? own[seat - 1] : undefined) ?? name
}
