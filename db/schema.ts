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
  onboardedAt: text("onboarded_at"),
  /** Set by the Stripe webhook. Empty until a checkout completes. */
  stripeCustomerId: text("stripe_customer_id").notNull().default(""),
  /** Mirrors the Stripe subscription status: trialing, active, past_due,
   *  unpaid, canceled. Empty until a checkout completes. */
  subscriptionStatus: text("subscription_status").notNull().default(""),
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
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
