# RooWatch private scraper

This is the private Facebook group collector for RooWatch. It runs on a VPS.
It uses Node.js, Playwright and Chromium. It does not run inside the Cloudflare
Worker.

The service is ready for a controlled test. It has not been proven against a
real private group in this checkout because no Facebook session or residential
proxy was supplied. Do not turn on the customer promise until that live test
passes.

## What it does

- Pulls paid work from the RooWatch Worker over HTTPS.
- Uses one approved Facebook monitoring account per encrypted session.
- Uses a mandatory residential proxy with one stable sticky session per account.
- Reuses the browser and account contexts between checks.
- Checks each unique private source once. RooWatch fans the result out to members.
- Resolves a stable permalink and sends each Facebook post ID at most once in a check.
- Opens `sorting_setting=CHRONOLOGICAL` and requires the real `New posts` control.
- Verifies that normal post times run from newest to oldest.
- Stops the page as soon as the first normal post older than 65 minutes appears.
- Does not read or send that old boundary post.
- Ignores every pinned and featured post. Only normal posts can be sent.
- Blocks images, video, audio, fonts, styles and common ad trackers.
- Blocks streaming sockets and event streams so they cannot escape the byte guard.
- Measures compressed network bytes through Chromium.
- Has a normal bandwidth target of 1 MB per check.
- Stops at a separate hard transfer limit if a page runs away.
- Saves rotated Facebook cookies after every successful authenticated check.
- Runs a separate daily account and proxy validation job.
- Sends results through an encrypted local outbox so an API outage does not
  cause the same group to be scraped again.
- Reports heartbeats, account state, proxy state, bandwidth and measured cost.

It never logs cookies, proxy passwords or private post text. It never takes
screenshots.

## What it will not do

The service does not join groups. It does not answer membership questions. It
does not solve CAPTCHA, 2FA or Facebook checkpoints. It does not try to bypass
an account block. Those steps need a person.

Only use a monitoring account that is allowed to read each group. The proxy
provider must also permit this use. The service is provider neutral. It does
not recommend Bright Data residential proxies for Facebook account use.

Keep each monitoring account's Facebook language set to English. The strict
`New posts` proof and Facebook failure messages in this first version are for
the English interface.

## The strict 65-minute rule

The page is closed at the first normal post older than 65 minutes. Closing the
page stops feed requests at that boundary. The old post is used only for its
time. Its text, author and link are not extracted.

An old pinned or featured post does not stop the check. It is skipped. The
normal feed below it is still checked.

A check fails if any normal post has no exact enough time, if post times move
newer while reading down the feed, if the `New posts` control is missing, or if
the old-post boundary cannot be reached safely. A failure never looks like a
quiet group.

`Newest activity` is not accepted. It can move an old post to the top when a
new comment arrives. That is not creation-time order.

## Cost guard

The Worker reserves money before it creates a job. The job contains its maximum
allowed cost in integer AUD micros. The scraper also calculates its own maximum
from these operator supplied values:

- The real proxy price per GB, or zero only for a real flat proxy plan.
- Any real fixed proxy-plan or sticky-IP amount allocated to one check.
- The current USD to AUD rate when the proxy is billed in USD.
- The real VPS amount allocated to one attempted check.
- The reserved transfer byte ceiling.

The scraper refuses a job when the Worker reservation is lower than its own
guard. It reports real measured bytes after each attempt. It never fills in a
made-up supplier price.

Every result says if paid work was attempted. Untouched jobs report zero proxy
cost, zero VPS cost and zero bytes. Attempted jobs report the configured VPS
allocation. A proxy fixed amount is applied only when the proxy path was used.

`PROXY_FIXED_MICROS_PER_CHECK` keeps a fixed residential or ISP proxy plan in
the proxy ledger. Do not hide it inside the VPS amount. Use zero when the proxy
has no fixed per-check allocation and the per-GB amount is positive. At least
one proxy cost component must be positive. The VPS allocation must also be
positive because this MVP has no second VPS ledger.

