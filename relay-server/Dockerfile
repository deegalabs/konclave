# Konclave blind relay - standalone, public (CORS). Tiny image, no heavy deps.
FROM rust:1-slim AS build
WORKDIR /app
COPY Cargo.toml ./
# build.rs stamps a digest of these sources into the binary so /health can say what it is
# running (#522). Without this COPY the build script simply never runs and the relay reports a
# digest of nothing, which is the failure this whole change exists to avoid.
COPY build.rs ./
COPY src ./src
RUN cargo build --release --bin relay-server

FROM debian:stable-slim
RUN useradd -m relay
USER relay
COPY --from=build /app/target/release/relay-server /usr/local/bin/relay-server
ENV PORT=8080
EXPOSE 8080
CMD ["relay-server"]
