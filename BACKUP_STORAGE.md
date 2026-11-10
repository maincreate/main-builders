# NFS device backup support (development)

The controller assigns an NFSv4 export to individual managed Linux hosts. A
`storage.nfs.mount` action carries only datastore ID, server and export path.
Mounts use a fixed managed path and fixed `hard,nosuid,nodev,noexec` options.
`findmnt` must confirm the exact export and NFS filesystem before writes. The
installer supplies nfs-common and util-linux on Debian/Raspberry Pi OS.

The backup writer accepts a freshly verified device flash stream, writes it
under `Device Backups/{serial}_{name}_{builder}/{timestamp}-{unique-id}/`,
checks the expected byte count, fsyncs the image, re-reads and verifies SHA-256,
and writes a manifest before committing the directory. The manifest retains
immutable device identity. Failed transfers are removed; incomplete directories
are not completed backups. The manifest explicitly excludes eFuses and external
storage. A flash adapter must hold the exclusive device lock throughout backup
and flashing.

Not released: no device reader invokes the writer yet. There is no flash/restore
adapter, scheduler, retention, reboot mount reconciliation or group inheritance.
NFS permissions/root squash must be configured on the NAS. No live NFS or device
validation has been performed. Storage mounting runs outside the heartbeat loop. Hard NFS I/O can still stall
that storage action during server loss; cancellation/recovery needs live testing.
Mounts are not written to fstab. Do not claim persistent or continuously monitored
mount health from a completed action.
