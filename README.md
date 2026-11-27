# Whistleblower

A local workplace reporting prototype. Employees can report sexual harassment, corruption, discrimination, fraud, safety issues and other misconduct. They can submit without providing contact details or share an email address with the reviewer. A case code lets the reporter see updates and exchange messages without an account.

## Try the demo

Use Node.js 24 or newer. The app has no npm dependencies.

```sh
npm run demo
```

Open [the local portal](http://127.0.0.1:4310/). Submit a sample report and save its case code. Use **Reviewer access** with the passphrase printed in the terminal. The demo keeps reports in memory and clears them when it stops.

## Run with persistent storage

`npm start` stores reports in `.data/whistleblower.sqlite`. Set `WHISTLEBLOWER_REVIEWER_PASSWORD` in the process environment before starting to enable reviewer access. Use a unique passphrase of at least 14 characters. Set `WHISTLEBLOWER_DATA_DIR` to use a different directory or `PORT` to select a different local port.

```sh
npm run check
npm test
```

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

Use a new archive name on each run. Copy encrypted backups and retained checkpoint files to independently controlled storage with deletion protection. Keep the key separately, including any old key needed to decrypt an archive. Schedule backups according to how much recent data you can afford to lose and rehearse recovery. A restore writes a new database and recovers the point in time represented by the snapshot. Inspect the restored database separately before switching the app to its directory with `WHISTLEBLOWER_DATA_DIR`.

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

Run checkpointing on a fixed cadence. OpenTimestamps sends an opaque digest to calendars. The checkpoint contains a log ID, entry count and Merkle root, and stays in your storage alongside its `.ots` proof. `stamp` saves a pending receipt. Run `upgrade` again once a Bitcoin attestation is available, then use `verify-anchor` to verify both the retained checkpoint against the database and the attestation against Bitcoin. An independent custodian should retain the checkpoint and proof. To compare a backup or a recovery with a separately retained checkpoint, pass it with `--checkpoint FILE` to `backup`, `restore`, or `verify`. Pick a checkpoint covered by that snapshot. A checkpoint anchors the history up to its entry count. Later entries get external verification with a later checkpoint.

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

For a shared HTTPS installation, set `WHISTLEBLOWER_ORIGIN` to the public HTTPS origin and run behind a trusted TLS reverse proxy. Preserve the public Host on proxied requests and overwrite `X-Real-IP` with the actual client address. Serve the application only through that proxy. Back up the platform registry separately using operator-controlled protected storage. It contains the mapping between organisation addresses, accounts, and their storage directories.

### Organisation backups and proofs

The operator CLI requires an organisation for SaaS operations. Resolve keys and archives under separately controlled directories. The CLI chooses each organisation’s database, encryption key, and archive namespace from the registry. The encryption and verification paths also bind to that organisation’s case history ID.

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
