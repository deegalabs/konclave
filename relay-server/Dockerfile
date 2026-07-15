# Konclave blind relay — standalone, public (CORS). Tiny image, no heavy deps.
FROM rust:1-slim AS build
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release --bin relay-server

FROM debian:stable-slim
RUN useradd -m relay
USER relay
COPY --from=build /app/target/release/relay-server /usr/local/bin/relay-server
ENV PORT=8080
EXPOSE 8080
CMD ["relay-server"]
