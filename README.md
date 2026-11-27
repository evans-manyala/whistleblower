# Whistleblower

A local workplace reporting prototype. Employees can report sexual harassment, corruption, discrimination, fraud, safety issues and other misconduct. They can submit without providing contact details or share an email address with the reviewer. A case code lets the reporter see updates and exchange messages without an account.

## Try the demo

Use Node.js 24 or newer. Install the locked dependencies, including Sharp for image previews.

```sh
npm ci
npm run demo
```

Open [the local portal](http://127.0.0.1:4310/). Submit a sample report and save its case code. Use **Reviewer access** with the passphrase printed in the terminal. The demo keeps reports in memory and clears them when it stops.

## Run with persistent storage

`npm start` stores reports in `.data/whistleblower.sqlite`. Set `WHISTLEBLOWER_REVIEWER_PASSWORD` in the process environment before starting to enable reviewer access. Use a unique passphrase of at least 14 characters. Set `WHISTLEBLOWER_DATA_DIR` to use a different directory or `PORT` to select a different local port.

```sh
npm run check
npm test
```

## Supporting evidence in organisation portals

Set `WHISTLEBLOWER_KEYS_DIR` to a private, persistent key directory before starting SaaS mode. In **New report → Details**, reporters can attach up to three JPEG, PNG, WebP or UTF-8 plain-text files. The limits are 4 MiB per file, 8 MiB per report and 32 megapixels per image. Choose single-frame images. The report and all its attachments are saved together.

An authenticated reviewer can open a preview or download the exact original from **Reviewer access → Reported details → Supporting evidence**. Image previews use WebP at quality 88, apply the camera orientation, omit embedded metadata and fit within 1920 × 1920 pixels. Text previews use gzip and retain the first 32,768 UTF-16 code units up to a complete character. The original retains its full contents and metadata, which may identify the reporter.

The service encrypts the original, preview and filename in memory with AES-256-GCM before writing to the organisation’s case database. Each representation is authenticated against its tenant, report, file ID and purpose. The append-only submission entry commits to the encrypted evidence. Report form fields and case messages still use the existing SQLite storage and need a protected volume. At an HTTPS reverse proxy, disable disk buffering and body logging for these routes, allow an encoded request up to 12 MiB, and protect temporary storage.

On the first upload the service creates `<keys>/<organisation-id>.evidence.wbkey` with owner-only permissions. Escrow each evidence key in separately controlled, versioned secret storage when it is created. Include these keys in recovery drills. Restoring attachments requires the organisation’s case archive, its backup key to restore SQLite, and its original evidence key at the same filename to open the files. A missing or mismatched evidence key blocks decryption and further uploads for that organisation.

## Encrypted backups and recovery

The operator CLI uses SQLite's Online Backup API for consistent snapshots of the running database and encrypts each archive with AES-256-GCM. It strips reviewer sessions and verifies case history before publishing a backup. The live SQLite database and temporary working snapshots use plaintext, so keep their directories on protected storage.

Generate a key once. Keep its recovery copy in a secret manager or equivalent separately controlled storage. The key file must be readable only by its owner.

```sh
export WHISTLEBLOWER_BACKUP_KEY_FILE=/secure/keys/whistleblower.wbkey
npm run integrity -- keygen "$WHISTLEBLOWER_BACKUP_KEY_FILE"
npm run integrity -- backup /backup/whistleblower-2026-11-27.wbbackup
npm run integrity -- restore /backup/whistleblower-2026-11-27.wbbackup /recovery/whistleblower.sqlite
npm run integrity -- verify --db /recovery/whistleblower.sqlite
```

Use a new archive name on each run. Copy encrypted backups and retained checkpoint files to independently controlled storage with deletion protection. Keep the key separately, including any old key needed to decrypt an archive. Choose the SaaS backup interval according to how much recent data you can afford to lose. For standalone deployments, schedule the CLI and rehearse recovery. A restore writes a new database and recovers the point in time represented by the snapshot. Inspect the restored database separately before switching the app to its directory with `WHISTLEBLOWER_DATA_DIR`.

## Case history and Bitcoin timestamps

New reports, messages, and status changes add entries to the case history in the same transaction as the underlying data. Each entry includes a random nonce and links to the previous entry's hash. Starting the updated server migrates pre-existing reports and events into the history. Any resulting checkpoint attests to the state observed after migration.

Install the [official OpenTimestamps CLI](https://github.com/opentimestamps/opentimestamps-client) on the operator machine. Set `WHISTLEBLOWER_OTS_BIN` if `ots` is outside `PATH`. The verification command uses the client's Bitcoin Core configuration. Configure a synced mainnet node with RPC access for the operator and keep the RPC credentials outside the app. If a macOS Python installation lacks a default CA bundle, point `SSL_CERT_FILE` at a trusted bundle such as `/etc/ssl/cert.pem`.

```sh
npm run integrity -- verify
npm run integrity -- checkpoint /audit/whistleblower-2026-11-27.json
npm run integrity -- stamp /audit/whistleblower-2026-11-27.json
npm run integrity -- upgrade /audit/whistleblower-2026-11-27.json
npm run integrity -- verify-anchor /audit/whistleblower-2026-11-27.json
```

In standalone mode, run checkpointing on a fixed cadence. OpenTimestamps sends an opaque digest to calendars. The checkpoint contains a log ID, entry count and Merkle root, and stays in your storage alongside its `.ots` proof. `stamp` saves a pending receipt. Run `upgrade` again once a Bitcoin attestation is available, then use `verify-anchor` to verify both the retained checkpoint against the database and the attestation against Bitcoin. An independent custodian should retain the checkpoint and proof. To compare a backup or a recovery with a separately retained checkpoint, pass it with `--checkpoint FILE` to `backup`, `restore`, or `verify`. Pick a checkpoint covered by that snapshot. A checkpoint anchors the history up to its entry count. Later entries get external verification with a later checkpoint.

## Organisation administration

Start SaaS mode with a dedicated data directory. The platform operator creates the first account from a trusted operator shell. Load `WHISTLEBLOWER_PLATFORM_ADMIN_PASSWORD` from a secret manager or a private shell prompt, then clear it from the environment after account creation.

```sh
export WHISTLEBLOWER_DATA_DIR=/var/lib/whistleblower/saas
npm run platform -- create-admin operator@example.org
unset WHISTLEBLOWER_PLATFORM_ADMIN_PASSWORD
npm run saas
```

Open the [Platform Admin portal](http://127.0.0.1:4310/platform/). Create an organisation, then deliver the one-time invitation code and its acceptance page privately to the appointed administrator. Invitation codes expire after 72 hours. The Platform Admin can replace an unused initial invitation or suspend an organisation and end its sessions.

| Access | Entry point | Scope |
| --- | --- | --- |
| Platform Admin | `/platform/` | Provision, suspend, and reactivate organisations |
| Organisation Admin | `/o/<org>/admin/` | Manage the organisation’s name and intake, invite admins and reviewers, and revoke access |
| Reviewer | `/o/<org>/#/reviewer` | Review reports and follow up in their organisation |
| Reporter | `/o/<org>/` | Submit and track reports using the organisation’s case code |

Organisation invitations grant access only to the issuing organisation. Platform and organisation administrators use their own accounts and roles. Reviewers have a separate role. SaaS mode stores the platform registry separately and creates a case database and case history ID for each new organisation. Existing standalone data stays in the standalone deployment. Case codes use the issuing portal address as part of the credential.

For a shared HTTPS installation, set `WHISTLEBLOWER_ORIGIN` to the public HTTPS origin and run behind a trusted TLS reverse proxy. Preserve the public Host on proxied requests and overwrite `X-Real-IP` with the actual client address. Serve the application only through that proxy. Configure scheduled backups of the platform registry on operator-controlled protected storage. It contains the mapping between organisation addresses, accounts, and their storage directories.

### Automatic Bitcoin anchoring

The SaaS server starts a background worker for active organisations, including newly provisioned ones. Keep the service running with persistent storage. Install the official OpenTimestamps client on the service account’s PATH (or set `WHISTLEBLOWER_OTS_BIN` to its absolute executable path) and configure access to a synced Bitcoin Core mainnet node for verification. The first checkpoint is picked up on a minute sweep. After that, the service checks for changed history hourly. It saves a receipt for each new checkpoint and retries pending confirmations and temporary failures every 15 minutes. Older pending receipts can finish while newer history is submitted. Jobs and receipts survive service restarts. Suspended organisations resume on reactivation.

Open **Organisation Admin → Access & settings → Bitcoin anchoring**. The panel refreshes while open and shows the block number only after the receipt and the organisation’s case history verify. If a newer checkpoint is pending, the previous verified block remains available with its covered entry count and verification date. The two download links retrieve the last verified pair for the signed-in organisation. Downloaded filenames include its slug so pairs are easier to identify.

The service saves each pair at `<archive>/<organisation-id>/checkpoints/auto-<entry-count>.json` and the matching `.json.ots`. Set `WHISTLEBLOWER_ARCHIVE_DIR` to a private, persistent filesystem directory. It defaults to `archive/` under the SaaS data directory for checkpoints. Retain a separately administered, versioned or write-protected offsite copy of **both** files after each upgrade. Keep the same base filename and use a different folder for each organisation. The JSON describes the history commitment and the receipt supplies the proof to Bitcoin. For report recovery, also retain the encrypted case backups and store their encryption keys separately. Back up the platform registry to preserve the verified status and organisation-to-storage mapping.

### Scheduled recovery backups

Set both private directories in the SaaS service environment and restart the service. Use persistent storage and give the service account access. The directories must be separate, including after resolving symlinks.

```sh
export WHISTLEBLOWER_ARCHIVE_DIR=/backup/whistleblower-archives
export WHISTLEBLOWER_KEYS_DIR=/secure/whistleblower-keys
export WHISTLEBLOWER_BACKUP_INTERVAL_MINUTES=60
export WHISTLEBLOWER_BACKUP_RETENTION_DAYS=7
npm run saas
```

The worker picks up each workspace and the platform registry on startup or on the next minute sweep, including suspended organisations. With the defaults it takes a snapshot approximately hourly and retains scheduled snapshots for seven days. Each tenant has a distinct AES-256-GCM key and archive directory. The separately encrypted registry contains accounts, organisation mappings and recorded proof status. Snapshots exclude live sessions, and registry snapshots also exclude invitation codes. After restoring the registry, sign in again and reissue outstanding invitations.

Every run authenticates and restores its encrypted output to temporary protected storage, verifies SQLite and, for a case database, its history and any checkpoint selected at the start of the job. Only after this succeeds does it expire older, catalogued scheduled backups for that scope. Manual backups remain in place. Failures retry after five minutes. Open **Platform Admin → Encrypted backups** for the last successful registry backup and scope-specific failures. The worker also emits failures to the service error log for operator alerting.

Archives are named `scheduled-<timestamp-in-milliseconds>.wbbackup`. Organisation files live under `<archive>/<organisation-id>/backups/`. The registry uses `<archive>/platform/backups/` and the separate key `<keys>/platform-registry.wbkey`. Keys are created once and checked against their recorded fingerprint. If a key is unavailable, recover the original key. Keep an independent protected key recovery copy and offsite versioned copies of archives and checkpoint pairs. Offsite transfers require operator configuration. Protect the service’s data volume because SQLite, temporary snapshots and restore checks use plaintext there.

Restore into new files. Select an actual archive name for each scope. The registry restore also works when the original registry is unavailable.

```sh
npm run platform -- restore-registry "$REGISTRY_ARCHIVE_NAME" /recovery/platform.sqlite
npm run integrity -- restore "$ORG_ARCHIVE_NAME" recovery-drill --org example-org
```

On a fresh recovery host, first restore the registry into the recovery data directory. Set `WHISTLEBLOWER_DATA_DIR` to that directory before using the organisation CLI. It recovers the organisation database to `organisations/<id>/recovery/<label>/whistleblower.sqlite`. Verify restored accounts, access and case history before switching traffic to a recovered service.

### Organisation backups and proofs

The operator CLI requires an organisation for SaaS operations. Run `keygen` only for first-time manual setup. When scheduling has already provisioned a key, use the existing key. Resolve keys and archives under separately controlled directories. The CLI chooses each organisation’s database, encryption key, and archive namespace from the registry. The encryption and verification paths also bind to that organisation’s case history ID.

```sh
export WHISTLEBLOWER_KEYS_DIR=/secure/whistleblower-keys
export WHISTLEBLOWER_ARCHIVE_DIR=/backup/whistleblower-archives
npm run integrity -- keygen --org example-org
npm run integrity -- checkpoint monday.json --org example-org
npm run integrity -- backup monday.wbbackup --org example-org --checkpoint monday.json
npm run integrity -- restore monday.wbbackup drill-1 --org example-org --checkpoint monday.json
npm run integrity -- stamp monday.json --org example-org
npm run integrity -- upgrade monday.json --org example-org
npm run integrity -- verify-anchor monday.json --org example-org
```

In SaaS mode, use simple artifact filenames. A restore writes a verified SQLite file in that organisation’s recovery directory. Review it before replacing the live database in a controlled maintenance window. Store independent copies of the encrypted archives and checkpoint pairs. Keep the keys separate.

The tenant and role isolation tests exercise crossed sessions, invitations, case codes, report references, backups, and audit proofs.

## Prototype boundaries

This app is for local evaluation with sample information. It binds to the loopback interface. Standalone mode uses one shared reviewer passphrase. SaaS mode uses individual accounts and per-organisation storage. A case code grants access to the summary, status and follow-up conversation. Details that could identify a reporter may still be present in text they choose to share. Before using it for real reports, establish individual reviewer accounts, HTTPS, protection for the live database, independent review routing, and data retention and access policies.

## Artwork

`public/assets/hero.webp` was made with the built-in ImageGen tool. The prompt requested a landscape editorial studio still life of a frosted sage-glass shield and a sealed off-white envelope on a pale sage backdrop, lit softly from the upper right, without any text or logos.
