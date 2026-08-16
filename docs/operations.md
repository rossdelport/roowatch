# Operations runbook

Everything you need to run RooWatch day to day. Commands are copy-paste ready.

Worker name: `roowatch`. Database: `roowatch-db`
(`de017f20-c9f8-4cc2-94e1-cd419049aecc`). Domain: `roowatch.com.au`.

---

## The scanner is currently paused

**As of 16 August 2026 every row in `sources` has `active = 0`.** This was
deliberate, to stop Apify costs while we move to Bright Data. See
[scraper-decision.md](scraper-decision.md).

The cron still fires every 5 minutes. It finds no active sources, returns early,
and never calls the scraper. Zero cost.

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

### Apify

```bash
curl -s "https://api.apify.com/v2/actor-runs?token=$APIFY_TOKEN&limit=20&desc=1" \
  | python3 -c "import sys,json
for r in json.load(sys.stdin)['data']['items']:
    print(r['startedAt'][:19], r.get('chargedEventCounts'), r.get('usageTotalUsd'))"
```

The billing chart in the Apify dashboard defaults to **Cumulative**. Switch it
to **Absolute** or you will misread a running total as a daily spend. This
caused a false alarm once.

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

Values cannot be read back. Current secrets: `ADMIN_PASSWORD`,
`ANTHROPIC_API_KEY`, `APIFY_TOKEN`, `CRON_SECRET`, `RESEND_API_KEY`,
`STRIPE_SECRET_KEY`. Bright Data will need `BRIGHTDATA_API_KEY`.

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

Three live products with monthly AUD prices and payment links.

| Plan | Price id | Payment link |
|---|---|---|
| Local $297 | `price_1U4sCe9HOJbWqVToqrNBDaIp` | `buy.stripe.com/3cI9AN2Df9vYgVyg6bgUM01` |
| Growth $597 | `price_1U4sCg9HOJbWqVToRKrBxw6W` | `buy.stripe.com/00w5kx4LnbE6dJm6vBgUM02` |
| Scale $1,997 | `price_1U4sCh9HOJbWqVToU4GpQFTO` | `buy.stripe.com/6oUfZb5PreQifRu4ntgUM03` |

There is **no webhook**. Payment does not automatically set a member's plan.
Ross sets it by hand in the admin panel after someone pays.

---

## Admin dashboard

`https://roowatch.com.au/dashboard` → Marketing tab → enter the
`ADMIN_PASSWORD`. Gives you the funnels, the member list with plan switching,
the pipeline view and Stripe payments.

---

## Emails

Sent through Resend from `notify@trynoisy.com`. That is the only verified
domain, which is why alerts do not come from `roowatch.com.au`. Replies go to
`ross@roowatch.com.au`.

Signup and onboarding notifications go to both `ross@roowatch.com.au` and
`rossdelport1998@gmail.com`.

---

## Known open items

- Move the scraper to Bright Data. See [scraper-decision.md](scraper-decision.md).
- `trustedtradiesperth` has never returned a post on either provider. Probably
  private or dead. Check it on Facebook and remove it if so.
- Measure Bright Data collection time at 10 and 25 groups before selling Growth
  or Scale.
- No rate limit on `/api/auth/login`.
- The `$49` intro offer was removed with the price change and never replaced.
- 21 waitlist leads have never been called.
