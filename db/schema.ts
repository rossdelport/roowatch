import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  /**
   * The setup wizard as they left it, JSON, saved on every step. Only the
   * wizard reads it. Real rows are still only written when they press Start
   * watching, so a half finished setup never creates a source and never costs
   * us a scan. Cleared once they finish.
   */
  wizardDraft: text("wizard_draft").notNull().default(""),
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
  /** Stripe's own cycle boundary. Private scraper budgets reset here. */
  billingPeriodStart: integer("billing_period_start").notNull().default(0),
  billingPeriodEnd: integer("billing_period_end").notNull().default(0),
  privateBudgetStatus: text("private_budget_status").notNull().default("ready"),
  privateBudgetPausedUntil: integer("private_budget_paused_until").notNull().default(0),
}, (table) => ({
  stripeCustomer: index("profiles_stripe_customer_idx").on(table.stripeCustomerId),
  privateBudgetStatus: index("profiles_private_budget_status_idx")
    .on(table.privateBudgetStatus),
}));

export const sources = sqliteTable("sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupName: text("group_name").notNull(),
  url: text("url").notNull().default(""),
  active: integer("active").notNull().default(1),
  lastChecked: integer("last_checked").notNull().default(0),
  lastCount: integer("last_count").notNull().default(0),
  lastMatches: integer("last_matches").notNull().default(0),
  lastError: text("last_error").notNull().default(""),
  /** Public uses Bright Data. Private uses the VPS. Unknown is never scanned. */
  visibility: text("visibility").notNull().default("unknown"),
  visibilityCheckedAt: integer("visibility_checked_at").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => ({
  urlUnique: uniqueIndex("sources_url_unique")
    .on(table.url)
    .where(sql`${table.url} <> ''`),
  visibilityActiveChecked: index("sources_visibility_active_checked_idx")
    .on(table.visibility, table.active, table.lastChecked),
}));

