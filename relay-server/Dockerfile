# Konclave blind relay - standalone, public (CORS). Tiny image, no heavy deps.
#
# THE BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory, and that is the whole point of the
# paths below. On 2026-09-07 the relay gained `konclave-http` as a path dependency (#500, which moved
# the request-body ceiling into one crate both public servers read). A Docker build only sees what is
# inside its context and cannot reach a parent, so with the context set to `relay-server/` the build
# failed on `failed to read /konclave-http/Cargo.toml` - every time, deterministically, from that day
# on.
#
# Nobody saw it because a build only runs when someone deploys, and the relay had not needed one
# since 2026-08-28. It was found on 2026-09-17 while adding the build marker, by running the build
# rather than reasoning about it. The failure was waiting for whoever next needed to ship a relay fix
# in a hurry, which is the worst possible audience for it.
#
# Railway must be told where this file lives, since the context root no longer contains it:
#   RAILWAY_DOCKERFILE_PATH=relay-server/Dockerfile
# and `railway up` is run from the repository root. `.dockerignore` keeps the context to the two
# crates this build actually needs.
FROM rust:1-slim AS build
WORKDIR /app

# Only the two crates the relay needs. Copied explicitly rather than with a wildcard so that a third
# dependency appearing in Cargo.toml fails the build HERE, loudly, instead of at whatever hour
# someone is trying to ship. The list is the same list as `relay-server/Cargo.toml`'s path deps.
COPY konclave-http ./konclave-http
COPY relay-server/Cargo.toml ./relay-server/Cargo.toml
COPY relay-server/build.rs ./relay-server/build.rs
COPY relay-server/src ./relay-server/src

WORKDIR /app/relay-server
RUN cargo build --release --bin relay-server

FROM debian:stable-slim
RUN useradd -m relay
USER relay
COPY --from=build /app/relay-server/target/release/relay-server /usr/local/bin/relay-server
ENV PORT=8080
EXPOSE 8080
CMD ["relay-server"]
