# RooWatch

RooWatch watches public Facebook groups for Australian tradies and emails them
the moment somebody asks for their service.

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
  cron every 5 minutes  ......  app/api/cron/scan/route.ts
      |
      v
  scraper  ..................  db/pipeline.ts (Apify today, Bright Data next)
      |
      v
  dedup against seen_posts  ..  db/pipeline.ts
      |
      v
  does this match the member?   Claude Haiku reads the member's own brief
      |
      v
  email the lead  ............  Resend
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
| Matching | Claude Haiku 4.5 | `claude-haiku-4-5-20251001` |
| Email | Resend | sends from `notify@roowatch.com.au` |
| Payments | Stripe | three live plans, see below |
| Analytics | Meta Pixel `4105570149577363` | plus our own `events` table |

## Plans

Defined once in [db/plans.ts](db/plans.ts). Every group limit in the app reads
from there.

| Plan | Groups | Alert speed | Price AUD | Stripe price id |
|---|---|---|---|---|
| Local | 10 | 5 min | $297 | `price_1U4sCe9HOJbWqVToqrNBDaIp` |
| Growth | 25 | 5 min | $597 | `price_1U4sCg9HOJbWqVToRKrBxw6W` |
| Scale | 100 | 3 min | $1,997 | `price_1U4sCh9HOJbWqVToU4GpQFTO` |

A member's plan lives in `profiles.plan` and defaults to `local`. Ross changes
it from the Marketing tab of the dashboard.

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

- The site, signup, dashboard and setup wizard are live and working.
- **The scanner is paused.** All rows in `sources` have `active = 0`. This was
  deliberate. See [docs/scraper-decision.md](docs/scraper-decision.md).
- One paying customer: none yet. Ross runs his own business (Perth Solar Panel
  Cleaners) as customer zero.
- 21 people on the waitlist from Facebook ads.
