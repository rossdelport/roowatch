# Scraper decision: Apify out, Bright Data in

**Status: DONE and live.**
**Decided and shipped 16 August 2026.**

All scraping now runs through Bright Data. The scanner is live again. The Apify
code is still in `db/pipeline.ts` but nothing calls it; delete it once Bright
Data has run clean for a few days.

Everything below is measured against real bills and real API responses. Where a
number is an estimate it says so.

---

## The short version

Apify charged us **per group per check**, whether or not it found anything.
82% of the bill bought nothing. Every plan lost money.

Bright Data charges **per post delivered**. A check that finds nothing costs
**zero**. That has been confirmed against their own credit meter.

| Per Local customer, per month | Apify | Bright Data |
|---|---|---|
| Cost USD | $216 | **$9** |
| Cost AUD | $305 | **$13** |
| Revenue AUD | $297 | $297 |
| Margin | **loss** | **96%** |

---

## What went wrong with Apify

Actor: `apify/facebook-groups-scraper`.

### Its real prices

Pulled from the run object, not the marketing page:

| Event | Price |
|---|---|
| `actor-start` | $0.001 flat per run |
| `post` | $0.004 per row written to the dataset |
| `filter-applied` | $0.001 extra per row when a date filter is used |

So **every row costs $0.005**, and the run fee is irrelevant.

### The killer

When a group has no new posts, the actor still writes a row:

```json
{
  "inputUrl": "https://www.facebook.com/groups/600380330147945/",
  "error": "no_items",
  "errorDescription": "Empty or private data for provided input"
}
```

**That row is billed as a post.** One per group, every single check.

Our code discards it (`toPost` drops anything with 10 characters or less), so it
never even reached the pipeline. We paid for it and binned it.

### Measured across 30 consecutive runs, 4 groups

| Group | Real posts | Empty rows | Wasted |
|---|---|---|---|
| 600380330147945 | 14 | 20 | $0.100 |
| 728781737182929 | 6 | 25 | $0.125 |
| tradiefinderperthnorth | 3 | 27 | $0.135 |
| trustedtradiesperth | **0** | 30 | $0.150 |
| **Total** | **23** | **102** | **$0.510** |

**82% of spend bought nothing.**

### What it would have cost

Cost is `groups × checks × $0.005`, roughly independent of how busy the groups
are. That is about **$21.60 USD per group per month** at a 10 minute cadence.

| Plan | Groups | Cost AUD | Revenue AUD | Result |
|---|---|---|---|---|
| Local | 10 | $305 | $297 | loss |
| Growth | 25 | $763 | $597 | loss |
| Scale | 100 | $3,051 | $1,997 | loss |

### Two side findings

- **The cron was effectively running every 10 minutes, not 5.** Runs landed at
  :00, :10, :20 and so on. A scan takes about 20 seconds, which pushes
  `lastChecked` past the next 5 minute tick, so that tick finds nothing due and
  does nothing. The "under 5 minutes" promise was not being met. Fixing the
  cadence would have doubled the bill.
- **`trustedtradiesperth` has never returned a single post**, on either
  provider. It is probably private or dead. Ross should check it.

### Actors we ruled out

| Actor | Why not |
|---|---|
| `crowdpull/facebook-group-posts-scraper` | Advertises "Smart Scrape dedup" with a cheap `cache-check` event. Tested live: it **ignored the date filter**, returned 80 posts, billed all of them at full price, and `cache-check` was 0. Cost $0.27 for one test. |
| `memo23/facebook-public-group-posts-scraper` | $0.0015 per item is cheaper, but the empty-row behaviour was never tested. Not needed once Bright Data proved out. |
| `swerve/fb-group-scraper` | $0.0035 per item. Only 1.4x better. Same unknown. |

---

## Why Bright Data works

- Product: **Web Scraper API**
- Dataset: **Facebook - Posts by group URL**
- Dataset id: **`gd_lz11l67o2cb3r0lkj3`**
- Rate: **$1.50 per 1,000 records** pay as you go
- Free tier: **5,000 records a month, no card**
- Scale plan: **$499/month for 384,000 records**, then $1.30 per 1,000

### The three tests that decided it

All run against Ross's four real groups on 16 August 2026.

| Run | Groups | Window | Billable records | Errors | Duration |
|---|---|---|---|---|---|
| 1 | 1 | last 2h | 3 | 0 | 56s |
| 2 | 4 | last 20m | **0** | 4 | 98s |
| 3 | 4 | last 3h | 10 | 1 | 158s |

**Run 2 is the whole reason we are switching.** Four groups, nothing new to
find, and the billable record count was zero. Apify would have charged $0.02 for
exactly the same question.

**Confirmed by their meter, not by inference.** Free credits went from
`5,000/5,000` to `4,987/5,000`. That is 3 + 0 + 10 = 13. The empty run cost
nothing.

### The date filter works at time granularity

This was the make-or-break question. If `start_date` only accepted a date, every
check would return the whole day's posts again and the economics would be worse
than Apify.

It accepts a full ISO timestamp. Asked for posts newer than
`2026-08-16T01:47:06Z`, we got back exactly three posts, timestamped 02:36:54,
02:40:39 and 02:43:33. Nothing older leaked through.

### Errors are returned but not billed

A group with nothing new produces a row like:

```json
{ "warning": "Posts for the specified period were not found" }
```

The progress endpoint reports these separately from records:

