# Main{Create} builders

Main{Create} Host Service, runner, and device discovery for **Linux ARM64** (Raspberry Pi/ARM systems) and **Linux x64** (Debian VMs / x86 mini PCs). Both have one consistent install, validation, remote-upgrade, and cleanup lifecycle. The shared Go Host Service is compiled for each architecture; the installer auto-detects the machine, checks the selected portal architecture, downloads the matching published binary and verifies its SHA-256 checksum.

## Choose the correct installer in the portal

Go to **Main{Create} > Builders > Add a Build Machine** and choose **Linux ARM64** or **Linux x64**. Each tab provides an independent **one-line** command. On the machine, check the CPU with `uname -m` if unsure:

| OS and CPU | `uname -m` | Portal selection | Expected architecture | Host binary | GitHub runner |
|---|---|---|---|---|---|
| Raspberry Pi OS / Debian ARM64 | `aarch64` | Linux ARM64 | `arm64` | `maincreate-host-linux-arm64` | `actions-runner-linux-arm64` |
| Debian 13 / Ubuntu x86-64 | `x86_64` | Linux x64 | `amd64` | `maincreate-host-linux-amd64` | `actions-runner-linux-x64` |

**Linux x64 one-line install:**

```bash
curl -fsSLo /tmp/maincreate-install.sh https://main.ayusohaylock.com/install.sh && sudo env MAIN_CONTROLLER_URL=https://main.ayusohaylock.com MAIN_EXPECTED_ARCH=amd64 bash /tmp/maincreate-install.sh
```

**Linux ARM64 one-line install:**

```bash
curl -fsSLo /tmp/maincreate-install.sh https://main.ayusohaylock.com/install.sh && sudo env MAIN_CONTROLLER_URL=https://main.ayusohaylock.com MAIN_EXPECTED_ARCH=arm64 bash /tmp/maincreate-install.sh
```

Change the controller URL if using a different HTTPS instance. Both one-liners download to a temporary script file and run the **same** installer, but the portal-selected expected architecture prevents accidentally installing the wrong build. Linux with `apt` and `systemd` is required. Other operating systems are not enabled.

## Lifecycle: same experience on both Linux architectures

1. **Install:** preflight OS, architecture, root and dependencies; verify binary checksum; atomically install the Host Service; create restricted runner OS user; install systemd service and narrowly scoped `join` sudo rule.
2. **Pair:** use Builders wizard, enter host IP or hostname and local SSH credentials, verify SSH fingerprint; host enrollment is distinct from GitHub registration.
3. **Validate:** verify service active, Host Service heartbeat/version and packages, GitHub runner registration and Online status using **Validate runner**.
4. **Register GitHub runner:** controller issues a short-lived registration credential, the host downloads the official architecture-matched GitHub Actions runner and verifies its SHA-256 checksum, installs it under `/opt/maincreate/actions-runner` and starts it under the `maincreate-runner` user.
5. **Remote upgrade:** controller queues a checksum-pinned architecture-specific host upgrade; host stages it, restarts and checks the service with rollback on failure. Keep enrollment and existing runner on upgrade.
6. **Removal:** portal drains and deregisters GitHub Actions, then runs managed cleanup and revokes the host. Local `uninstall-linux.sh` defaults to dry-run and refuses to delete a registered GitHub runner without verified remote deregistration and explicit arguments.
7. **Failure recovery:** retries preserve existing enrollment, don't overwrite registered GitHub runners, and preserve incomplete extraction backups for diagnosis.

> Installed is **not ready**. A usable build machine must complete host pairing, GitHub runner registration, and the Online check. Installing specific SDKs (ESP-IDF, Android, Arduino) and validating real builds are separate steps.

## Manual checks

```bash
sudo systemctl is-active maincreate-host.service
sudo /usr/local/bin/maincreate-host version
sudo journalctl -u maincreate-host -n 40 --no-pager
sudo bash /tmp/maincreate-uninstall.sh --dry-run
```

The uninstaller is available at `https://<your-controller>/uninstall.sh`. Manual cleanup should follow GitHub runner removal in the portal first.

## Tests and release synchronization

```bash
(cd host && go test ./...)
node --test runner/service.test.mjs runner/sdk_install.test.mjs
bash -n scripts/install-linux.sh scripts/uninstall-linux.sh
(cd host && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o /tmp/maincreate-host-linux-amd64 .)
(cd host && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -o /tmp/maincreate-host-linux-arm64 .)
```

`main-platform` pins and vendors the `host/`, `runner/`, and Linux scripts from this repository. Keep the files byte-identical in both repos and update `vendor-lock.json` when promoting changes.
