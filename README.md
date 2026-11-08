# Main{Create} builders

Host service, runner adapters, device discovery, and host installation scripts for Main{Create}. The initial import comes from upstream commit `f25069c0d6d10e510b1eb0fcdc63862372d57687`.

Shared Go sources live in `host/`. Each OS and architecture has its own directory under `targets/` for platform-specific version and packaging metadata. Go uses `darwin` for macOS and `amd64` for x64.

Linux ARM64 is the current supported target. Its version must match the version reported by the host executable. Keep other targets planned until their enrollment, execution, and upgrade paths pass on the target OS and architecture.

Run `(cd host && go test ./...)` and `node --test runner/service.test.mjs` before publishing. For Linux ARM64, cross-compile with `(cd host && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -o /tmp/maincreate-host-linux-arm64 .)`.

[main-platform](https://github.com/maincreate/main-platform) pins and vendors the host, runner, and installer sources so its image can build without downloading from this repository.