```json
{ "status": "ready", "records": 0, "errors": 4, "error_codes": { "dead_page": 4 } }
```

`records` (also `dataset_size` on the snapshots list) is the billable number.

### Bonuses we did not expect

- **`group_members` comes back free.** Test groups reported 5,000 / 61,100 /
  3,900 members. This is the member count column the groups table wanted, which
  we had previously written off as impossible.
- **Parallel calls cost nothing extra.** No per-run fee means no reason to batch
  carefully. The whole `GROUPS_PER_RUN` chunking dance exists only because Apify
  charged per run. It can be simplified once we switch.
- **A real lead appeared in the test data.** *"Looking for someone to waterblast
  weeds and moss away."* From a 3 hour window on Ross's own groups.

---

## How to call it

### Auth

```
Authorization: Bearer <BRIGHTDATA_API_KEY>
```

A **zone** must exist on the account or every request fails with
`{"can_make_requests": false, "auth_fail_reason": "zone_not_found"}`. Ross has
created one. Check with `GET https://api.brightdata.com/status`.

### Trigger (asynchronous)

```
POST https://api.brightdata.com/datasets/v3/trigger
     ?dataset_id=gd_lz11l67o2cb3r0lkj3
     &include_errors=true
     &limit_per_input=25
```

```json
[
  { "url": "https://www.facebook.com/groups/600380330147945/",
    "start_date": "2026-08-16T01:47:06.000Z",
    "end_date": "",
    "user_to_not_include": "" }
]
```

Returns `{"snapshot_id": "sd_..."}`.

### Poll

```
GET https://api.brightdata.com/datasets/v3/progress/{snapshot_id}
```

`status` goes `running` then `ready`.

### Collect

```
GET https://api.brightdata.com/datasets/v3/snapshot/{snapshot_id}?format=json
```

### Do not bother with synchronous mode

`POST /datasets/v3/scrape` exists and the dashboard offers it, but it gives up
after about 60 seconds and hands back a snapshot id anyway. Four groups take
longer than that. Use trigger and poll.

### Useful fields on each row

`post_id`, `url`, `content`, `date_posted`, `user_username_raw`, `user_url`,
`group_name`, `group_id`, `group_members`, `num_comments`, `num_shares`,
`num_reaction_type`, `hashtags`, `post_image`, `attachments`.

---

## The trade-off

Collection takes **60 to 160 seconds**, averaging roughly 25 to 40 seconds per
group with real parallelism (1 group 56s, 4 groups 98s).

With a 5 minute trigger cadence, a lead reaches the member roughly **3 to 7
minutes** after it is posted. That is close to what Apify actually delivered and
it is honest against the "about 5 minutes" promise on the site.

**Untested:** how the duration scales past 4 groups. Nobody has 25 groups yet.
Measure it before selling Growth or Scale.

---

## Fair use is now the cost ceiling

`POSTS_PER_MONTH` in [db/pipeline.ts](../db/pipeline.ts) caps each member at
10,000 posts read per month. That was written as a fair use rule. Under Bright
Data pricing it is also a hard cost ceiling:

| | |
|---|---|
| Worst case per customer | 10,000 records |
| Cost | $15 USD, about $21 AUD |
| Revenue | $297 AUD |
| **Worst possible margin** | **93%** |

Keep that limit. It is load-bearing now.

---

## How the scanner works now

Bright Data is asynchronous, so one pass is two steps that may land in different
cron ticks.

```
tick A   trigger a collection for every due group
         write the snapshot id into scan_jobs
tick B   claim a ready job so only one Worker can collect it
         read the posts, alert, move sources.lastChecked
         checkpoint each finished group in scan_jobs
```

**The `scan_jobs` row is the important part.** It is what stops a later tick
triggering a second collection for the same groups while the first is still
running. That would be paying twice.

**`sources.lastChecked` only moves once posts are processed.** So an abandoned
collection costs us the records it fetched but can never lose a post: the next
trigger simply asks for a wider window.

A job still running after 20 minutes is treated as dead and dropped. A normal
collection error gets one retry. If a Worker is killed while collecting, the
claim expires and the bad job is dropped without blocking the other jobs.

Live scan batches are triggered before finished snapshots are collected. Only
two finished scan jobs and one catalogue job may be collected in a tick. This
keeps one large response from consuming the whole Worker CPU budget.

### Proof it works

First live run, 16 August 2026:

| | |
|---|---|
| Triggered | 04:30:23, all 4 groups, one snapshot |
| Duration | 123 seconds |
| Collected | 04:35:18 to 04:35:27 |
| Billed records | **2** |
| Free error rows | 3 groups with nothing new |
| Cost | **$0.003 USD** |

The identical scan on Apify cost **$0.021**, because it charged for all four
groups whether or not they had anything.

## Still to do

1. Delete the Apify path from [db/pipeline.ts](../db/pipeline.ts) once this has
   run clean for a few days, along with `APIFY_TOKEN`.
2. Store `group_members` (Bright Data returns it free) and show it in the setup
   wizard's groups table.
3. Measure collection duration at 10 and 25 groups before selling Growth or
   Scale. Only 4 groups have ever been tested.

## Buying decisions

**Do not buy the $499 Bright Data plan yet.** Pay as you go at $1.50 per 1,000
covers roughly the first ten customers. The free 5,000 records a month covers
Ross's own testing entirely.
