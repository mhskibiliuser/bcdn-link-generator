# bcdn-linkgen

Automated **Bunny CDN pull-zone generator**. It registers a fresh bunny.net
account (temp email + captcha solving + any verification), creates one or more
pull zones pointing at an origin you choose, and hands you the resulting
`*.b-cdn.net` links — which act as CDN-fronted mirrors of that origin.

Originally the front end for this was a Discord bot. This repo is the same core
with a plain command-line front end instead — no Discord, no database.

Released into the public domain under **The Unlicense** — use it for anything,
no credit required. See `LICENSE`.

> ⚠️ **Heads up.** Automating free bunny.net signups is against Bunny's Terms of
> Service. This is published as-is for educational/archival purposes. You are
> responsible for how you use it. Accounts made this way can and do get banned.

---

## What you need

This drives a real browser and real third-party services, so you need accounts
with a few providers (all set via `.env` — see `.env.example`):

- **Proxies** (`PROXIES`) — residential/mobile proxies. Signups from datacenter
  IPs get flagged fast. We used [iProyal](https://iproyal.com) and recommend it.
- **A captcha solver** — [CapSolver](https://capsolver.com), CapMonster, or
  [2Captcha](https://2captcha.com). CapSolver is tried first.
- **Gmail addresses** — a [SMailPro](https://smailpro.com) key. SMailPro hands
  out real temporary **Gmail** (and Outlook) inboxes, which is what accounts are
  registered with and where the bunny.net verification email lands. Using real
  Gmail addresses is what dodges the "disposable email" blocks a plain temp-mail
  domain would trip.
- **SMS verification** (optional) — an SMSBower key, only if a phone check fires.

You also need Node.js 18+ and Playwright's browser binaries.

---

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env    # then fill in your keys
```

## Usage

```bash
# one link pointing at the default origin from .env
node cli.js

# 20 links, custom origin
node cli.js --amount 20 --origin https://example.com

# 20 links packed 5-per-account (fewer signups)
node cli.js --amount 20 --links-per-account 5 --origin https://example.com
```

**Flags**

| flag | default | meaning |
|------|---------|---------|
| `--amount` | `1` | total number of links to create |
| `--origin` | `BCDN_ORIGIN` from `.env` | the URL the pull zones mirror |
| `--links-per-account` | `1` | pull zones per bunny account (packs more links into fewer signups) |

**Output**
- `bcdn_links.txt` — just the links, one per line
- `result.json` — full detail (emails, passwords, API keys, zone IDs)

---

## Files

| file | what it does |
|------|--------------|
| `cli.js` | the command-line entry point. parses flags, calls the core, writes the output files. |
| `sniper.js` | the core. drives a browser to register a bunny account, solves captchas, confirms the email, and creates pull zones via the bunny API. exposes `initHarvester`, `snipe`, `snipeBatch`. |
| `harvester.js` | temp-email helper — requests an inbox and polls it for the bunny verification link. |

---

## How it works

1. `initHarvester()` warms a browser.
2. For each account: grab a temp inbox, fill out the bunny.net signup behind a
   proxy, solve the reCAPTCHA, and confirm via the emailed link.
3. Pull the account's API key, then create `--links-per-account` pull zones
   pointing at your origin.
4. Return the `*.b-cdn.net` URLs. Repeat for `--amount`.

Everything is configured through environment variables — see `.env.example`.
