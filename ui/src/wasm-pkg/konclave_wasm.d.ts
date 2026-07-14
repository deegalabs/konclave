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
 * Participant device, round 1 (JS): from the local key-package bytes.
 */
export function participantRound1(kp_bytes: Uint8Array): Round1;

/**
 * Participant device, round 2 (JS): sign with the local nonces + seed.
 */
export function participantRound2(sp: Uint8Array, nonces_bytes: Uint8Array, kp_bytes: Uint8Array, seed: Uint8Array): Uint8Array;

/**
 * Browser self-test: runs a full FROST ceremony, touches the Orchard + digest surfaces.
 * Returns "OK: …" or "ERR: …". Proves the assembled module runs in a real browser.
 */
export function selftest(): string;

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
