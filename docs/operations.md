# Operations runbook

Everything you need to run RooWatch day to day. Commands are copy-paste ready.

Worker name: `roowatch`. Database: `roowatch-db`
(`de017f20-c9f8-4cc2-94e1-cd419049aecc`). Domain: `roowatch.com.au`.

---

## The scanner

**Stopped since September 2026.** RooWatch is closed: `ROOWATCH_CLOSED` in
[db/closed.ts](../db/closed.ts) is `true` and the cron triggers in
[vite.config.ts](../vite.config.ts) are empty. Before that it ran on Bright
Data from 16 August 2026. By the end it scanned once every five minutes. See
[scraper-decision.md](scraper-decision.md) for why we moved off Apify.

It runs in two phases across cron ticks. To see what phase it is in:

```bash
npx wrangler d1 execute roowatch-db --remote --command="SELECT * FROM scan_jobs;"
```

A row means a collection is in flight. `running` is waiting for Bright Data.
`collecting` is owned by one Worker. `retry` gets one more collection attempt.
No row means the next tick can trigger one. A row or collection claim older
than 20 minutes gets dropped automatically.

The scanner starts live work before it handles group-finder jobs. Each snapshot
contains one group and each tick claims no more than one finished snapshot. A
separate hourly cron checks both recent progress and one-hour coverage. If the
scanner is stalled, it removes only queue jobs that are already stale. The next
five minute tick then starts fresh work automatically. Recovery has its own hourly
cooldown and email has a separate four-hour cooldown.

### Pausing it

Setting sources inactive stops all spend. The cron still wakes, finds nothing
due, and returns before calling anything.

### Turn it back on

```bash
npx wrangler d1 execute roowatch-db --remote \
  --command="UPDATE sources SET active=1, last_error='' WHERE id IN (2,3,4,5);"
```

### Turn it off again

```bash
npx wrangler d1 execute roowatch-db --remote \
  --command="UPDATE sources SET active=0, last_error='paused' WHERE active=1;"
```

**Gotcha:** a new member finishing the setup wizard will reactivate any source
they ask for, because a paying customer must be watched. Pausing is not a hard
lock. If you need a hard lock, remove the `triggers.crons` line from
[vite.config.ts](../vite.config.ts) and deploy.

---

## Deploying

Push to `main`. Cloudflare Workers Builds picks it up automatically. Takes about
6 minutes. There is no GitHub Action.

Confirm it landed:

```bash
npx wrangler deployments list --name roowatch | grep '^Created:' | tail -1
```

Or poll the live site for a marker you just added:

```bash
until curl -s https://roowatch.com.au/ | grep -q 'your-new-string'; do sleep 20; done
```

---

## Migrations

**These are not automatic. Deploying does not run them.**

```bash
npm run db:generate                                    # writes drizzle/00XX_name.sql
npx wrangler d1 execute roowatch-db --remote --file=drizzle/00XX_name.sql
```

Apply the migration **before** deploying code that reads the new column.

Check what columns actually exist in production:

```bash
npx wrangler d1 execute roowatch-db --remote \
  --command="SELECT name FROM pragma_table_info('profiles');"
```

---

## Checking the scanner is alive

```bash
npx wrangler d1 execute roowatch-db --remote --command="
  SELECT group_name, datetime(last_checked/1000,'unixepoch') AS checked,
         last_count, last_matches, last_error
  FROM sources ORDER BY last_checked DESC;"
```

- `checked` should move every 5 to 10 minutes when active
- `last_count` is how many posts the scraper returned
- `last_matches` is how many became leads
- `last_error` should be empty

---

## Checking what it costs

### Bright Data

```bash
curl -s -H "Authorization: Bearer $BRIGHTDATA_API_KEY" \
  "https://api.brightdata.com/datasets/v3/snapshots?dataset_id=gd_lz11l67o2cb3r0lkj3"
```

`dataset_size` is the billable record count per snapshot. `errors` are free.

