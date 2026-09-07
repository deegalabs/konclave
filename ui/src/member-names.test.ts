import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// Signers must be shown by name whenever this device knows one.
//
// The ceremony drawer read its roster from the helper alone, so any failure to fetch it - a 401
// before the vault is unlocked, an offline moment - turned every signer into "member 1", "member 2",
// "member 3". Seen live, on a vault whose helper had the names the whole time and whose DEVICE had
// them too, in the roster the create/join ceremony agreed on.
//
// It matters more than a cosmetic label usually would: identity in this product IS the name and
// seats are positional, so a screen asking someone to approve a payment while calling the other
// signers "member 2" has removed the only thing that says who is in the room.
//
// Asserted on the source rather than through the function, deliberately. `api.ts` decides NET mode
// at module load from `helperConfigured()`, so exercising this branch means faking the module graph
// hard enough that the test starts asserting the fake. What actually broke was the ORDER of three
// fallbacks, and the order is visible right here.

const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

/** The expression that names each seat, lifted out of `getVault`'s net branch. */
function namePicker(): string {
  const from = api.indexOf('const member_list = Array.from(')
  expect(from, 'member_list is not built where this test expects').toBeGreaterThan(-1)
  return api.slice(from, api.indexOf('})', from))
}

describe('who the ceremony says is in the room', () => {
  const picker = namePicker()

  it('consults the helper roster, then this device own roster, then a placeholder', () => {
    const helper = picker.indexOf('names[i]')
    const local = picker.indexOf('local[i]')
    const placeholder = picker.indexOf('member ${i + 1}')
    expect(helper, 'the helper roster is not consulted').toBeGreaterThan(-1)
    expect(local, 'this device own roster is not consulted - the live bug').toBeGreaterThan(-1)
    expect(placeholder, 'the numbered placeholder is gone').toBeGreaterThan(-1)
    expect(helper).toBeLessThan(local)
    expect(local).toBeLessThan(placeholder)
  })

  it('the local roster comes from the device record, not invented', () => {
    const decl = api.slice(api.indexOf('const local ='), api.indexOf('\n', api.indexOf('const local =')))
    expect(decl).toContain('rec?.roster')
  })

  it('a missing record cannot throw the whole vault read', () => {
    // `listVaults` rejects in a private window or with storage blocked. The vault must still load;
    // losing names is a degradation, losing the screen is an outage.
    const read = api.slice(api.indexOf('rec = (await listVaults())'))
    expect(read.slice(0, 200)).toMatch(/catch\s*\{/)
  })

  it('every seat still gets an entry, so the vote UI keeps one option per seat', () => {
    expect(picker).toContain('Array.from({ length: total }')
  })
})
