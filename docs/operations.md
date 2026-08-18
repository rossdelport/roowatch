# Operations runbook

Everything you need to run RooWatch day to day. Commands are copy-paste ready.

Worker name: `roowatch`. Database: `roowatch-db`
(`de017f20-c9f8-4cc2-94e1-cd419049aecc`). Domain: `roowatch.com.au`.

---

## The scanner

**Live, running on Bright Data since 16 August 2026.** See
[scraper-decision.md](scraper-decision.md) for why we moved off Apify.

It runs in two phases across cron ticks. To see what phase it is in:

```bash
npx wrangler d1 execute roowatch-db --remote --command="SELECT * FROM scan_jobs;"
```

A row means a collection is in flight. No row means the next tick will trigger
one. A row older than 20 minutes gets dropped automatically.

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
`CLICKSEND_API_KEY`, `CLICKSEND_FROM`, `CLICKSEND_USERNAME`, `CRON_SECRET`,
`RESEND_API_KEY`, `STRIPE_SECRET_KEY`, and once the webhook is registered,
`STRIPE_WEBHOOK_SECRET`.

Private monitoring also needs `PRIVATE_SCRAPER_SECRET`. Set the same random
value on the Worker and VPS only after the VPS, account and proxy are ready.
Follow [the private scraper runbook](../services/private-scraper/README.md).

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

| Plan | Groups | Posts a month | Worst case cost AUD | Price AUD |
|---|---|---|---|---|
| Local | 10 | 10,000 | about $31 | $297 |
| Growth | 25 | 25,000 | about $78 | $597 |
| Scale | 100 | 100,000 | about $311 | $1,997 |

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

Three live products with monthly AUD prices and payment links. Since 16 August
2026 every link carries a **7 day free trial**, card required upfront
(`payment_method_collection: always`), and redirects to `/dashboard` after
checkout. Links and trial settings live in [db/plans.ts](../db/plans.ts).

| Plan | Price id | Payment link |
|---|---|---|
| Local $297 | `price_1U4sCe9HOJbWqVToqrNBDaIp` | `buy.stripe.com/3cI9AN2Df9vYgVyg6bgUM01` |
| Growth $597 | `price_1U4sCg9HOJbWqVToRKrBxw6W` | `buy.stripe.com/00w5kx4LnbE6dJm6vBgUM02` |
| Scale $1,997 | `price_1U4sCh9HOJbWqVToU4GpQFTO` | `buy.stripe.com/6oUfZb5PreQifRu4ntgUM03` |

Signup already redirects a new member straight to the right link, tagged with
`?plan=` from the marketing site. The account itself is created and fully
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

To change the trial length or any Payment Link setting from the CLI, put a
live secret key in `.dev.vars` (gitignored, never committed) as
`STRIPE_SECRET_KEY=sk_live_...`, then call the Payment Links API directly,
for example:

```bash
export $(grep -v '^#' .dev.vars | xargs)
curl "https://api.stripe.com/v1/payment_links/PLINK_ID" -u "$STRIPE_SECRET_KEY:" \
  -d "subscription_data[trial_period_days]=7"
```

Updating `trial_period_days` on an existing link only affects checkouts
created after the change. It does not touch anyone already mid-trial.

---

## Admin dashboard

`https://roowatch.com.au/dashboard` → Marketing tab → enter the
`ADMIN_PASSWORD`. Gives you the funnels, the member list with plan switching,
the pipeline view and Stripe payments.

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
