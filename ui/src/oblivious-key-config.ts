// The gateway key configuration this build PINS, as hex of the exact bytes the gateway serves
// (application/ohttp-keys): one entry, X25519 / HKDF-SHA256 / AES-128-GCM, nothing else.
//
// It is read by `oblivious-transport.ts` and by nothing else (a test scans for it). The app never
// asks the coordinator for its key: a key the coordinator hands out is whatever the coordinator
// chose for whoever asked, and the mode exists to stop it choosing per address. To rotate, a new
// key with a NEW key id is generated, the operator prints its configuration, it is pasted here, and
// it ships with an app release; an app that has not updated is told `update_required`.
//
// EMPTY, on purpose: nothing is pinned until private mode exists and a key has been chosen, and
// with nothing pinned the transport sends nothing.
export const PINNED_KEY_CONFIG_HEX = ''
