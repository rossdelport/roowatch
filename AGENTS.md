# Working on RooWatch

Rules, conventions and traps for anyone (human or AI) touching this repo.
Read [README.md](README.md) first for what the product is.

---

## Hard rules from the owner

These are Ross's own words. They override any instinct you have.

> "Do not touch code that is already working. Do not fix something that doesn't
> need to be fixed. And also do not over design or architect something. Keep it
> simple and the most effective way possible."

> "Please never use em dash in the copy."

Two more, learned the hard way:

- **Never invent data.** Early on an agent wrote a fake test lead into the
  alerts table. Ross clicked it, landed on an unrelated post, and rightly said
  *"claude that was NOT a lead mate."* Verify with real data or say you have not
  verified it.
- **Never guess at money.** Cost estimates in this project have been wrong more
  than once, each time expensively. Measure against the real bill, then report.
  If you are estimating, say so in the same sentence.

## Copy style

Website copy is **grade 3 English**. Short sentences. Simple words. One idea per
sentence. No em dashes anywhere, ever. Australian spelling and idiom ("tradie",
"suburb", "G'day").

Prices are **AUD**. Supplier costs are usually quoted in **USD**. Always label
which one you mean. At the time of writing 1 USD is about 1.41 AUD.

## The runtime will bite you

The app runs inside a Cloudflare Worker. It is not Node.

| You cannot | Do this instead |
|---|---|
| `fs.readFileSync` | import the file with `?raw`, e.g. `import html from "./landing.html?raw"` |
| Cheerio, Playwright, jsdom | strip tags with a regex, see [db/website.ts](db/website.ts) |
| bcrypt, argon2 | Web Crypto PBKDF2, see [db/password.ts](db/password.ts) |
| Long CPU work | I/O waits are fine, CPU time is capped |

`Date.now()` and `fetch` are fine.

## Database

Cloudflare D1, accessed with Drizzle. Schema lives in [db/schema.ts](db/schema.ts).

**Migrations are not automatic.** `npm run db:generate` writes a file into
`drizzle/`. Deploying does **not** apply it. You must run it by hand:

```bash
npx wrangler d1 execute roowatch-db --remote --file=drizzle/00XX_name.sql
```

This has already caused one production incident. Another agent pushed a schema
change, auto-deploy shipped the code, the migration never ran, and the pipeline
would have failed silently while every page still returned 200.

**Apply the migration before you deploy the code that needs it.**

## Silent failure is the enemy

This product's worst bug class is "everything returns 200 and no leads ever
arrive". It has happened three times:

1. Onboarding created groups with `status: "pending"` but the pipeline only
   alerted on `status: "watching"`. Nothing ever promoted them.
2. Group to source matching was case sensitive, so "Trusted **t**radies Perth"
   never matched "Trusted **T**radies Perth".
3. Facebook links that were not `/groups/` format, including the mobile share
   sheet format, were silently discarded during onboarding.

When you write anything in the lead path, ask: **if this silently did nothing,
would anyone find out?** If the answer is no, add a counter, an error field or a
log line.

## The Stripe webhook

[app/api/webhooks/stripe/route.ts](app/api/webhooks/stripe/route.ts), live since
16 August 2026. Stripe calls it on `checkout.session.completed`,
`customer.subscription.updated` and `customer.subscription.deleted`. It sets
`profiles.plan` and `profiles.subscriptionStatus`, and on a lapsed payment it
sets that member's `groups.status` to `"paused"` and emails both the member
and Ross.

Two things to keep in mind if you touch it:

- **A source is shared.** Two members can watch the same public Facebook
  group, so pausing a member never touches `sources.active` unless they were
  the last one watching it. Deactivating a shared source on someone else's
  cancellation would silently cut off a paying customer.
- **Side effects happen before the `subscriptionStatus` write, not after.**
  If a step throws, Stripe retries the whole event and the old status is still
  on the row, so the retry runs the pause or reactivate again instead of
  skipping it. Do not reorder this without preserving that property.

## Testing

There is a small suite (`npm test`) that renders the public pages. It will not
catch pipeline bugs.

The real verification pattern used in this repo is:

1. Apply migrations to production D1.
2. Push, wait for the deploy (poll for a marker, roughly 6 minutes).
3. Create a real test account through the live API with curl.
4. Exercise the real endpoints and read the real database.
5. **Delete the test account, its groups, and any `sources` rows it created.**

That last step matters. A leftover `sources` row means the scanner starts paying
to scrape a group nobody wants.

## Secrets

Set as Worker secrets, not in the repo. List them with:

```bash
npx wrangler secret list --name roowatch
```

Current: `ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`, `APIFY_TOKEN`, `BRIGHTDATA_API_KEY`,
`CRON_SECRET`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY`. `STRIPE_WEBHOOK_SECRET`
is needed too, see the Stripe webhook section above.

Optional: `LEAD_VERIFY_MODEL` overrides the model that double checks every
lead before it is texted (default in `db/leadfilter.ts`). Set it only if that
default model id stops working.

You cannot read a secret's value back through `wrangler secret list`, it only
shows names. A key typed into `.dev.vars` (gitignored, never committed) is
different: whoever put it there can obviously still see it in that file, and
from there it can be used for local API calls or pushed to Cloudflare with
`wrangler secret put`. If you need a value that lives only as a Worker secret
and nowhere else, ask Ross.

## Conventions

- Comments explain **why**, not what. Match the density of the surrounding code.
- File references in chat use markdown links: `[pipeline.ts:42](db/pipeline.ts#L42)`.
- The dashboard is one big client component with a `CSS` template string at the
  bottom. Keep new styles in that string, grouped with a comment.
- The marketing site is one HTML file, [app/landing.html](app/landing.html),
  styles included. It is imported with `?raw`.
- Trades, states, suburbs and plans are all single-source-of-truth modules in
  `db/`. Never hardcode a group limit or a trade name in a component.

## Admin access

The master dashboard is behind a password prompt in the Marketing tab. The
password is the `ADMIN_PASSWORD` secret. Admin endpoints live under
`app/api/admin/` and all call `requireAdmin`.

`ross@roowatch.com.au` is hardcoded as the admin email in
[db/auth.ts](db/auth.ts).

## Things that are deliberately not built

Do not "fix" these without asking:

- **No password reset flow.** The magic link is the reset path.
- **No rate limit on login.** Flagged to Ross, he has not asked for it.
- **No SMS.** [db/sms.ts](db/sms.ts) exists and works but is unused.