The 1 MB value is a target for a normal group. The default 2 MB value is an
emergency stop, not the target. The larger reservation byte value allows for
responses that were already in flight when Chromium crossed the stop point.
Tune these values only after reading real traffic and supplier bills.

## API contract

All routes use this header:

```text
Authorization: Bearer PRIVATE_SCRAPER_SECRET
```

The service uses:

```text
GET  /api/internal/private-scraper/jobs?workerId=...
POST /api/internal/private-scraper/results
POST /api/internal/private-scraper/heartbeat
```

The jobs endpoint returns a 65-minute lookback and two job kinds:

- `scan_group` has `runId`, numeric `sourceId`, URL, account ID, deadline and
  maximum reserved AUD micros.
- `validate_session` has `runId`, account ID, deadline and maximum reserved AUD
  micros.

`storageKey` is local to the VPS. The Worker does not send it in a job. The
scraper maps the job's account ID to the encrypted local session itself.

`runId` is the result idempotency key. Results contain exact byte counts, proxy
cost in its supplier currency, the configured AUD rate when needed, allocated
VPS cost, session save time, account state, group state and a safe error code.
Private text is present only inside successful post rows sent to the ingestion
endpoint. It is encrypted if it must wait in the local outbox.

The Worker endpoint accepts 512,000 bytes. This service stops result payloads at
500,000 UTF-8 bytes. An oversized collection becomes an explicit failed check
with no post text in its outbox entry. It cannot get stuck retrying a permanent
HTTP 413 response.

The backend owns the hourly schedule and daily validation queue. This process
polls every minute so it can pick up due work and admin retries. A persistent
process is used instead of an hourly systemd timer because that keeps browser
contexts and cache warm. The file lock rejects a second worker process.

## Account and failure states

Canonical states sent to the admin dashboard are:

- Worker: `healthy`, `degraded`, `offline`.
- Account: `healthy`, `login_required`, `blocked`, `disabled`, `error`.
- Session: `healthy`, `stale`, `login_required`, `challenge`.
- Account proxy: `healthy`, `failed`, `unknown`.
- Worker proxy summary: `healthy`, `degraded`, `failed`, `unknown`.
- Group: `healthy`, `waiting_for_access`, `access_lost`, `unavailable`,
  `deleted`, `error`.

Important error codes include `LOGIN_REQUIRED`, `CHALLENGE_REQUIRED`,
`ACCOUNT_BLOCKED`, `ACCOUNT_DISABLED`, `GROUP_ACCESS_LOST`, `GROUP_DELETED`,
`PROXY_FAILED`, `PROXY_AUTH_FAILED`, `PROXY_ROTATED`, `CHRONOLOGY_UNVERIFIED`,
`PROXY_IDENTITY_SAVE_FAILED`, `TIMESTAMP_UNVERIFIED`, `BOUNDARY_NOT_REACHED`,
`TRANSFER_LIMIT_EXCEEDED` and `RESERVATION_TOO_LOW`.

The Worker detects a missing heartbeat. That is how Ross can be warned when the
VPS itself cannot send an error.

## Local install

Node 22.13 or newer is required.

```bash
cd services/private-scraper
npm ci
npx playwright install chromium
cp .env.example .env
cp accounts.example.json accounts.json
```

Create the encryption key with a secure random generator. For example:

```bash
openssl rand -base64 32
```

Put the result in `SESSION_ENCRYPTION_KEY`. Keep a secure backup. Losing the key
means every stored Facebook session and queued result becomes unreadable.

Set a separate random `PRIVATE_SCRAPER_SECRET` in the Worker and on the VPS.
Never commit `.env`, `accounts.json`, a Facebook storage state, or proxy details.

### Residential proxy setup

The service will not start without a residential proxy. At least one of the
server, username or password templates must contain `{sessionId}`. This makes
the provider keep a stable session for that Facebook account. `{accountId}` is
also available.

Each account in `accounts.json` needs a unique stable `proxySessionId`:

