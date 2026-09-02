import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  avatar: text("avatar").notNull().default(""),
  passwordHash: text("password_hash").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const loginTokens = sqliteTable("login_tokens", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
  used: integer("used").notNull().default(0),
});

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const profiles = sqliteTable("profiles", {
  userId: text("user_id").primaryKey(),
  businessName: text("business_name").notNull().default(""),
  trade: text("trade").notNull().default(""),
  state: text("state").notNull().default(""),
  plan: text("plan").notNull().default("local"),
  website: text("website").notNull().default(""),
  gbpUrl: text("gbp_url").notNull().default(""),
  services: text("services").notNull().default(""),
  location: text("location").notNull().default(""),
  brief: text("brief").notNull().default(""),
  alertPhone: text("alert_phone").notNull().default(""),
  /**
   * The Meta click and browser ids, captured at signup from the cookies the
   * ad click leaves behind. Kept because CompleteRegistration and Purchase
   * happen minutes or days later, server side, with no browser in the loop.
   * Without them Meta cannot tell which ad set produced a paying member.
   */
  fbc: text("fbc").notNull().default(""),
  fbp: text("fbp").notNull().default(""),
  postsUsed: integer("posts_used").notNull().default(0),
  usageMonth: text("usage_month").notNull().default(""),
  smsUsed: integer("sms_used").notNull().default(0),
  smsMonth: text("sms_month").notNull().default(""),
  /**
   * Texts are switched on at signup, in app/api/auth/signup/route.ts, using the
   * mobile they gave. The column default stays 0 on purpose: changing it makes
   * SQLite rebuild the whole profiles table, and the signup route sets the
   * value explicitly anyway.
   */
  smsEnabled: integer("sms_enabled").notNull().default(0),
  emailEnabled: integer("email_enabled").notNull().default(1),
  /**
   * The setup wizard as they left it, JSON, saved on every step. Only the
   * wizard reads it. Real rows are still only written when they press Start
   * watching, so a half finished setup never creates a source and never costs
   * us a scan. Cleared once they finish.
   */
  wizardDraft: text("wizard_draft").notNull().default(""),
  /** Unix ms of the last watchlist top up, so it does not search every tick. */
  lastTopUp: integer("last_top_up").notNull().default(0),
  /**
   * How far out we have already looked for this member's groups. Each top up
   * that still cannot fill their list searches the next ring of suburbs out,
   * so nobody gets the same fruitless search run at them every six hours.
   */
  searchRing: integer("search_ring").notNull().default(0),
  onboardedAt: text("onboarded_at"),
  /** Set by the Stripe webhook. Empty until a checkout completes. */
  stripeCustomerId: text("stripe_customer_id").notNull().default(""),
  /** Mirrors the Stripe subscription status: trialing, active, past_due,
   *  unpaid, canceled. Empty until a checkout completes. */
  subscriptionStatus: text("subscription_status").notNull().default(""),
  /** Unix seconds their trial ends, straight from Stripe. 0 when there is no
   *  trial. Stored rather than fetched so the dashboard never waits on Stripe
   *  just to draw a pill. */
  trialEndsAt: integer("trial_ends_at").notNull().default(0),
  /** Unix seconds their subscription is scheduled to end, 0 when it is not.
   *  Cancelling in the portal takes effect at the end of the period they paid
   *  for, so without this a member who cancels sees no sign of it anywhere. */
  cancelAt: integer("cancel_at").notNull().default(0),
});

export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupName: text("group_name").notNull(),
  url: text("url").notNull().default(""),
  active: integer("active").notNull().default(1),
  lastChecked: integer("last_checked").notNull().default(0),
  lastCount: integer("last_count").notNull().default(0),
  lastMatches: integer("last_matches").notNull().default(0),
  lastError: text("last_error").notNull().default(""),
  /**
   * How many people are in the group, straight from Facebook via the post
   * data. 0 until the group produces its first post. Bigger is not always
   * better, but a member choosing between groups deserves to see it.
   */
  members: integer("members").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/**
 * One in-flight Bright Data snapshot.
 *
 * Bright Data is asynchronous: you trigger a collection, then come back for the
 * results. A collection can outlive the cron tick that started it, so we write
 * the snapshot id down. Without this row a later tick would trigger a second
 * collection for the same groups and we would pay twice.
 */
/**
 * A tiny key value table for scanner coordination and the watchdog.
 *
 * It holds the last alarm time and short timestamp leases. Expired leases are
 * safe to claim after a Worker is killed because no cleanup hook will run.
 */
export const health = sqliteTable("health", {
  id: text("id").primaryKey(),
  value: integer("value").notNull().default(0),
});

export const scanJobs = sqliteTable("scan_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotId: text("snapshot_id").notNull(),
  /** JSON array of source ids this snapshot covers. */
  sourceIds: text("source_ids").notNull(),
  startedAt: integer("started_at").notNull(),
  status: text("status").notNull().default("running"),
});

