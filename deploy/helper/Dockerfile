# Konclave hosted BLIND helper (ADR-0006, Rung A) - testnet demo image.
#
# DELIBERATE TRADEOFF: this image bundles the engine binaries built from source on the
# maintainer's machine at the pins in engine/versions.lock (frost-tools 3d2985c for
# zcash-sign; the Ironwood librustzcash 42ffd0d for zcash-devtool + konclave-signer),
# rather than compiling them in-image. A from-source multi-stage build is the hardening
# follow-up; for the testnet demo it would blow Railway's build limits (librustzcash +
# orchard + halo2). The binaries are glibc-2.39 (Ubuntu 24.04), so the runtime is pinned
# to ubuntu:24.04. The helper is BLIND: it never receives, derives, or stores a share.
FROM ubuntu:24.04

# curl is required at runtime: the Architecture-B send (net_orchestrate_send) shells out to
# curl as its relay transport (RelayClient/CurlTransport) to publish the sign-request.
# gosu lets the entrypoint drop from root to the non-root user after fixing volume ownership.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gosu \
 && rm -rf /var/lib/apt/lists/*

COPY bin/helper-server bin/zcash-sign bin/zcash-devtool bin/konclave-signer /usr/local/bin/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/helper-server /usr/local/bin/zcash-sign \
             /usr/local/bin/zcash-devtool /usr/local/bin/konclave-signer \
             /usr/local/bin/entrypoint.sh

# Run the helper as a non-root system user (defense in depth; it is blind to shares by design).
# The container still ENTERs as root so the entrypoint can chown the root-owned Railway volume,
# then drops to this user via gosu before exec'ing the helper.
RUN useradd --system --uid 10001 --user-group --home-dir /data --shell /usr/sbin/nologin konclave
WORKDIR /data
RUN mkdir -p /data && chown -R konclave:konclave /data

ENV KONCLAVE_ZCASH_SIGN=/usr/local/bin/zcash-sign \
    KONCLAVE_DEVTOOL=/usr/local/bin/zcash-devtool \
    KONCLAVE_SIGNER=/usr/local/bin/konclave-signer \
    KONCLAVE_NETWORK=main \
    KONCLAVE_LIGHTWALLETD=zec.rocks:443 \
    KONCLAVE_VAULTS_DIR=/data/vaults

# Railway injects PORT; the helper binds KONCLAVE_HELPER_ADDR. Bind 0.0.0.0 so the public
# edge can reach it (blind-by-design, like the relay - no loopback guard here). The entrypoint
# fixes volume ownership as root, then drops to the non-root konclave user before running this.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sh", "-c", "KONCLAVE_HELPER_ADDR=0.0.0.0:${PORT:-4780} helper-server"]
