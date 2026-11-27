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

## Prototype boundaries

This app is for local evaluation with sample information. It binds to the loopback interface and supports one organisation and one shared reviewer passphrase. SQLite stores report contents in plaintext. A case code grants access to the summary, status and follow-up conversation. Details that could identify a reporter may still be present in text they choose to share. Before using it for real reports, establish individual reviewer accounts, HTTPS, encrypted storage and backups, independent review routing, and data retention and access policies.

## Artwork

`public/assets/hero.webp` was made with the built-in ImageGen tool. The prompt requested a landscape editorial studio still life of a frosted sage-glass shield and a sealed off-white envelope on a pale sage backdrop, lit softly from the upper right, without any text or logos.