/**
 * Every post we have read, for 14 days.
 *
 * Its first job is dedup: it answers "have I paid for this one already?".
 * It also backs the Posts tab, so a member with no leads yet can see the
 * machine working and judge for themselves that nothing matched.
 */
export const seenPosts = sqliteTable("seen_posts", {
  id: text("id").primaryKey(),
  sourceId: integer("source_id").notNull(),
  seenAt: integer("seen_at").notNull(),
  text: text("text").notNull().default(""),
  url: text("url").notNull().default(""),
  author: text("author").notNull().default(""),
});

export const groups = sqliteTable("groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  sourceId: integer("source_id"),
  status: text("status").notNull().default("watching"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  groupName: text("group_name").notNull(),
  postText: text("post_text").notNull(),
  postUrl: text("post_url").notNull().default(""),
  reason: text("reason").notNull().default(""),
  postKey: text("post_key").notNull().default(""),
  /** Short code behind roowatch.com.au/l/xxxxxx. A raw Facebook permalink is
   *  about 70 characters and would push a text past one billable segment. */
  shortCode: text("short_code").notNull().default(""),
  emailSent: integer("email_sent").notNull().default(0),
  smsSent: integer("sms_sent").notNull().default(0),
  sentAt: text("sent_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  userPostKeyUnique: uniqueIndex("alerts_user_post_key_unique")
    .on(table.userId, table.postKey)
    .where(sql`${table.postKey} <> ''`),
}));

/**
 * One support conversation per member, both sides in the same table.
 *
 * Priority support is sold on the Growth and Scale plans, so a tradie needs
 * somewhere to ask that is not "email Ross and hope". Read flags drive the
 * unread badges on both ends.
 */
export const supportMessages = sqliteTable("support_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  /** 1 when Ross wrote it, 0 when the member did. */
  fromAdmin: integer("from_admin").notNull().default(0),
  body: text("body").notNull(),
  readByMember: integer("read_by_member").notNull().default(0),
  readByAdmin: integer("read_by_admin").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  path: text("path").notNull().default(""),
  ref: text("ref").notNull().default(""),
  device: text("device").notNull().default(""),
  ts: integer("ts").notNull(),
});

export const waitlist = sqliteTable("waitlist", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  phone: text("phone").notNull().default(""),
  trade: text("trade").notNull().default(""),
  /** Where Ross has got to with them: new, booked, client or dead. */
  status: text("status").notNull().default("new"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/**
 * Every Facebook group RooWatch has ever found, whether anyone watches it yet
 * or not.
 *
 * Deliberately separate from `sources`. A row in sources is scanned every
 * minute and costs money, so discovery must never write there: the first
 * plumber in Joondalup would have us paying to read thirty five groups nobody
 * had chosen. This is a catalogue, not a watchlist. A group only becomes a
 * source when a member actually picks it.
 *
 * It fills itself. Search for the first member in a suburb, and the next one
 * gets the answer instantly and for nothing.
 */
export const foundGroups = sqliteTable("found_groups", {
  slug: text("slug").primaryKey(),
  url: text("url").notNull(),
  name: text("name").notNull(),
  /** From Bright Data once the group is scanned. 0 until then. */
  members: integer("members").notNull().default(0),
  state: text("state").notNull().default(""),
  /** The suburb we were searching when we found it. */
  suburb: text("suburb").notNull().default(""),
  score: integer("score").notNull().default(0),
  foundAt: integer("found_at").notNull().default(0),
  /**
   * 1 once Bright Data has actually read this group and it came back readable.
   * A search result proves nothing: a private group's listing looks exactly
   * like a public one's. Only a checked row is ever offered to a member.
   */
  checked: integer("checked").notNull().default(0),
});

/**
 * Groups a member took off their own list.
 *
 * The top up puts groups back until somebody has a full watchlist, so without
 * this it would cheerfully re-add the one they just deleted, forever.
 */
export const droppedGroups = sqliteTable("dropped_groups", {
  userId: text("user_id").notNull(),
  slug: text("slug").notNull(),
  droppedAt: integer("dropped_at").notNull().default(0),
});

/**
 * A Bright Data snapshot opened purely to size up newly discovered groups.
 *
 * Kept apart from scan_jobs on purpose. Those belong to members who are paying
 * to be watched; these are catalogue work, they alert nobody, and they must
 * never be mistaken for a watchlist.
 */
export const catalogueJobs = sqliteTable("catalogue_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotId: text("snapshot_id").notNull(),
  /** JSON array of group slugs this snapshot covers. */
  slugs: text("slugs").notNull(),
  startedAt: integer("started_at").notNull(),
});

/**
 * Every Australian locality with its postcode and state, 17,403 of them.
 *
 * Here because suburb names repeat: there is a Richmond in five states, and
 * more of them overseas. A postcode does not repeat, which makes it the one
 * reliable way to tell a Melbourne group from a Perth one or a Virginian one.
 */
export const postcodes = sqliteTable("postcodes", {
  locality: text("locality").notNull(),
  state: text("state").notNull(),
  postcode: text("postcode").notNull(),
});