/** Bright Data classification is asynchronous, so pasted links are cached. */
export const groupVisibilityChecks = sqliteTable("group_visibility_checks", {
  slug: text("slug").primaryKey(),
  url: text("url").notNull(),
  snapshotId: text("snapshot_id").notNull().default(""),
  status: text("status").notNull().default("checking"),
  groupName: text("group_name").notNull().default(""),
  error: text("error").notNull().default(""),
  checkedAt: integer("checked_at").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

/** Per-user daily unique-link guard around paid visibility probes. */
export const groupVisibilityAttempts = sqliteTable("group_visibility_attempts", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  day: text("day").notNull(),
  slug: text("slug").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => ({
  userDay: index("group_visibility_attempts_user_day_idx")
    .on(table.userId, table.day),
  created: index("group_visibility_attempts_created_idx").on(table.createdAt),
}));

/** Serialises limit checks for one member while a group is being added. */
export const groupMutationLocks = sqliteTable("group_mutation_locks", {
  userId: text("user_id").primaryKey(),
  owner: text("owner").notNull().default(""),
  lockedUntil: integer("locked_until").notNull().default(0),
});

/** One VPS process reports here even when it has no Facebook account ready. */
export const privateScraperWorkers = sqliteTable("private_scraper_workers", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  status: text("status").notNull().default("unknown"),
  proxyStatus: text("proxy_status").notNull().default("unknown"),
  version: text("version").notNull().default(""),
  lastHeartbeatAt: integer("last_heartbeat_at").notNull().default(0),
  lastError: text("last_error").notNull().default(""),
  estimatedMaxCostAudMicros: integer("estimated_max_cost_aud_micros").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

/** D1 dispatch lease makes budget read plus reservation single-writer. */
export const privateDispatchLock = sqliteTable("private_dispatch_lock", {
  id: integer("id").primaryKey(),
  owner: text("owner").notNull().default(""),
  lockedUntil: integer("locked_until").notNull().default(0),
});

/** Stable account ids point at encrypted sessions kept on the VPS. */
export const privateScraperAccounts = sqliteTable("private_scraper_accounts", {
  id: text("id").primaryKey(),
  workerId: text("worker_id").notNull(),
  label: text("label").notNull().default(""),
  active: integer("active").notNull().default(1),
  status: text("status").notNull().default("unknown"),
  sessionStatus: text("session_status").notNull().default("unknown"),
  proxyStatus: text("proxy_status").notNull().default("unknown"),
  lastHeartbeatAt: integer("last_heartbeat_at").notNull().default(0),
  lastHealthCheckAt: integer("last_health_check_at").notNull().default(0),
  lastScanAt: integer("last_scan_at").notNull().default(0),
  cookieSavedAt: integer("cookie_saved_at").notNull().default(0),
  sessionExpiresAt: integer("session_expires_at").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  latestErrorCode: text("latest_error_code").notNull().default(""),
  latestError: text("latest_error").notNull().default(""),
  validateRequestedAt: integer("validate_requested_at").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({
  workerActive: index("private_scraper_accounts_worker_active_idx")
    .on(table.workerId, table.active),
}));

/** Health and account assignment for one private source. */
export const privateGroupStates = sqliteTable("private_group_states", {
  sourceId: integer("source_id").primaryKey(),
  accountId: text("account_id").notNull().default(""),
  status: text("status").notNull().default("waiting_for_access"),
  lastCheckAt: integer("last_check_at").notNull().default(0),
  lastSuccessAt: integer("last_success_at").notNull().default(0),
  nextCheckAt: integer("next_check_at").notNull().default(0),
  bytesTransferred: integer("bytes_transferred").notNull().default(0),
  postsCollected: integer("posts_collected").notNull().default(0),
  spendAudMicros: integer("spend_aud_micros").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  latestErrorCode: text("latest_error_code").notNull().default(""),
  latestError: text("latest_error").notNull().default(""),
  retryRequestedAt: integer("retry_requested_at").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({
  account: index("private_group_states_account_idx").on(table.accountId),
  nextCheck: index("private_group_states_next_check_idx").on(table.nextCheckAt),
}));

/** A reservation becomes one measured check result. run_id is idempotent. */
export const privateScrapeChecks = sqliteTable("private_scrape_checks", {
  runId: text("run_id").primaryKey(),
  kind: text("kind").notNull().default("scan_group"),
  sourceId: integer("source_id").notNull().default(0),
  accountId: text("account_id").notNull().default(""),
  workerId: text("worker_id").notNull().default(""),
  status: text("status").notNull().default("reserved"),
  createdAt: integer("created_at").notNull(),
  deadlineAt: integer("deadline_at").notNull(),
  startedAt: integer("started_at").notNull().default(0),
  finishedAt: integer("finished_at").notNull().default(0),
  reservedAudMicros: integer("reserved_aud_micros").notNull().default(0),
  actualAudMicros: integer("actual_aud_micros").notNull().default(0),
  proxyAmountMicros: integer("proxy_amount_micros").notNull().default(0),
  proxyCurrency: text("proxy_currency").notNull().default("AUD"),
  audRateMicros: integer("aud_rate_micros").notNull().default(1000000),
  proxyCostAudMicros: integer("proxy_cost_aud_micros").notNull().default(0),
  vpsCostAudMicros: integer("vps_cost_aud_micros").notNull().default(0),
  bytesTransferred: integer("bytes_transferred").notNull().default(0),
  postsCollected: integer("posts_collected").notNull().default(0),
  chronologicalVerified: integer("chronological_verified").notNull().default(0),
  boundaryReached: integer("boundary_reached").notNull().default(0),
  feedEndReached: integer("feed_end_reached").notNull().default(0),
  errorCode: text("error_code").notNull().default(""),
  errorDetail: text("error_detail").notNull().default(""),
}, (table) => ({
  workerStatusDeadline: index("private_scrape_checks_worker_status_deadline_idx")
    .on(table.workerId, table.status, table.deadlineAt),
  sourceStatusDeadline: index("private_scrape_checks_source_status_deadline_idx")
    .on(table.sourceId, table.status, table.deadlineAt),
  accountKindStatus: index("private_scrape_checks_account_kind_status_idx")
    .on(table.accountId, table.kind, table.status),
  finished: index("private_scrape_checks_finished_idx").on(table.finishedAt),
}));

/** Each member pays one exact share of a shared check, never a second bill. */
export const privateCostAllocations = sqliteTable("private_cost_allocations", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  userId: text("user_id").notNull(),
  sourceId: integer("source_id").notNull(),
  periodStart: integer("period_start").notNull(),
  periodEnd: integer("period_end").notNull(),
  reservedAudMicros: integer("reserved_aud_micros").notNull().default(0),
  actualAudMicros: integer("actual_aud_micros").notNull().default(0),
  status: text("status").notNull().default("reserved"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => ({
  runUserUnique: uniqueIndex("private_cost_allocations_run_user_unique")
    .on(table.runId, table.userId),
  userPeriodStatus: index("private_cost_allocations_user_period_status_idx")
    .on(table.userId, table.periodStart, table.periodEnd, table.status),
  run: index("private_cost_allocations_run_idx").on(table.runId),
}));

/** Open incidents are updated in place to prevent an SMS storm. */
export const privateIncidents = sqliteTable("private_incidents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fingerprint: text("fingerprint").notNull().unique(),
  severity: text("severity").notNull().default("emergency"),
  status: text("status").notNull().default("open"),
  kind: text("kind").notNull(),
  targetType: text("target_type").notNull().default("system"),
  targetId: text("target_id").notNull().default(""),
  title: text("title").notNull(),
  detail: text("detail").notNull().default(""),
  firstSeenAt: integer("first_seen_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  occurrences: integer("occurrences").notNull().default(1),
  lastAlertAt: integer("last_alert_at").notNull().default(0),
  nextReminderAt: integer("next_reminder_at").notNull().default(0),
  smsState: text("sms_state").notNull().default("pending"),
  emailState: text("email_state").notNull().default("pending"),
  recoveryState: text("recovery_state").notNull().default("pending"),
  recoverySmsState: text("recovery_sms_state").notNull().default("pending"),
  recoveryEmailState: text("recovery_email_state").notNull().default("pending"),
  resolvedAt: integer("resolved_at").notNull().default(0),
}, (table) => ({
  statusSeen: index("private_incidents_status_seen_idx")
    .on(table.status, table.lastSeenAt),
}));

/** Human-readable audit trail for checks, recovery and admin controls. */
export const privateActions = sqliteTable("private_actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  targetType: text("target_type").notNull().default("system"),
  targetId: text("target_id").notNull().default(""),
  message: text("message").notNull(),
  status: text("status").notNull().default("ok"),
  createdAt: integer("created_at").notNull(),
}, (table) => ({
  created: index("private_actions_created_idx").on(table.createdAt),
}));

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
}, (table) => ({
  userStatus: index("groups_user_status_idx").on(table.userId, table.status),
  sourceStatus: index("groups_source_status_idx").on(table.sourceId, table.status),
}));

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
