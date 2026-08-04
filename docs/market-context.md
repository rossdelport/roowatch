# RooWatch market context

This document records the reference product and market positioning that informed RooWatch. It is context, not a product specification or a claim that RooWatch should copy the reference business.

Captured: 2026-08-04

## Reference pages

- [Groups Watcher on TrustMRR](https://trustmrr.com/startup/groups-watcher)
- [Groups Watcher website](https://www.groupswatcher.com/)

## TrustMRR listing

The TrustMRR page positions Groups Watcher as a service that finds high-intent requests in Facebook groups and alerts the customer quickly. The page currently reports the following third-party listing metrics:

- MRR: **$23,822**
- Active subscriptions: **146**
- All-time revenue: **$84,114**
- Founded: **July 2024**
- Listed pricing: **$49 intro offer** and **$499 business plan**
- Stated audience: SaaS companies, brands, nonprofits, and agencies
- Stated acquisition channel: SEO
- Reported stack: Next.js, Supabase, and Stripe

These numbers are a dated marketplace snapshot and should be treated as unverified marketing/marketplace data that can change.

## Groups Watcher product positioning

The landing page describes four main jobs:

1. **Lead generation:** catch recommendation requests while they are still fresh.
2. **Brand monitoring:** detect mentions, questions, and complaints in groups.
3. **Buying opportunities:** surface posts where someone is looking to buy or sell.
4. **Data feeds:** deliver structured new-post data to a webhook or another product.

The advertised workflow is:

1. Select Facebook group URLs.
2. Describe the desired post intent in plain English.
3. Choose an alert destination such as email, Slack, Teams, Google Chat, Discord, Ntfy, or a custom webhook.
4. The provider monitors the groups and applies an AI relevance check.

The page markets these claims:

- Alerts within **60 seconds** of a relevant post.
- Public and private group monitoring on the Professional plan.
- No customer Facebook login, password, cookie, or account access.
- Alerts containing the post text, group, post link, and timestamp.
- Professional plan: **$199/month** after the intro offer, with 10 groups.
- Done-for-you lead generation: **$1,499/month**, with 300 public groups and provider-managed commenting.

These are the competitor's own product and marketing claims, not independent technical verification.

## RooWatch implications

For an Australian launch, the useful hypotheses to validate are:

- Start with **public groups** and a clear local-service niche.
- Lead with a conservative **under-five-minute alert** promise until measured reliability supports something faster.
- Make the alert itself the product: post text, group, direct link, timestamp, and a short relevance reason.
- Support email first, then add team/webhook destinations after the core alert loop is reliable.
- Use the mascot and landing page to test demand before building the full monitoring operation.
- Treat private-group access, managed accounts, and automated commenting as later operational tiers with separate compliance and reliability review.

