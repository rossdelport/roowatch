# RooWatch

RooWatch watches public Facebook groups for Australian tradies and emails and
texts them within minutes of somebody asking for their service.

A plumber posts nothing. A homeowner posts *"our hot water died, who is a good
plumber near Dee Why?"*. RooWatch sees it within minutes and emails the plumber
so they can reply first.

- Live site: <https://roowatch.com.au>
- Owner: Ross Delport (ross@roowatch.com.au)
- Runs on: Cloudflare Workers, Cloudflare D1, vinext

## Read this first

If you are an AI agent or a new developer picking this repo up, read these in
order:

1. **[AGENTS.md](AGENTS.md)**. The rules, conventions and traps. Not optional.
2. **[docs/scraper-decision.md](docs/scraper-decision.md)**. Where the product
   is heading. We are moving off Apify onto Bright Data. This is the single most
   important open piece of work.
3. **[docs/operations.md](docs/operations.md)**. How to deploy, migrate, pause
   the scanner and check what things cost.
4. **[docs/market-context.md](docs/market-context.md)**. The competitor the
   product was modelled on.

## How it works

```
Facebook groups
      |
      v
  cron every 5 minutes  .......  app/api/cron/scan/route.ts
      |
      v
  Bright Data scraper  ........  db/pipeline.ts
      |
      v
  dedup against seen_posts  ..  db/pipeline.ts
      |
      v
  does this match the member?   Claude Haiku reads the member's own brief
      |
      v
  email and text the lead  ...  Resend, db/sms.ts
      |
      v
  member dashboard  ..........  app/dashboard/
```

The member writes a brief in plain English, for example *"someone in Perth
asking who cleans solar panels"*. Claude compares every new post against that
brief. Matches become alerts.

## Stack

| Piece | Choice | Notes |
|---|---|---|
| Runtime | Cloudflare Workers via [vinext](https://github.com/cloudflare/vinext) | Next.js App Router in a Worker sandbox |
| Database | Cloudflare D1 (`roowatch-db`) | SQLite at the edge, accessed with Drizzle |
| Scraper | Apify (paused) → Bright Data | see [docs/scraper-decision.md](docs/scraper-decision.md) |
| Matching | Claude Haiku 4.5 | `claude-haiku-4-5` |
| Email | Resend | sends from `notify@roowatch.com.au` |
| Payments | Stripe | three live plans, see below |
| Analytics | Meta Pixel `4105570149577363` | plus our own `events` table |

## Plans

Defined once in [db/plans.ts](db/plans.ts). Every group limit in the app reads
from there.

| Plan | Groups | Price AUD a month | Stripe price id |
|---|---|---|---|
| Local | 20 | $97 | `price_1U9J1r9HOJbWqVTomTe8d2Vp` |
| Growth | 50 | $197 | `price_1U9JSx9HOJbWqVToJKSr9IbN` |
| Scale | 200 | $897 | `price_1U9JSx9HOJbWqVTooh1nDP4d` |

Every plan starts with a 14 day free trial (`TRIAL_DAYS`), set by the checkout
route, [app/api/checkout/route.ts](app/api/checkout/route.ts). All plans share
one scanner. It scans every five minutes, so no plan gets alerts faster than
another.

A member's plan lives in `profiles.plan` and defaults to `local`. Ross changes
it from the Customers area of the admin command centre.

## Layout

```
app/
  landing.html            the whole marketing site, one raw-imported HTML string
  page.tsx                serves landing.html
  signup/                 signup and login on one page
  dashboard/
    DashboardApp.tsx      member dashboard + admin dashboard, one SPA
  reserve/                ad landing pages, one per trade
  api/
    auth/                 signup, login, magic link, logout
    cron/scan/            the scanner, fired by the cron trigger
    onboarding/           setup wizard save + website scan
    member/               member self-service
    admin/                password-gated admin endpoints
db/
  schema.ts               every table
  pipeline.ts             scrape, dedup, classify, alert
  plans.ts                the three plans and their limits
  password.ts             PBKDF2 hashing (no bcrypt in a Worker)
  trades.ts               trade and state lists
  suburbs.ts              Australian suburbs by state
  fbgroups.ts             Facebook URL parsing
  website.ts              reads a member's website from the Worker
drizzle/                  migrations, applied by hand (see operations.md)
docs/                     the documents listed at the top
```

## Running it

```bash
npm install
npm run dev      # local dev server
npm run build    # verify the build
npm run lint
npm test
```

Node `>=22.13.0`.

## Deploying

Push to `main`. Cloudflare Workers Builds deploys automatically, usually within
about 6 minutes. There is no GitHub Action in this repo.

**Migrations are not automatic.** See [docs/operations.md](docs/operations.md).

## Current state, 16 August 2026

- **RooWatch has been closed since September 2026.** `ROOWATCH_CLOSED` in
  [db/closed.ts](db/closed.ts) is `true`: no new signups or subscriptions, no
  scans, no emails, no texts. The notes below are from 16 August 2026.
- The site, signup, dashboard and setup wizard are live and working.
- **The scanner is stopped.** It ran on Bright Data from 16 August 2026. By the
  end it scanned once every five minutes. The cron triggers in `vite.config.ts`
  are now empty. See
  [docs/scraper-decision.md](docs/scraper-decision.md).
- One paying customer: none yet. Ross runs his own business (Perth Solar Panel
  Cleaners) as customer zero.
- 21 people on the waitlist from Facebook ads.