Account health:

```bash
curl -s -H "Authorization: Bearer $BRIGHTDATA_API_KEY" https://api.brightdata.com/status
```

`can_make_requests: false` with `zone_not_found` means no zone exists on the
account. Create one in the Bright Data control panel.

---

## Secrets

```bash
npx wrangler secret list --name roowatch
npx wrangler secret put NEW_SECRET_NAME --name roowatch
```

Values cannot be read back this way, it only lists names. Current secrets:
`ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`, `APIFY_TOKEN`, `BRIGHTDATA_API_KEY`,
`CRON_SECRET`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, and once the webhook is
registered, `STRIPE_WEBHOOK_SECRET`.

`APIFY_TOKEN` is dead weight now. Remove it when the Apify code goes.

### Registering the Stripe webhook

One time setup, after the webhook route is deployed and live at
`roowatch.com.au/api/webhooks/stripe`, not before, Stripe validates the URL
when the webhook is created:

```bash
export $(grep -v '^#' .dev.vars | xargs)
curl "https://api.stripe.com/v1/webhook_endpoints" -u "$STRIPE_SECRET_KEY:" \
  -d "url=https://roowatch.com.au/api/webhooks/stripe" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=customer.subscription.deleted"
```

The response includes a `secret` field, starting `whsec_`. That is
`STRIPE_WEBHOOK_SECRET`:

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET --name roowatch
```

The secret is only shown once, at creation. If it is lost, delete the
endpoint (`DELETE /v1/webhook_endpoints/{id}`) and create it again rather
than guessing.

---

## Members and plans

List everyone:

```bash
npx wrangler d1 execute roowatch-db --remote --command="
  SELECT u.email, u.name, p.business_name, p.trade, p.plan, p.state,
         p.onboarded_at
  FROM users u LEFT JOIN profiles p ON p.user_id = u.id
  ORDER BY u.created_at DESC;"
```

Change a plan (or use the Marketing tab in the dashboard, which is easier):

```bash
npx wrangler d1 execute roowatch-db --remote \
  --command="UPDATE profiles SET plan='growth' WHERE user_id='...';"
```

Valid values: `local`, `growth`, `scale`. Anything else falls back to `local`
via `planFor()` in [db/plans.ts](../db/plans.ts).

Each plan carries a monthly post allowance, which is also the most that member
can ever cost us:

| Plan | Groups | Posts a month | Price AUD a month |
|---|---|---|---|
| Local | 20 | 5,000 | $97 |
| Growth | 50 | 12,500 | $197 |
| Scale | 200 | 58,500 | $897 |

The old worst case cost column is gone. It was worked out for the old
allowances and has not been measured against the real bill for these ones. The
cost per post is in the comments in [db/plans.ts](../db/plans.ts).

### Who gets scanned

Only members who are paying. The scanner and the lead emails both ask
`isEntitled()` in [db/plans.ts](../db/plans.ts), which is true for a
subscription status of `trialing`, `active` or `past_due`. An account that
finished setup and never added a card is not scanned and is sent nothing.

To look after somebody for free, give them the status `comp`. Without it they
get no leads, because they have no Stripe subscription:

```bash
npx wrangler d1 execute roowatch-db --remote \
  --command="UPDATE profiles SET subscription_status='comp' WHERE user_id='...';"
```

### Groups found before November 2026

A found group is now only offered once it has handed over a real post. Rows
marked checked before that rule may be private or dead. This sends the ones
that never showed a member count back to be checked again:

```bash
npx wrangler d1 execute roowatch-db --remote \
  --command="UPDATE found_groups SET checked=0 WHERE checked=1 AND members=0;"