```json
[
  {
    "id": "fb-monitor-01",
    "label": "Facebook monitor 1",
    "storageKey": "fb-monitor-01",
    "proxySessionId": "fb-monitor-01"
  }
]
```

The proxy is checked before the first account request and again during the
daily health job. A proxy failure closes the path. The service never falls back
to the VPS IP.

The service hashes the proxy health response and stores only that short hash in
`account-state.json`. It checks the hash after a process restart too. A changed
hash fails with `PROXY_ROTATED`. The raw IP and health response are not stored or
logged.

If an operator approves a real proxy change, stop the service first. Confirm the
new proxy is the intended account-sticky residential session. Then remove only
that account's `proxyFingerprint` field from `account-state.json` and start the
service. The next health check records the new hash. Do not put the raw IP in
the state file.

### Import or replace a Facebook session

Export a Playwright storage state from an approved, logged-in account. Then run:

```bash
npm run cookies:import -- --account fb-monitor-01 --file /secure/path/session.json
```

Stop the scraper service before this command. The shared process lock refuses a
session replacement while the daemon is using that account. Start the service
again after the import passes.

The command checks the proxy and opens Facebook. It replaces the encrypted live
session only after Facebook proves that the account is still logged in. The old
encrypted session stays intact when validation fails. Cookie values are never
printed.

The source JSON is still plain text after the command. Move it to approved
secure storage or delete it safely. Restart the service after replacement so a
running browser cannot keep the old session in memory.

On the VPS, stop the daemon and load the protected environment file directly:

```bash
sudo systemctl stop roowatch-private-scraper
cd /opt/roowatch/private-scraper
sudo -u roowatch-scraper /usr/bin/node --env-file=/etc/roowatch/private-scraper.env src/cli/import-session.js --account fb-monitor-01 --file /secure/path/session.json
sudo systemctl start roowatch-private-scraper
```

The service does not log out and back in every day. Successful Facebook visits
rotate cookies naturally. The latest state is encrypted and saved atomically.
The daily job checks that this still works.

## Run and test

```bash
npm test
npm run scan:once
npm start
```

`scan:once` is useful for deployment checks. Production should use the
long-running systemd service.

## VPS systemd setup

Install Node and Playwright Chromium with its Linux packages. Put the browser
in the fixed path used by the hardened systemd unit:

```bash
sudo env PLAYWRIGHT_BROWSERS_PATH=/opt/roowatch/pw-browsers npx playwright install --with-deps chromium
```

Do not rely on Playwright's default home-folder cache. The service unit hides
home folders. It will not see a browser installed there.

Create the unprivileged `roowatch-scraper` user. Put this service in
`/opt/roowatch/private-scraper`. Put the environment file at
`/etc/roowatch/private-scraper.env` and the account list at
`/etc/roowatch/private-scraper-accounts.json`. Both files should be readable
only by root and the service group.

Copy the unit and start it:

```bash
sudo cp deploy/roowatch-private-scraper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now roowatch-private-scraper
sudo systemctl status roowatch-private-scraper
```

Logs go to the system journal. The logger writes one JSON event per line. Use:

```bash
sudo journalctl -u roowatch-private-scraper -f
```

The unit restarts after a crash. The Worker heartbeat monitor handles a dead
VPS, missed hourly checks and emergency alerts.

The unit does not set `HOME`. It can write only to its systemd state directory.
Chromium uses the explicit read-only browser path and the explicit cache path
in the unit.

## Before enabling customers

Use one approved account and one approved private group. Prove all of these with
real data:

1. `New posts` really means creation-time order for that account.
2. A controlled new text post is collected once.
3. The first normal post older than 65 minutes closes the page.
4. An old pinned post does not hide newer normal posts.
5. The measured normal check is near or below 1 MB.
6. Lost group access, expired cookies, a proxy failure and a stopped VPS create
   the right incident and emergency message.
7. Recovery creates one recovery message.
8. The real proxy bill reconciles with the byte ledger and configured rate.

Until that list passes, the code is tested but the Facebook behaviour is not
verified live.
