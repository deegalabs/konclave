/* tslint:disable */
/* eslint-disable */

/**
 * Coordinator (JS): accumulates the public wire material and produces the signature.
 */
export class Coordinator {
    free(): void;
    [Symbol.dispose](): void;
    addCommitment(id: Uint8Array, commitment: Uint8Array): void;
    addShare(id: Uint8Array, share: Uint8Array): void;
    aggregate(): Uint8Array;
    constructor(group_vk: Uint8Array, pubkeys: Uint8Array, message: Uint8Array);
    /**
     * Build the signing package + randomizer seed (both public). Returns nothing; read via getters.
     */
    prepare(): void;
    seed(): Uint8Array;
    signingPackage(): Uint8Array;
    verify(sig: Uint8Array): boolean;
}

/**
 * A device's long-term encryption keypair for the confidential channel (round-2 sealing).
 * The public half rides in the invite; the secret half never leaves the device.
 */
export class DeviceKey {
    free(): void;
    [Symbol.dispose](): void;
    static fromSecret(bytes: Uint8Array): DeviceKey;
    constructor();
    /**
     * Open a package sealed to this device. Errors on a wrong key or any tampering.
     */
    open(sealed: Uint8Array, aad: Uint8Array): Uint8Array;
    publicBytes(): Uint8Array;
    secretBytes(): Uint8Array;
}

/**
 * A device's stateful DKG session. Round 1 runs on construction; JS then exchanges the
 * wire bytes over the relay and calls part2/part3. SecretPackages never leave this struct.
 */
export class DkgSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Accept another member's round-1 package (public). Our own id is ignored.
     */
    addRound1(sender_id: Uint8Array, pkg: Uint8Array): void;
    /**
     * Accept a round-2 package addressed to me (already opened via DeviceKey.open),
     * keyed by the SENDER's id.
     */
    addRound2(sender_id: Uint8Array, pkg: Uint8Array): void;
    /**
     * The vault's identity: the 32-byte group verifying key. Every honest device derives
     * the SAME value — the UI shows it so both tabs can confirm they built one vault.
     */
    groupVk(): Uint8Array;
    keyPackage(): Uint8Array;
    myId(): Uint8Array;
    /**
     * Round 1 on construction: keeps the round-1 secret local, exposes the public package.
     */
    constructor(my_id: Uint8Array, max_signers: number, min_signers: number);
    /**
     * Round 2: consume the round-1 secret + collected round-1 packages. Produces one
     * round-2 package per recipient (read via round2Count/Recipient/Package). Each is
     * SECRET → JS must sealTo its recipient before it touches the relay.
     */
    part2(): void;
    /**
     * Round 3: combine everything into this device's share + the shared group key.
     */
    part3(): void;
    pubkeys(): Uint8Array;
    round1Package(): Uint8Array;
    round2Count(): number;
    round2Package(i: number): Uint8Array;
    round2Recipient(i: number): Uint8Array;
}

/**
 * Participant round-1 output: nonces stay on THIS device; commitment goes to the relay.
 */
export class Round1 {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    commitment(): Uint8Array;
    nonces(): Uint8Array;
}

/**
 * Test-only trusted-dealer 2-of-3, so JS can drive a ceremony end-to-end. The product
 * uses DKG; the key packages here stand in for the unlocked device shares.
 */
export class TestVault {
    free(): void;
    [Symbol.dispose](): void;
    groupVk(): Uint8Array;
    id(i: number): Uint8Array;
    key_package(i: number): Uint8Array;
    constructor();
    pubkeys(): Uint8Array;
}

/**
 * Deterministic identifier bytes for participant number `index` (1-based), so every device
 * agrees on who is who without a central registry.
 */
export function identifierBytes(index: number): Uint8Array;

/**
 * Participant device, round 1 (JS): from the local key-package bytes.
 */
export function participantRound1(kp_bytes: Uint8Array): Round1;

/**
 * Participant device, round 2 (JS): sign with the local nonces + seed.
 */
export function participantRound2(sp: Uint8Array, nonces_bytes: Uint8Array, kp_bytes: Uint8Array, seed: Uint8Array): Uint8Array;

/**
 * Seal `plaintext` to a recipient's 32-byte public key (used on each round-2 package so the
 * relay only ever carries ciphertext). `aad` binds context (sender+recipient) into the tag.
 */
export function sealTo(recipient_pub: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array;

/**
 * Browser self-test: runs a full FROST ceremony, touches the Orchard + digest surfaces.
 * Returns "OK: …" or "ERR: …". Proves the assembled module runs in a real browser.
 */
export function selftest(): string;

/**
 * Verify a group signature against the vault's key — so EVERY device confirms the result
 * for itself, not on the coordinator's word. All inputs are public (signing package, seed,
 * message, signature); the share never enters.
 */
export function verifyRedpallas(group_vk: Uint8Array, sp: Uint8Array, seed: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_coordinator_free: (a: number, b: number) => void;
    readonly __wbg_round1_free: (a: number, b: number) => void;
    readonly __wbg_testvault_free: (a: number, b: number) => void;
    readonly coordinator_addCommitment: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly coordinator_addShare: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly coordinator_aggregate: (a: number) => [number, number, number, number];
    readonly coordinator_new: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly coordinator_prepare: (a: number) => [number, number];
    readonly coordinator_seed: (a: number) => [number, number];
    readonly coordinator_signingPackage: (a: number) => [number, number];
    readonly coordinator_verify: (a: number, b: number, c: number) => [number, number, number];
    readonly participantRound1: (a: number, b: number) => [number, number, number];
    readonly participantRound2: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly round1_commitment: (a: number) => [number, number];
    readonly round1_nonces: (a: number) => [number, number];
    readonly testvault_groupVk: (a: number) => [number, number];
    readonly testvault_id: (a: number, b: number) => [number, number];
    readonly testvault_key_package: (a: number, b: number) => [number, number];
    readonly testvault_new: () => [number, number, number];
    readonly testvault_pubkeys: (a: number) => [number, number];
    readonly __wbg_devicekey_free: (a: number, b: number) => void;
    readonly __wbg_dkgsession_free: (a: number, b: number) => void;
    readonly devicekey_fromSecret: (a: number, b: number) => [number, number, number];
    readonly devicekey_new: () => number;
    readonly devicekey_open: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly devicekey_publicBytes: (a: number) => [number, number];
    readonly devicekey_secretBytes: (a: number) => [number, number];
    readonly dkgsession_addRound1: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly dkgsession_addRound2: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly dkgsession_groupVk: (a: number) => [number, number];
    readonly dkgsession_keyPackage: (a: number) => [number, number];
    readonly dkgsession_myId: (a: number) => [number, number];
    readonly dkgsession_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly dkgsession_part2: (a: number) => [number, number];
    readonly dkgsession_part3: (a: number) => [number, number];
    readonly dkgsession_pubkeys: (a: number) => [number, number];
    readonly dkgsession_round1Package: (a: number) => [number, number];
    readonly dkgsession_round2Count: (a: number) => number;
    readonly dkgsession_round2Package: (a: number, b: number) => [number, number];
    readonly dkgsession_round2Recipient: (a: number, b: number) => [number, number];
    readonly identifierBytes: (a: number) => [number, number, number, number];
    readonly sealTo: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly verifyRedpallas: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number, number];
    readonly selftest: () => [number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
