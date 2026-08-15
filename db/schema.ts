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
  website: text("website").notNull().default(""),
  services: text("services").notNull().default(""),
  location: text("location").notNull().default(""),
  brief: text("brief").notNull().default(""),
  alertPhone: text("alert_phone").notNull().default(""),
  postsUsed: integer("posts_used").notNull().default(0),
  usageMonth: text("usage_month").notNull().default(""),
  smsEnabled: integer("sms_enabled").notNull().default(0),
  emailEnabled: integer("email_enabled").notNull().default(1),
  onboardedAt: text("onboarded_at"),
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

export const seenPosts = sqliteTable("seen_posts", {
  id: text("id").primaryKey(),
  sourceId: integer("source_id").notNull(),
  seenAt: integer("seen_at").notNull(),
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
  emailSent: integer("email_sent").notNull().default(0),
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
