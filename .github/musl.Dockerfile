# Both official images provide native amd64 and arm64 variants on Alpine 3.23.
FROM node:24-alpine3.23 AS node
FROM rust:1.98.1-alpine3.23
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN apk add --no-cache libstdc++ make git \
    && ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && rustup component add rustfmt clippy
# napi-rs defaults ARM64 musl to a cross-linker name; these are native compilers.
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=gcc \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=gcc
ENV RUSTFLAGS="-C target-feature=-crt-static"
WORKDIR /work
