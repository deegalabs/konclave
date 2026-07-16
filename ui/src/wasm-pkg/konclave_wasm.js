/* @ts-self-types="./konclave_wasm.d.ts" */

/**
 * Coordinator (JS): accumulates the public wire material and produces the signature.
 */
export class Coordinator {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CoordinatorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_coordinator_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} id
     * @param {Uint8Array} commitment
     */
    addCommitment(id, commitment) {
        const ptr0 = passArray8ToWasm0(id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(commitment, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.coordinator_addCommitment(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * @param {Uint8Array} id
     * @param {Uint8Array} share
     */
    addShare(id, share) {
        const ptr0 = passArray8ToWasm0(id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(share, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.coordinator_addShare(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * @returns {Uint8Array}
     */
    aggregate() {
        const ret = wasm.coordinator_aggregate(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * REAL-TRANSACTION path: aggregate the accumulated shares under the given Orchard randomizer
     * (alpha) instead of the seed. The message must be the shielded sighash and the shares must
     * have been produced by `participantRound2WithRandomizer` with the SAME alpha.
     * @param {Uint8Array} randomizer
     * @returns {Uint8Array}
     */
    aggregateWithRandomizer(randomizer) {
        const ptr0 = passArray8ToWasm0(randomizer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.coordinator_aggregateWithRandomizer(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * @param {Uint8Array} group_vk
     * @param {Uint8Array} pubkeys
     * @param {Uint8Array} message
     */
    constructor(group_vk, pubkeys, message) {
        const ptr0 = passArray8ToWasm0(group_vk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(pubkeys, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.coordinator_new(ptr0, len0, ptr1, len1, ptr2, len2);
        this.__wbg_ptr = ret;
        CoordinatorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Build the signing package + randomizer seed (both public). Returns nothing; read via getters.
     */
    prepare() {
        const ret = wasm.coordinator_prepare(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {Uint8Array}
     */
    seed() {
        const ret = wasm.coordinator_seed(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    signingPackage() {
        const ret = wasm.coordinator_signingPackage(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {Uint8Array} sig
     * @returns {boolean}
     */
    verify(sig) {
        const ptr0 = passArray8ToWasm0(sig, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.coordinator_verify(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Verify a group signature under the key re-randomized by the given alpha — the exact check
     * an Orchard spend passes on-chain.
     * @param {Uint8Array} randomizer
     * @param {Uint8Array} sig
     * @returns {boolean}
     */
    verifyWithRandomizer(randomizer, sig) {
        const ptr0 = passArray8ToWasm0(randomizer, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(sig, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.coordinator_verifyWithRandomizer(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
}
if (Symbol.dispose) Coordinator.prototype[Symbol.dispose] = Coordinator.prototype.free;

/**
 * A device's long-term encryption keypair for the confidential channel (round-2 sealing).
 * The public half rides in the invite; the secret half never leaves the device.
 */
export class DeviceKey {
    static __wrap(ptr) {
        const obj = Object.create(DeviceKey.prototype);
        obj.__wbg_ptr = ptr;
        DeviceKeyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DeviceKeyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_devicekey_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} bytes
     * @returns {DeviceKey}
     */
    static fromSecret(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.devicekey_fromSecret(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return DeviceKey.__wrap(ret[0]);
    }
    constructor() {
        const ret = wasm.devicekey_new();
        this.__wbg_ptr = ret;
        DeviceKeyFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Open a package sealed to this device. Errors on a wrong key or any tampering.
     * @param {Uint8Array} sealed
     * @param {Uint8Array} aad
     * @returns {Uint8Array}
     */
    open(sealed, aad) {
        const ptr0 = passArray8ToWasm0(sealed, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(aad, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.devicekey_open(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
    /**
     * @returns {Uint8Array}
     */
    publicBytes() {
        const ret = wasm.devicekey_publicBytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    secretBytes() {
        const ret = wasm.devicekey_secretBytes(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) DeviceKey.prototype[Symbol.dispose] = DeviceKey.prototype.free;

/**
 * A device's stateful DKG session. Round 1 runs on construction; JS then exchanges the
 * wire bytes over the relay and calls part2/part3. SecretPackages never leave this struct.
 */
export class DkgSession {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DkgSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_dkgsession_free(ptr, 0);
    }
    /**
     * Accept another member's round-1 package (public). Our own id is ignored.
     * @param {Uint8Array} sender_id
     * @param {Uint8Array} pkg
     */
    addRound1(sender_id, pkg) {
        const ptr0 = passArray8ToWasm0(sender_id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(pkg, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.dkgsession_addRound1(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * Accept a round-2 package addressed to me (already opened via DeviceKey.open),
     * keyed by the SENDER's id.
     * @param {Uint8Array} sender_id
     * @param {Uint8Array} pkg
     */
    addRound2(sender_id, pkg) {
        const ptr0 = passArray8ToWasm0(sender_id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(pkg, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.dkgsession_addRound2(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * The vault's identity: the 32-byte group verifying key. Every honest device derives
     * the SAME value — the UI shows it so both tabs can confirm they built one vault.
     * @returns {Uint8Array}
     */
    groupVk() {
        const ret = wasm.dkgsession_groupVk(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    keyPackage() {
        const ret = wasm.dkgsession_keyPackage(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    myId() {
        const ret = wasm.dkgsession_myId(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Round 1 on construction: keeps the round-1 secret local, exposes the public package.
     * @param {Uint8Array} my_id
     * @param {number} max_signers
     * @param {number} min_signers
     */
    constructor(my_id, max_signers, min_signers) {
        const ptr0 = passArray8ToWasm0(my_id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.dkgsession_new(ptr0, len0, max_signers, min_signers);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        DkgSessionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Round 2: consume the round-1 secret + collected round-1 packages. Produces one
     * round-2 package per recipient (read via round2Count/Recipient/Package). Each is
     * SECRET → JS must sealTo its recipient before it touches the relay.
     */
    part2() {
        const ret = wasm.dkgsession_part2(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Round 3: combine everything into this device's share + the shared group key.
     */
    part3() {
        const ret = wasm.dkgsession_part3(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {Uint8Array}
     */
    pubkeys() {
        const ret = wasm.dkgsession_pubkeys(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    round1Package() {
        const ret = wasm.dkgsession_round1Package(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    round2Count() {
        const ret = wasm.dkgsession_round2Count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} i
     * @returns {Uint8Array}
     */
    round2Package(i) {
        const ret = wasm.dkgsession_round2Package(this.__wbg_ptr, i);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {number} i
     * @returns {Uint8Array}
     */
    round2Recipient(i) {
        const ret = wasm.dkgsession_round2Recipient(this.__wbg_ptr, i);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) DkgSession.prototype[Symbol.dispose] = DkgSession.prototype.free;

/**
 * The recovering member: collect the helpers' sigmas and combine them into the repaired
 * KeyPackage (validated against the group's public share). Runs entirely on this device.
 */
export class RecoveryCombiner {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RecoveryCombinerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_recoverycombiner_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} sigma
     */
    addSigma(sigma) {
        const ptr0 = passArray8ToWasm0(sigma, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.recoverycombiner_addSigma(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Combine → the repaired KeyPackage bytes. Errors if the result doesn't match the group.
     * @returns {Uint8Array}
     */
    keyPackage() {
        const ret = wasm.recoverycombiner_keyPackage(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {Uint8Array} lost_id
     * @param {Uint8Array} pubkeys
     */
    constructor(lost_id, pubkeys) {
        const ptr0 = passArray8ToWasm0(lost_id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(pubkeys, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.recoverycombiner_new(ptr0, len0, ptr1, len1);
        this.__wbg_ptr = ret;
        RecoveryCombinerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) RecoveryCombiner.prototype[Symbol.dispose] = RecoveryCombiner.prototype.free;

/**
 * A helper's recovery session. Register the helper set (including self), compute the
 * per-recipient deltas (round 1), then sum the deltas received into this helper's sigma
 * (round 2). The helper's own KeyPackage stays local; only deltas/sigma cross the wire.
 */
export class RecoveryHelper {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RecoveryHelperFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_recoveryhelper_free(ptr, 0);
    }
    /**
     * Register a helper's identifier — call once per helper seat, INCLUDING this one.
     * @param {Uint8Array} id
     */
    addHelper(id) {
        const ptr0 = passArray8ToWasm0(id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.recoveryhelper_addHelper(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Collect a delta (already opened) addressed to me, from any helper.
     * @param {Uint8Array} delta
     */
    addIncomingDelta(delta) {
        const ptr0 = passArray8ToWasm0(delta, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.recoveryhelper_addIncomingDelta(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Round 1: produce one delta per helper (read via deltaCount/deltaRecipient/delta).
     */
    computeDeltas() {
        const ret = wasm.recoveryhelper_computeDeltas(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} i
     * @returns {Uint8Array}
     */
    delta(i) {
        const ret = wasm.recoveryhelper_delta(this.__wbg_ptr, i);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {number}
     */
    deltaCount() {
        const ret = wasm.recoveryhelper_deltaCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} i
     * @returns {Uint8Array}
     */
    deltaRecipient(i) {
        const ret = wasm.recoveryhelper_deltaRecipient(this.__wbg_ptr, i);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {Uint8Array} my_key_package
     * @param {Uint8Array} lost_id
     */
    constructor(my_key_package, lost_id) {
        const ptr0 = passArray8ToWasm0(my_key_package, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(lost_id, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.recoveryhelper_new(ptr0, len0, ptr1, len1);
        this.__wbg_ptr = ret;
        RecoveryHelperFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Round 2: sum the received deltas into this helper's sigma bytes (sealed to the member).
     * @returns {Uint8Array}
     */
    sigma() {
        const ret = wasm.recoveryhelper_sigma(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) RecoveryHelper.prototype[Symbol.dispose] = RecoveryHelper.prototype.free;

/**
 * Participant round-1 output: nonces stay on THIS device; commitment goes to the relay.
 */
export class Round1 {
    static __wrap(ptr) {
        const obj = Object.create(Round1.prototype);
        obj.__wbg_ptr = ptr;
        Round1Finalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Round1Finalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_round1_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    commitment() {
        const ret = wasm.round1_commitment(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    nonces() {
        const ret = wasm.round1_nonces(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) Round1.prototype[Symbol.dispose] = Round1.prototype.free;

/**
 * Test-only trusted-dealer 2-of-3, so JS can drive a ceremony end-to-end. The product
 * uses DKG; the key packages here stand in for the unlocked device shares.
 */
export class TestVault {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TestVaultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_testvault_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    groupVk() {
        const ret = wasm.testvault_groupVk(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {number} i
     * @returns {Uint8Array}
     */
    id(i) {
        const ret = wasm.testvault_id(this.__wbg_ptr, i);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {number} i
     * @returns {Uint8Array}
     */
    key_package(i) {
        const ret = wasm.testvault_key_package(this.__wbg_ptr, i);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    constructor() {
        const ret = wasm.testvault_new();
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        TestVaultFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {Uint8Array}
     */
    pubkeys() {
        const ret = wasm.testvault_pubkeys(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) TestVault.prototype[Symbol.dispose] = TestVault.prototype.free;

/**
 * Read every Orchard output of a proven PCZT as JSON: `[{"address": string|null, "value":
 * number|null}, ...]`. The UI shows this and confirms it against the approved proposal BEFORE
 * the device signs — the "what am I signing?" check. Addressed entries are real recipients;
 * `address: null` entries are change. Values are zatoshis.
 * @param {Uint8Array} pczt
 * @returns {string}
 */
export function describeOutputs(pczt) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(pczt, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.describeOutputs(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Read the `(action_index, alpha)` randomizers of the real Orchard spends from a proven PCZT.
 * Returns a flat buffer of 36-byte records: u32-LE index then 32-byte alpha.
 * @param {Uint8Array} pczt
 * @returns {Uint8Array}
 */
export function extractRandomizers(pczt) {
    const ptr0 = passArray8ToWasm0(pczt, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.extractRandomizers(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Deterministic identifier bytes for participant number `index` (1-based), so every device
 * agrees on who is who without a central registry.
 * @param {number} index
 * @returns {Uint8Array}
 */
export function identifierBytes(index) {
    const ret = wasm.identifierBytes(index);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * Apply FROST redpallas signatures to a proven PCZT and return the signed PCZT bytes.
 * `sighash` is the 32-byte shielded sighash; `sigs` is a flat buffer of 68-byte records:
 * u32-LE index then 64-byte signature.
 * @param {Uint8Array} pczt
 * @param {Uint8Array} sighash
 * @param {Uint8Array} sigs
 * @returns {Uint8Array}
 */
export function injectSigs(pczt, sighash, sigs) {
    const ptr0 = passArray8ToWasm0(pczt, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(sighash, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(sigs, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.injectSigs(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}

/**
 * Participant device, round 1 (JS): from the local key-package bytes.
 * @param {Uint8Array} kp_bytes
 * @returns {Round1}
 */
export function participantRound1(kp_bytes) {
    const ptr0 = passArray8ToWasm0(kp_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.participantRound1(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return Round1.__wrap(ret[0]);
}

/**
 * Participant device, round 2 (JS): sign with the local nonces + seed.
 * @param {Uint8Array} sp
 * @param {Uint8Array} nonces_bytes
 * @param {Uint8Array} kp_bytes
 * @param {Uint8Array} seed
 * @returns {Uint8Array}
 */
export function participantRound2(sp, nonces_bytes, kp_bytes, seed) {
    const ptr0 = passArray8ToWasm0(sp, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(nonces_bytes, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(kp_bytes, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(seed, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.participantRound2(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v5 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v5;
}

/**
 * Participant device, round 2 (JS), REAL-TRANSACTION path: sign with the given Orchard
 * randomizer (the 32-byte alpha from pczt_bridge.extractRandomizers) instead of a seed, so the
 * signature can be injected into the PCZT and broadcast.
 * @param {Uint8Array} sp
 * @param {Uint8Array} nonces_bytes
 * @param {Uint8Array} kp_bytes
 * @param {Uint8Array} randomizer
 * @returns {Uint8Array}
 */
export function participantRound2WithRandomizer(sp, nonces_bytes, kp_bytes, randomizer) {
    const ptr0 = passArray8ToWasm0(sp, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(nonces_bytes, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(kp_bytes, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(randomizer, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.participantRound2WithRandomizer(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v5 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v5;
}

/**
 * Seal `plaintext` to a recipient's 32-byte public key (used on each round-2 package so the
 * relay only ever carries ciphertext). `aad` binds context (sender+recipient) into the tag.
 * @param {Uint8Array} recipient_pub
 * @param {Uint8Array} plaintext
 * @param {Uint8Array} aad
 * @returns {Uint8Array}
 */
export function sealTo(recipient_pub, plaintext, aad) {
    const ptr0 = passArray8ToWasm0(recipient_pub, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(aad, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.sealTo(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}

/**
 * Browser self-test: runs a full FROST ceremony, touches the Orchard + digest surfaces.
 * Returns "OK: …" or "ERR: …". Proves the assembled module runs in a real browser.
 * @returns {string}
 */
export function selftest() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.selftest();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Verify a group signature against the vault's key — so EVERY device confirms the result
 * for itself, not on the coordinator's word. All inputs are public (signing package, seed,
 * message, signature); the share never enters.
 * @param {Uint8Array} group_vk
 * @param {Uint8Array} sp
 * @param {Uint8Array} seed
 * @param {Uint8Array} message
 * @param {Uint8Array} sig
 * @returns {boolean}
 */
export function verifyRedpallas(group_vk, sp, seed, message, sig) {
    const ptr0 = passArray8ToWasm0(group_vk, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(sp, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(seed, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray8ToWasm0(sig, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.verifyRedpallas(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_function_1ff95bcc5517c252: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_a27215656b807791: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_a6e5c5dce5018821: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_crypto_38df2bab126b63dc: function(arg0) {
            const ret = arg0.crypto;
            return ret;
        },
        __wbg_getRandomValues_c44a50d8cfdaebeb: function() { return handleError(function (arg0, arg1) {
            arg0.getRandomValues(arg1);
        }, arguments); },
        __wbg_length_1f0964f4a5e2c6d8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_msCrypto_bd5a034af96bcba6: function(arg0) {
            const ret = arg0.msCrypto;
            return ret;
        },
        __wbg_new_with_length_e6785c33c8e4cce8: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_node_84ea875411254db1: function(arg0) {
            const ret = arg0.node;
            return ret;
        },
        __wbg_process_44c7a14e11e9f69e: function(arg0) {
            const ret = arg0.process;
            return ret;
        },
        __wbg_prototypesetcall_4770620bbe4688a0: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_randomFillSync_6c25eac9869eb53c: function() { return handleError(function (arg0, arg1) {
            arg0.randomFillSync(arg1);
        }, arguments); },
        __wbg_require_b4edbdcf3e2a1ef0: function() { return handleError(function () {
            const ret = module.require;
            return ret;
        }, arguments); },
        __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_146583524fe1469b: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f2829a2234d7819e: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_subarray_3ed232c8a6baee09: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_versions_276b2795b1c6a219: function(arg0) {
            const ret = arg0.versions;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(U8)) -> NamedExternref("Uint8Array")`.
            const ret = getArrayU8FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./konclave_wasm_bg.js": import0,
    };
}

const CoordinatorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_coordinator_free(ptr, 1));
const DeviceKeyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_devicekey_free(ptr, 1));
const DkgSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_dkgsession_free(ptr, 1));
const RecoveryCombinerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_recoverycombiner_free(ptr, 1));
const RecoveryHelperFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_recoveryhelper_free(ptr, 1));
const Round1Finalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_round1_free(ptr, 1));
const TestVaultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_testvault_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('konclave_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