```

`checked` values: 0 not checked, 1 proven and offered, 2 read but the wrong
kind of group, 4 showed no post once and gets one more look, 3 showed no post
twice and is written off.

---

## Cleaning up after a test

Always do this. A leftover `sources` row means the scanner pays to scrape a
group nobody wants.

```bash
EMAIL='test@example.com'
npx wrangler d1 execute roowatch-db --remote --command="
  DELETE FROM groups   WHERE user_id IN (SELECT id FROM users WHERE email='$EMAIL');
  DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email='$EMAIL');
  DELETE FROM profiles WHERE user_id IN (SELECT id FROM users WHERE email='$EMAIL');
  DELETE FROM alerts   WHERE user_id IN (SELECT id FROM users WHERE email='$EMAIL');
  DELETE FROM users    WHERE email='$EMAIL';"
```

Then check no orphan sources were created:

```bash
npx wrangler d1 execute roowatch-db --remote --command="SELECT id, group_name, url FROM sources;"
```

---

## Stripe

Three products with monthly AUD prices. Every plan carries a **14 day free
trial** (`TRIAL_DAYS`). The trial is set by the checkout route,
[app/api/checkout/route.ts](../app/api/checkout/route.ts), not by a payment
link. That route has returned 410 since September 2026, because RooWatch is
closed. Prices and the trial length live in [db/plans.ts](../db/plans.ts).

| Plan | Price id |
|---|---|
| Local $97 | `price_1U9J1r9HOJbWqVTomTe8d2Vp` |
| Growth $197 | `price_1U9JSx9HOJbWqVToJKSr9IbN` |
| Scale $897 | `price_1U9JSx9HOJbWqVTooh1nDP4d` |

The retired $297, $597 and $1,997 price ids are kept in `legacyPriceIds` so
members on an old price still resolve to the right plan.

The plan picked on the marketing site rides through signup as `?plan=`, and
the checkout at the end of setup bills it. The account itself is created and fully
active before the trial or the card ever comes into it, since signup has never
been payment-gated. See [pipeline.ts](../db/pipeline.ts) and
[SignupApp.tsx](../app/signup/SignupApp.tsx).

**There is now a webhook.** [app/api/webhooks/stripe/route.ts](../app/api/webhooks/stripe/route.ts),
live since 16 August 2026. On `checkout.session.completed` it sets
`profiles.plan` and `profiles.stripeCustomerId` from the checkout, no more
setting a plan by hand. On `customer.subscription.updated` or `.deleted`, a
lapsed payment (`canceled`, `unpaid`, `incomplete_expired`) pauses that
member's groups and emails them a Stripe Billing Portal link to fix it, plus
a heads up to Ross. Recovering pays reactivates them automatically. See the
"Stripe webhook" section of [AGENTS.md](../AGENTS.md) before changing it, the
ordering of the DB write matters for safe retries.

The Billing Portal configuration that link depends on
(`billing_portal/configurations`) only allows updating the payment method and
viewing invoices. Self serve cancel and plan switching are off on purpose.

To change the trial length, change `TRIAL_DAYS` in
[db/plans.ts](../db/plans.ts) and deploy. It only affects checkouts created
after the change. It does not touch anyone already mid-trial.

---

## Admin dashboard

Sign in to `https://roowatch.com.au/dashboard` with a Ross admin email. The
admin command centre opens on its own. It has customers, support, usage,
payments, the pipeline, and marketing. Normal member accounts cannot open it.

---

## Emails

Sent through Resend from `notify@roowatch.com.au`, with replies going to
`ross@roowatch.com.au`. The domain is verified on the RooWatch Resend account,
so any address on it can send.
Signup and onboarding notifications go to both `ross@roowatch.com.au` and
`rossdelport1998@gmail.com`.

---

## Known open items

- `trustedtradiesperth` has never returned a post on either provider. Probably
  private or dead. Check it on Facebook and remove it if so.
- Measure Bright Data collection time at 10 and 25 groups before selling Growth
  or Scale.
- No rate limit on `/api/auth/login`.
- The `$49` intro offer was removed with the price change and never replaced.
- 21 waitlist leads have never been called.
