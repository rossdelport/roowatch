import { and, asc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { getDb } from "./index";
import { processSource, type FetchedPost } from "./pipeline";
import { groupSlug } from "./fbgroups";
import {
  privateGroupLimit,
  privateScrapingBudgetAudMicros,
  privateScrapingSafetyCutoffAudMicros,
  privateScrapingWarningAudMicros,
} from "./plans";
import {
  groups,
  privateCostAllocations,
  privateDispatchLock,
  privateGroupStates,
  privateScrapeChecks,
  privateScraperAccounts,
  privateScraperWorkers,
  profiles,
  sources,
  users,
} from "./schema";
import {
  openPrivateIncident,
  recordPrivateAction,
  resolvePrivateIncident,
} from "./private-alerts";

export const PRIVATE_SCHEDULE_MINUTES = 60;
export const PRIVATE_LOOKBACK_MINUTES = 65;
const HEARTBEAT_STALE_MS = 10 * 60 * 1000;
const JOB_DEADLINE_MS = 20 * 60 * 1000;
const MAX_JOBS_PER_POLL = 10;
const MAX_POSTS_PER_RESULT = 100;
const LAPSED_SUBSCRIPTIONS = new Set(["canceled", "unpaid", "incomplete_expired"]);
const REQUESTED_GROUP_STATUSES = ["watching", "waiting_for_access"];
const periodSyncCache = new Map<string, { at: number; watcher: BudgetWatcher }>();

function clean(value: unknown, max = 500) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const stateValue = (value: unknown, fallback = "unknown") =>
  (clean(value || fallback, 80).toLowerCase() || fallback);

function integer(value: unknown, max = 1_000_000_000_000) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) return null;
  return n;
}

function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function privateScraperAuthorised(request: Request) {
  const secret = process.env.PRIVATE_SCRAPER_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(token && sameSecret(token, secret));
}

export type HeartbeatInput = {
  workerId?: string;
  name?: string;
  atMs?: number;
  status?: string;
  proxyStatus?: string;
  version?: string;
  message?: string;
  estimatedMaxCostAudMicros?: number;
  accounts?: {
    id?: string;
    label?: string;
    status?: string;
    sessionStatus?: string;
    proxyStatus?: string;
    cookieSavedAtMs?: number;
    lastHealthCheckAtMs?: number;
    sessionExpiresAtMs?: number;
    healthValidationDue?: boolean;
    latestErrorCode?: string;
    latestError?: string;
  }[];
};

export async function savePrivateHeartbeat(body: HeartbeatInput) {
  const workerId = clean(body.workerId, 100);
  if (!workerId) throw new Error("bad_worker_id");
  const now = Date.now();
  const heartbeatAt = integer(body.atMs) ?? now;
  if (Math.abs(now - heartbeatAt) > 15 * 60 * 1000) throw new Error("bad_heartbeat_time");
  const estimated = integer(body.estimatedMaxCostAudMicros) ?? 0;
  const status = stateValue(body.status);
  const proxyStatus = stateValue(body.proxyStatus);
  const workerRootFailure =
    !["healthy", "degraded"].includes(status) || proxyStatus === "failed";

  const db = getDb();
  await db
    .insert(privateScraperWorkers)
    .values({
      id: workerId,
      name: clean(body.name || workerId, 100),
      status,
      proxyStatus,
      version: clean(body.version, 80),
      lastHeartbeatAt: heartbeatAt,
      lastError: clean(body.message),
      estimatedMaxCostAudMicros: estimated,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: privateScraperWorkers.id,
      set: {
        name: clean(body.name || workerId, 100),
        status,
        proxyStatus,
        version: clean(body.version, 80),
        lastHeartbeatAt: heartbeatAt,
        lastError: clean(body.message),
        estimatedMaxCostAudMicros: estimated,
        updatedAt: now,
      },
    });

  const reportedAccountIds = new Set<string>();
  for (const raw of (body.accounts ?? []).slice(0, 20)) {
    const id = clean(raw.id, 100);
    if (!id) continue;
    reportedAccountIds.add(id);
    const [existing] = await db
      .select({ createdAt: privateScraperAccounts.createdAt })
      .from(privateScraperAccounts)
      .where(eq(privateScraperAccounts.id, id))
      .limit(1);
    const accountStatus = stateValue(raw.status);
    const sessionStatus = stateValue(raw.sessionStatus);
    const accountProxyStatus = stateValue(raw.proxyStatus || proxyStatus);
    await db
      .insert(privateScraperAccounts)
      .values({
        id,
        workerId,
        label: clean(raw.label || id, 100),
        status: accountStatus,
        sessionStatus,
        proxyStatus: accountProxyStatus,
        lastHeartbeatAt: heartbeatAt,
        lastHealthCheckAt: integer(raw.lastHealthCheckAtMs) ?? 0,
        cookieSavedAt: integer(raw.cookieSavedAtMs) ?? 0,
        sessionExpiresAt: integer(raw.sessionExpiresAtMs) ?? 0,
        latestErrorCode: clean(raw.latestErrorCode, 80),
        latestError: clean(raw.latestError),
        validateRequestedAt: raw.healthValidationDue ? now : 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: privateScraperAccounts.id,
        set: {
          workerId,
          active: 1,
          label: clean(raw.label || id, 100),
          status: accountStatus,
          sessionStatus,
          proxyStatus: accountProxyStatus,
          lastHeartbeatAt: heartbeatAt,
          lastHealthCheckAt: integer(raw.lastHealthCheckAtMs) ?? 0,
          cookieSavedAt: integer(raw.cookieSavedAtMs) ?? 0,
          sessionExpiresAt: integer(raw.sessionExpiresAtMs) ?? 0,
          latestErrorCode: clean(raw.latestErrorCode, 80),
          latestError: clean(raw.latestError),
          ...(raw.healthValidationDue ? { validateRequestedAt: now } : {}),
          updatedAt: now,
        },
      });

    if (
      accountStatus === "healthy" &&
      sessionStatus === "healthy" &&
      accountProxyStatus === "healthy"
    ) {
      await resolvePrivateIncident(`account_health:${id}`, `Account ${raw.label || id} is healthy.`);
    } else if (
      ["blocked", "disabled", "login_required", "error"].includes(accountStatus) ||
      ["login_required", "challenge", "expired"].includes(sessionStatus) ||
      accountProxyStatus === "failed"
    ) {
      await openPrivateIncident({
        fingerprint: `account_health:${id}`,
        kind: accountProxyStatus === "failed" ? "proxy_failed" : "account_unhealthy",
        title: `Facebook account needs help: ${raw.label || id}`,
        detail: clean(
          `${raw.latestError || raw.latestErrorCode || `${accountStatus}, ${sessionStatus}`}. Action: ${accountProxyStatus === "failed" ? "check the proxy on the VPS" : "approve or replace the Facebook session on the VPS"}.`
        ),
        targetType: "account",
        targetId: id,
        ...(workerRootFailure ? { severity: "warning" as const, notify: false } : {}),
      });
    }
  }

  if (Array.isArray(body.accounts)) {
    const stored = await db
      .select({ id: privateScraperAccounts.id })
      .from(privateScraperAccounts)
      .where(eq(privateScraperAccounts.workerId, workerId));
    for (const account of stored) {
      if (reportedAccountIds.has(account.id)) continue;
      await db
        .update(privateScraperAccounts)
        .set({
          active: 0,
          status: "stale",
          latestErrorCode: "missing_from_heartbeat",
          latestError: "This account was not included in the worker heartbeat.",
          updatedAt: now,
        })
        .where(eq(privateScraperAccounts.id, account.id));
      await openPrivateIncident({
        fingerprint: `account_health:${account.id}`,
        kind: "account_missing",
        title: `Private scraper account disappeared: ${account.id}`,
        detail: `Worker ${workerId} no longer reports this account. Action: check the worker account config and restore it.`,
        targetType: "account",
        targetId: account.id,
        ...(workerRootFailure ? { severity: "warning" as const, notify: false } : {}),
      });
    }
  }

  if (["healthy", "degraded"].includes(status)) {
    await resolvePrivateIncident(`worker_health:${workerId}`, `Worker ${workerId} is healthy.`);
  } else {
    await openPrivateIncident({
      fingerprint: `worker_health:${workerId}`,
      kind: "worker_unhealthy",
      title: `Private scraper worker needs help: ${workerId}`,
      detail: clean(`${body.message || `Worker status is ${status}.`} Action: check the VPS service and logs.`),
      targetType: "worker",
      targetId: workerId,
      ...(proxyStatus === "failed" ? { severity: "warning" as const, notify: false } : {}),
    });
  }
  if (proxyStatus === "failed") {
    await openPrivateIncident({
      fingerprint: `worker_proxy:${workerId}`,
      kind: "proxy_failed",
      title: `Private scraper proxy failed: ${workerId}`,
      detail: clean(`${body.message || "The worker reported a proxy failure."} Action: check the VPS proxy and account balance.`),
      targetType: "worker",
      targetId: workerId,
    });
  } else {
    await resolvePrivateIncident(`worker_proxy:${workerId}`, `Worker ${workerId} proxy is healthy.`);
  }

  return { ok: true, serverTimeMs: now };
}

type BudgetWatcher = {
  userId: string;
  email: string;
  plan: string;
  billingPeriodStart: number;
  billingPeriodEnd: number;
  privateBudgetPausedUntil: number;
};

async function syncStripePeriod(watcher: BudgetWatcher & { stripeCustomerId?: string }) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    watcher.billingPeriodStart > 0 &&
    watcher.billingPeriodStart <= nowSeconds &&
    watcher.billingPeriodEnd > nowSeconds
  ) {
    return watcher;
  }
  const cached = periodSyncCache.get(watcher.userId);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.watcher;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !watcher.stripeCustomerId) return watcher;

  try {
    const res = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(watcher.stripeCustomerId)}&status=all&limit=10`,
      {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(4000),
      }
    );
    if (!res.ok) return watcher;
    const payload = (await res.json()) as {
      data?: {
        status?: string;
        current_period_start?: number;
        current_period_end?: number;
        items?: {
          data?: { current_period_start?: number; current_period_end?: number }[];
        };
      }[];
    };
    const subscription = (payload.data ?? []).find(
      (row) => !LAPSED_SUBSCRIPTIONS.has(String(row.status || ""))
    );
    const item = subscription?.items?.data?.[0];
    const start = Number(subscription?.current_period_start ?? item?.current_period_start ?? 0);
    const end = Number(subscription?.current_period_end ?? item?.current_period_end ?? 0);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end <= start) {
      return watcher;
    }
    await getDb()
      .update(profiles)
      .set({ billingPeriodStart: start, billingPeriodEnd: end })
      .where(eq(profiles.userId, watcher.userId));
    const hydrated = { ...watcher, billingPeriodStart: start, billingPeriodEnd: end };
    periodSyncCache.set(watcher.userId, { at: Date.now(), watcher: hydrated });
    return hydrated;
  } catch {
    periodSyncCache.set(watcher.userId, { at: Date.now(), watcher });
    return watcher;
  }
}

async function sourceWatchers(sourceId: number): Promise<BudgetWatcher[]> {
  const rows = await getDb()
    .select({
      userId: groups.userId,
      email: users.email,
      plan: profiles.plan,
      stripeCustomerId: profiles.stripeCustomerId,
      subscriptionStatus: profiles.subscriptionStatus,
      billingPeriodStart: profiles.billingPeriodStart,
      billingPeriodEnd: profiles.billingPeriodEnd,
      privateBudgetPausedUntil: profiles.privateBudgetPausedUntil,
    })
    .from(groups)
    .innerJoin(profiles, eq(profiles.userId, groups.userId))
    .innerJoin(users, eq(users.id, groups.userId))
    .where(
      and(
        eq(groups.sourceId, sourceId),
        inArray(groups.status, REQUESTED_GROUP_STATUSES)
      )
    )
    .orderBy(asc(groups.id));

  const unique = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (LAPSED_SUBSCRIPTIONS.has(row.subscriptionStatus)) continue;
    if (!unique.has(row.userId)) unique.set(row.userId, row);
  }
  const hydrated: BudgetWatcher[] = [];
  for (const row of unique.values()) hydrated.push(await syncStripePeriod(row));
  return hydrated;
}

async function warmPrivateBillingPeriods() {
  const rows = await getDb()
    .select({
      userId: profiles.userId,
      email: users.email,
      plan: profiles.plan,
      stripeCustomerId: profiles.stripeCustomerId,
      subscriptionStatus: profiles.subscriptionStatus,
      billingPeriodStart: profiles.billingPeriodStart,
      billingPeriodEnd: profiles.billingPeriodEnd,
      privateBudgetPausedUntil: profiles.privateBudgetPausedUntil,
    })
    .from(groups)
    .innerJoin(sources, eq(sources.id, groups.sourceId))
    .innerJoin(profiles, eq(profiles.userId, groups.userId))
    .innerJoin(users, eq(users.id, groups.userId))
    .where(
      and(
        eq(sources.visibility, "private"),
        inArray(groups.status, REQUESTED_GROUP_STATUSES)
      )
    );
  const now = Math.floor(Date.now() / 1000);
  const unique = new Map(rows.map((row) => [row.userId, row]));
  await Promise.all(
    [...unique.values()]
      .filter(
        (row) =>
          !LAPSED_SUBSCRIPTIONS.has(row.subscriptionStatus) &&
          row.stripeCustomerId &&
          !(row.billingPeriodStart <= now && row.billingPeriodEnd > now)
      )
      .map((row) => syncStripePeriod(row))
  );
}

function splitExact(total: number, userIds: string[]) {
  const ids = [...userIds].sort();
  const base = Math.floor(total / ids.length);
  const remainder = total % ids.length;
  return new Map(ids.map((id, index) => [id, base + (index < remainder ? 1 : 0)]));
}

async function currentPrivateSpend(watcher: BudgetWatcher) {
  const [row] = (await getDb()
    .select({
      actual: sql<number>`coalesce(sum(${privateCostAllocations.actualAudMicros}), 0)`,
      reserved: sql<number>`coalesce(sum(${privateCostAllocations.reservedAudMicros}), 0)`,
    })
    .from(privateCostAllocations)
    .where(
      and(
        eq(privateCostAllocations.userId, watcher.userId),
        eq(privateCostAllocations.periodStart, watcher.billingPeriodStart),
        eq(privateCostAllocations.periodEnd, watcher.billingPeriodEnd),
        ne(privateCostAllocations.status, "released")
      )
    )) as { actual: number; reserved: number }[];
  const actual = Number(row?.actual ?? 0);
  const reserved = Number(row?.reserved ?? 0);
  return { actual, reserved, total: actual + reserved };
}

function forecastPrivateSpend(
  spend: { actual: number; reserved: number },
  watcher: BudgetWatcher,
  nowSeconds: number
) {
  const elapsed = Math.max(1, nowSeconds - watcher.billingPeriodStart);
  const duration = Math.max(elapsed, watcher.billingPeriodEnd - watcher.billingPeriodStart);
  return Math.max(
    spend.actual + spend.reserved,
    Math.ceil(spend.actual * duration / elapsed) + spend.reserved
  );
}

async function privateSourceIds() {
  return (await getDb()
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.visibility, "private")))
    .map((row) => row.id);
}

async function pauseUserForBudget(watcher: BudgetWatcher, detail: string) {
  const ids = await privateSourceIds();
  if (ids.length) {
    await getDb()
      .update(groups)
      .set({ status: "budget_paused_private" })
      .where(
        and(
          eq(groups.userId, watcher.userId),
          inArray(groups.sourceId, ids),
          inArray(groups.status, REQUESTED_GROUP_STATUSES)
        )
      );
  }
  await getDb()
    .update(profiles)
    .set({
      privateBudgetStatus: watcher.billingPeriodEnd ? "paused" : "cycle_unknown",
      privateBudgetPausedUntil: watcher.billingPeriodEnd,
    })
    .where(eq(profiles.userId, watcher.userId));
  await openPrivateIncident({
    fingerprint: `private_budget:${watcher.userId}`,
    kind: "private_budget_paused",
    title: `Private scraping budget paused for ${watcher.email}`,
    detail: `${detail} Action: review the private cost ledger before the next Stripe cycle.`,
    targetType: "customer",
    targetId: watcher.userId,
  });
}

async function reserveCheckCost(
  runId: string,
  sourceId: number,
  estimateAudMicros: number,
  watchers: BudgetWatcher[]
) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  let eligible = [...watchers];

  // Removing one member changes every remaining exact share, so recalculate
  // until each reserved share fits under its own safety cutoff.
  while (eligible.length) {
    const shares = splitExact(estimateAudMicros, eligible.map((row) => row.userId));
    let removed = false;
    for (const watcher of [...eligible]) {
      const validCycle =
        watcher.billingPeriodStart > 0 &&
        watcher.billingPeriodStart <= nowSeconds &&
        watcher.billingPeriodEnd > nowSeconds;
      const share = shares.get(watcher.userId) ?? 0;
      const spend = validCycle
        ? await currentPrivateSpend(watcher)
        : { actual: 0, reserved: 0, total: 0 };
      const hardBudget = privateScrapingBudgetAudMicros(watcher.plan);
      const safetyCutoff = privateScrapingSafetyCutoffAudMicros(watcher.plan);
      if (
        !validCycle ||
        watcher.privateBudgetPausedUntil > nowSeconds ||
        spend.total + share > safetyCutoff
      ) {
        const reason = !validCycle
          ? "Stripe billing cycle is not available. No paid private check was started."
          : `The next reserved share would pass the ${safetyCutoff} AUD-micro safety cutoff. The absolute hard limit is ${hardBudget} AUD micros.`;
        await pauseUserForBudget(watcher, reason);
        eligible = eligible.filter((row) => row.userId !== watcher.userId);
        removed = true;
        continue;
      }

      const warningAt = privateScrapingWarningAudMicros(watcher.plan);
      const projected = forecastPrivateSpend(
        { actual: spend.actual, reserved: spend.reserved + share },
        watcher,
        nowSeconds
      );
      if (spend.total + share >= warningAt || projected >= warningAt) {
        await getDb()
          .update(profiles)
          .set({ privateBudgetStatus: "at_risk" })
          .where(and(eq(profiles.userId, watcher.userId), eq(profiles.privateBudgetStatus, "ready")));
        await openPrivateIncident({
          fingerprint: `private_budget_warning:${watcher.userId}`,
          kind: "private_budget_warning",
          title: `Private scraping budget is getting high for ${watcher.email}`,
          detail: `Reserved plus actual spend would be ${spend.total + share} AUD micros. Forecast is ${projected}. Action: review private costs before dispatch stops at ${safetyCutoff}.`,
          targetType: "customer",
          targetId: watcher.userId,
        });
      }
    }
    if (!removed) break;
  }

  if (!eligible.length) return [];
  const now = Date.now();
  const shares = splitExact(estimateAudMicros, eligible.map((row) => row.userId));
  for (const watcher of eligible) {
    await getDb().insert(privateCostAllocations).values({
      id: `${runId}:${watcher.userId}`,
      runId,
      userId: watcher.userId,
      sourceId,
      periodStart: watcher.billingPeriodStart,
      periodEnd: watcher.billingPeriodEnd,
      reservedAudMicros: shares.get(watcher.userId) ?? 0,
      createdAt: now,
      updatedAt: now,
    });
  }
  return eligible;
}

async function cancelAllocatingRun(runId: string, errorCode: string) {
  const db = getDb();
  await db
    .update(privateCostAllocations)
    .set({ status: "released", reservedAudMicros: 0, updatedAt: Date.now() })
    .where(eq(privateCostAllocations.runId, runId));
  await db
    .update(privateScrapeChecks)
    .set({ status: "cancelled", errorCode })
    .where(eq(privateScrapeChecks.runId, runId));
}

async function accountWatchers(accountId: string) {
  const states = await getDb()
    .select({ sourceId: privateGroupStates.sourceId })
    .from(privateGroupStates)
    .where(eq(privateGroupStates.accountId, accountId));
  const unique = new Map<string, BudgetWatcher>();
  for (const state of states) {
    for (const watcher of await sourceWatchers(state.sourceId)) {
      if (!unique.has(watcher.userId)) unique.set(watcher.userId, watcher);
    }
  }
  return [...unique.values()];
}

/** Existing or downgraded accounts can be over 40%. Keep the oldest slots. */
export async function enforcePrivatePlanLimits() {
  const db = getDb();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const members = await db
    .select({
      userId: profiles.userId,
      email: users.email,
      plan: profiles.plan,
      subscriptionStatus: profiles.subscriptionStatus,
      budgetStatus: profiles.privateBudgetStatus,
      budgetPausedUntil: profiles.privateBudgetPausedUntil,
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId));

  for (const member of members) {
    const rows = await db
      .select({
        id: groups.id,
        status: groups.status,
        sourceId: groups.sourceId,
        sourceActive: sources.active,
        accessStatus: privateGroupStates.status,
      })
      .from(groups)
      .innerJoin(sources, eq(sources.id, groups.sourceId))
      .leftJoin(privateGroupStates, eq(privateGroupStates.sourceId, groups.sourceId))
      .where(
        and(eq(groups.userId, member.userId), eq(sources.visibility, "private"))
      )
      .orderBy(asc(groups.id));
    const limit = privateGroupLimit(member.plan);
    const allowed = rows.slice(0, limit);
    const extra = rows.slice(limit);

    for (const row of allowed) {
      if (row.status !== "plan_limit_private") continue;
      const paymentPaused = LAPSED_SUBSCRIPTIONS.has(member.subscriptionStatus);
      const budgetPaused =
        ["paused", "health_wait", "cycle_unknown"].includes(member.budgetStatus) ||
        member.budgetPausedUntil > nowSeconds;
      const status = paymentPaused
        ? "paused_private_payment"
        : budgetPaused
          ? "budget_paused_private"
          : !row.sourceActive
            ? "paused_private"
            : row.accessStatus === "healthy"
              ? "watching"
              : "waiting_for_access";
      await db
        .update(groups)
        .set({ status })
        .where(eq(groups.id, row.id));
    }
    for (const row of extra) {
      if (!["watching", "waiting_for_access"].includes(row.status)) continue;
      await db
        .update(groups)
        .set({ status: "plan_limit_private" })
        .where(eq(groups.id, row.id));
    }

    if (extra.length) {
      await openPrivateIncident({
        fingerprint: `private_plan_limit:${member.userId}`,
        kind: "private_plan_limit",
        title: `Private group limit reached for ${member.email}`,
        detail: `${rows.length} private groups are saved. The plan allows ${limit}. The oldest ${limit} stay eligible. Extra groups are not scraped.`,
        severity: "warning",
        targetType: "customer",
        targetId: member.userId,
      });
    } else {
      await resolvePrivateIncident(
        `private_plan_limit:${member.userId}`,
        `${member.email} is now within the private group limit.`
      );
    }
  }
}

export type PrivateJob =
  | {
      kind: "scan_group";
      runId: string;
      sourceId: number;
      url: string;
      groupName: string;
      accountId: string;
      maxCostAudMicros: number;
      deadlineAtMs: number;
      lookbackMinutes: number;
    }
  | {
      kind: "validate_session";
      runId: string;
      accountId: string;
      maxCostAudMicros: number;
      deadlineAtMs: number;
    };

function checkToJob(
  check: typeof privateScrapeChecks.$inferSelect,
  source?: { id: number; url: string; groupName: string }
): PrivateJob | null {
  if (check.kind === "validate_session") {
    return {
      kind: "validate_session",
      runId: check.runId,
      accountId: check.accountId,
      maxCostAudMicros: check.reservedAudMicros,
      deadlineAtMs: check.deadlineAt,
    };
  }
  if (!source) return null;
  return {
    kind: "scan_group",
    runId: check.runId,
    sourceId: source.id,
    url: source.url,
    groupName: source.groupName,
    accountId: check.accountId,
    maxCostAudMicros: check.reservedAudMicros,
    deadlineAtMs: check.deadlineAt,
    lookbackMinutes: PRIVATE_LOOKBACK_MINUTES,
  };
}

async function privateJobsForWorkerUnlocked(workerIdInput: string) {
  const workerId = clean(workerIdInput, 100);
  if (!workerId) throw new Error("bad_worker_id");
  await sweepPrivateMonitoringHealth();
  await enforcePrivatePlanLimits();
  await warmPrivateBillingPeriods();

  const db = getDb();
  const now = Date.now();
  const [worker] = await db
    .select()
    .from(privateScraperWorkers)
    .where(eq(privateScraperWorkers.id, workerId))
    .limit(1);
  if (!worker || now - worker.lastHeartbeatAt > HEARTBEAT_STALE_MS) {
    return { jobs: [] as PrivateJob[], reason: "worker_not_healthy" };
  }
  if (
    !["healthy", "degraded"].includes(worker.status) ||
    !["healthy", "degraded"].includes(worker.proxyStatus)
  ) {
    return { jobs: [] as PrivateJob[], reason: "worker_not_healthy" };
  }
  const estimate = worker.estimatedMaxCostAudMicros;
  if (!estimate) {
    await openPrivateIncident({
      fingerprint: `cost_guard_missing:${workerId}`,
      kind: "cost_guard_missing",
      title: `Private scraper cost guard is missing: ${workerId}`,
      detail: "The worker did not report a measured maximum AUD cost. No paid job was started.",
      targetType: "worker",
      targetId: workerId,
    });
    return { jobs: [] as PrivateJob[], reason: "cost_guard_missing" };
  }
  await resolvePrivateIncident(
    `cost_guard_missing:${workerId}`,
    `Worker ${workerId} has a measured cost guard.`
  );

  const allAccounts = await db
    .select()
    .from(privateScraperAccounts)
    .where(
      and(
        eq(privateScraperAccounts.workerId, workerId),
        eq(privateScraperAccounts.active, 1)
      )
    )
    .orderBy(asc(privateScraperAccounts.id));
  const accounts = allAccounts.filter(
    (account) =>
      account.status === "healthy" &&
      account.sessionStatus === "healthy" &&
      account.proxyStatus === "healthy" &&
      now - account.lastHeartbeatAt <= HEARTBEAT_STALE_MS
  );

  const existing = await db
    .select()
    .from(privateScrapeChecks)
    .where(
      and(
        eq(privateScrapeChecks.workerId, workerId),
        eq(privateScrapeChecks.status, "reserved"),
        sql`${privateScrapeChecks.deadlineAt} > ${now}`
      )
    )
    .orderBy(asc(privateScrapeChecks.createdAt))
    .limit(MAX_JOBS_PER_POLL);
  const existingJobs: PrivateJob[] = [];
  for (const check of existing) {
    const account = allAccounts.find((row) => row.id === check.accountId);
    if (!account || now - account.lastHeartbeatAt > HEARTBEAT_STALE_MS) continue;
    if (check.kind === "scan_group" && !accounts.some((row) => row.id === check.accountId)) {
      continue;
    }
    const [source] = check.sourceId
      ? await db
          .select({
            id: sources.id,
            url: sources.url,
            groupName: sources.groupName,
            active: sources.active,
            visibility: sources.visibility,
          })
          .from(sources)
          .where(eq(sources.id, check.sourceId))
          .limit(1)
      : [];
    if (
      check.kind === "scan_group" &&
      (!source || source.active !== 1 || source.visibility !== "private")
    ) {
      await cancelAllocatingRun(check.runId, "source_not_private");
      continue;
    }
    const job = checkToJob(check, source);
    if (job) existingJobs.push(job);
  }
  if (existingJobs.length >= MAX_JOBS_PER_POLL) {
    return { jobs: existingJobs, reason: "" };
  }
  if (!allAccounts.length) return { jobs: existingJobs, reason: "no_account" };

  const created: PrivateJob[] = [];
  for (const account of allAccounts) {
    if (existingJobs.length + created.length >= MAX_JOBS_PER_POLL) break;
    if (account.validateRequestedAt <= account.lastHealthCheckAt) continue;
    const open = await db
      .select({ runId: privateScrapeChecks.runId })
      .from(privateScrapeChecks)
      .where(
        and(
          eq(privateScrapeChecks.kind, "validate_session"),
          eq(privateScrapeChecks.accountId, account.id),
          inArray(privateScrapeChecks.status, ["allocating", "reserved", "processing"])
        )
      )
      .limit(1);
    if (open.length) continue;
    const runId = crypto.randomUUID();
    const watchers = await accountWatchers(account.id);
    await db.insert(privateScrapeChecks).values({
      runId,
      kind: "validate_session",
      accountId: account.id,
      workerId,
      status: "allocating",
      createdAt: now,
      deadlineAt: now + JOB_DEADLINE_MS,
      reservedAudMicros: estimate,
    });
    try {
      if (!watchers.length) {
        await cancelAllocatingRun(runId, "no_active_watchers");
        continue;
      }
      const eligible = await reserveCheckCost(runId, 0, estimate, watchers);
      if (!eligible.length) {
        await cancelAllocatingRun(runId, "budget_unavailable");
        continue;
      }
      await db
        .update(privateScrapeChecks)
        .set({ status: "reserved" })
        .where(and(eq(privateScrapeChecks.runId, runId), eq(privateScrapeChecks.status, "allocating")));
    } catch (err) {
      await cancelAllocatingRun(runId, "reservation_failed");
      throw err;
    }
    const [check] = await db
      .select()
      .from(privateScrapeChecks)
      .where(eq(privateScrapeChecks.runId, runId));
    const job = check ? checkToJob(check) : null;
    if (job) created.push(job);
  }

  const assignedCounts = new Map<string, number>();
  const states = await db.select().from(privateGroupStates);
  for (const state of states) {
    assignedCounts.set(state.accountId, (assignedCounts.get(state.accountId) ?? 0) + 1);
  }
  const dueSources = await db
    .select()
    .from(sources)
    .where(and(eq(sources.active, 1), eq(sources.visibility, "private")))
    .orderBy(asc(sources.lastChecked));

  for (const source of dueSources) {
    if (existingJobs.length + created.length >= MAX_JOBS_PER_POLL) break;
    const watchers = await sourceWatchers(source.id);
    if (!watchers.length) continue;
    const [open] = await db
      .select({ runId: privateScrapeChecks.runId })
      .from(privateScrapeChecks)
      .where(
        and(
          eq(privateScrapeChecks.sourceId, source.id),
          inArray(privateScrapeChecks.status, ["allocating", "reserved", "processing"]),
          sql`${privateScrapeChecks.deadlineAt} > ${now}`
        )
      )
      .limit(1);
    if (open) continue;

    let [state] = await db
      .select()
      .from(privateGroupStates)
      .where(eq(privateGroupStates.sourceId, source.id))
      .limit(1);
    if (!state) {
      const account = [...accounts].sort(
        (a, b) =>
          (assignedCounts.get(a.id) ?? 0) - (assignedCounts.get(b.id) ?? 0) ||
          a.id.localeCompare(b.id)
      )[0];
      if (!account) continue;
      await db.insert(privateGroupStates).values({
        sourceId: source.id,
        accountId: account.id,
        status: "waiting_for_access",
        nextCheckAt: now,
        updatedAt: now,
      });
      assignedCounts.set(account.id, (assignedCounts.get(account.id) ?? 0) + 1);
      [state] = await db
        .select()
        .from(privateGroupStates)
        .where(eq(privateGroupStates.sourceId, source.id))
        .limit(1);
    }
    if (!state || state.nextCheckAt > now && state.retryRequestedAt <= state.lastCheckAt) continue;
    const account = accounts.find((row) => row.id === state.accountId);
    if (!account) continue;
    if (account.validateRequestedAt > account.lastHealthCheckAt) continue;

    const runId = crypto.randomUUID();
    await db.insert(privateScrapeChecks).values({
      runId,
      sourceId: source.id,
      accountId: account.id,
      workerId,
      status: "allocating",
      createdAt: now,
      deadlineAt: now + JOB_DEADLINE_MS,
      reservedAudMicros: estimate,
    });
    try {
      const eligible = await reserveCheckCost(runId, source.id, estimate, watchers);
      if (!eligible.length) {
        await cancelAllocatingRun(runId, "budget_unavailable");
        continue;
      }
      await db
        .update(privateScrapeChecks)
        .set({ status: "reserved" })
        .where(and(eq(privateScrapeChecks.runId, runId), eq(privateScrapeChecks.status, "allocating")));
    } catch (err) {
      await cancelAllocatingRun(runId, "reservation_failed");
      throw err;
    }
    const [check] = await db
      .select()
      .from(privateScrapeChecks)
      .where(eq(privateScrapeChecks.runId, runId));
    const job = check ? checkToJob(check, source) : null;
    if (job) created.push(job);
  }

  return { jobs: [...existingJobs, ...created], reason: "" };
}

/** The lease makes spend read plus reservation atomic across worker polls. */
export async function privateJobsForWorker(workerId: string) {
  const db = getDb();
  const owner = crypto.randomUUID();
  const now = Date.now();
  await db
    .insert(privateDispatchLock)
    .values({ id: 1, owner: "", lockedUntil: 0 })
    .onConflictDoNothing();
  const [lease] = await db
    .update(privateDispatchLock)
    .set({ owner, lockedUntil: now + 5 * 60_000 })
    .where(and(eq(privateDispatchLock.id, 1), lte(privateDispatchLock.lockedUntil, now)))
    .returning({ owner: privateDispatchLock.owner });
  if (lease?.owner !== owner) return { jobs: [] as PrivateJob[], reason: "dispatch_busy" };

  try {
    return await privateJobsForWorkerUnlocked(workerId);
  } finally {
    await db
      .update(privateDispatchLock)
      .set({ owner: "", lockedUntil: 0 })
      .where(and(eq(privateDispatchLock.id, 1), eq(privateDispatchLock.owner, owner)));
  }
}

export type PrivateResultInput = {
  runId?: string;
  workerId?: string;
  sourceId?: number;
  accountId?: string;
  status?: "success" | "failed";
  startedAtMs?: number;
  finishedAtMs?: number;
  chronologicalVerified?: boolean;
  boundaryReached?: boolean;
  feedEndReached?: boolean;
  posts?: {
    id?: string;
    text?: string;
    url?: string;
    author?: string;
    postedAt?: string;
  }[];
  bytesTransferred?: number;
  proxyCost?: { amountMicros?: number; currency?: string; audRateMicros?: number };
  vpsCostAudMicros?: number;
  sessionRefreshedAtMs?: number;
  sessionExpiresAtMs?: number;
  accountStatus?: string;
  sessionStatus?: string;
  proxyStatus?: string;
  groupStatus?: string;
  errorCode?: string;
  errorMessage?: string;
  bandwidthTargetExceeded?: boolean;
  bandwidthTargetBytes?: number;
  ignoredPinnedPosts?: number;
  normalPostsInspected?: number;
  costAttempted?: boolean;
};

function audFromSupplierCost(cost: NonNullable<PrivateResultInput["proxyCost"]>) {
  const amount = integer(cost.amountMicros);
  const currency = clean(cost.currency, 3).toUpperCase();
  const rate = integer(cost.audRateMicros, 100_000_000);
  if (amount == null || !["AUD", "USD"].includes(currency)) return null;
  const appliedRate = currency === "AUD" ? 1_000_000 : rate;
  if (!appliedRate) return null;
  // Always round supplier conversion up so the budget guard is conservative.
  const numerator = BigInt(amount) * BigInt(appliedRate) + BigInt(999_999);
  const value = Number(numerator / BigInt(1_000_000));
  return Number.isSafeInteger(value) ? { audMicros: value, amount, currency, rate: appliedRate } : null;
}

function validFacebookPostUrl(url: string, expectedSourceUrl: string) {
  try {
    const parsed = new URL(url);
    if (!/^(?:www\.|m\.)?facebook\.com$/i.test(parsed.hostname)) return false;
    if (!/^\/groups\/[^/?#]+\/(?:posts|permalink)\/[A-Za-z0-9_-]+\/?$/i.test(parsed.pathname)) {
      return false;
    }
    return groupSlug(url) === groupSlug(expectedSourceUrl);
  } catch {
    return false;
  }
}

function validatedPosts(
  raw: PrivateResultInput["posts"],
  windowAnchor: number,
  expectedSourceUrl: string
): { posts: FetchedPost[]; error: string } {
  if (!Array.isArray(raw) || raw.length > MAX_POSTS_PER_RESULT) {
    return { posts: [], error: "bad_posts" };
  }
  const minimum = windowAnchor - (PRIVATE_LOOKBACK_MINUTES + 2) * 60 * 1000;
  const maximum = Date.now() + 2 * 60 * 1000;
  const posts: FetchedPost[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    const id = clean(item.id, 190);
    const text = clean(item.text, 4000);
    const url = clean(item.url, 700);
    const author = clean(item.author, 160);
    const postedAt = clean(item.postedAt, 80);
    const postedMs = Date.parse(postedAt);
    if (
      !id ||
      ids.has(id) ||
      text.length <= 10 ||
      !validFacebookPostUrl(url, expectedSourceUrl) ||
      !Number.isFinite(postedMs) ||
      postedMs < minimum ||
      postedMs > maximum
    ) {
      return { posts: [], error: "post_outside_verified_window" };
    }
    ids.add(id);
    posts.push({ id, text, url, author, postedAt: new Date(postedMs).toISOString() });
  }
  return { posts, error: "" };
}

async function finishCost(
  check: typeof privateScrapeChecks.$inferSelect,
  input: PrivateResultInput
) {
  const db = getDb();
  const proxy = input.proxyCost ? audFromSupplierCost(input.proxyCost) : null;
  const vps = input.vpsCostAudMicros === undefined ? null : integer(input.vpsCostAudMicros);
  const measured = Boolean(proxy && vps != null);
  const actual = measured ? proxy!.audMicros + vps! : 0;
  const allocations = await db
    .select()
    .from(privateCostAllocations)
    .where(eq(privateCostAllocations.runId, check.runId))
    .orderBy(asc(privateCostAllocations.userId));

  if (!measured) {
    for (const allocation of allocations) {
      await db
        .update(privateCostAllocations)
        .set({ status: "unreconciled", updatedAt: Date.now() })
        .where(eq(privateCostAllocations.id, allocation.id));
    }
    return { measured: false, actual: 0, proxy: null, vps: 0, overReservation: false };
  }

  const shares = splitExact(actual, allocations.map((row) => row.userId));
  for (const allocation of allocations) {
    await db
      .update(privateCostAllocations)
      .set({
        reservedAudMicros: 0,
        actualAudMicros: shares.get(allocation.userId) ?? 0,
        status: "actual",
        updatedAt: Date.now(),
      })
      .where(eq(privateCostAllocations.id, allocation.id));
  }

  for (const allocation of allocations) {
    const [row] = await db
      .select({
        userId: profiles.userId,
        email: users.email,
        plan: profiles.plan,
        billingPeriodStart: profiles.billingPeriodStart,
        billingPeriodEnd: profiles.billingPeriodEnd,
        privateBudgetPausedUntil: profiles.privateBudgetPausedUntil,
      })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(eq(profiles.userId, allocation.userId))
      .limit(1);
    if (!row) continue;
    const spend = await currentPrivateSpend(row);
    const hardBudget = privateScrapingBudgetAudMicros(row.plan);
    const safetyCutoff = privateScrapingSafetyCutoffAudMicros(row.plan);
    if (spend.total >= hardBudget) {
      await pauseUserForBudget(
        row,
        `Measured spend is ${spend.total} AUD micros and passed the ${hardBudget} AUD-micro absolute limit. No more private jobs will start.`
      );
    } else if (spend.total >= privateScrapingWarningAudMicros(row.plan)) {
      await db
        .update(profiles)
        .set({ privateBudgetStatus: "at_risk" })
        .where(and(eq(profiles.userId, row.userId), eq(profiles.privateBudgetStatus, "ready")));
      await openPrivateIncident({
        fingerprint: `private_budget_warning:${row.userId}`,
        kind: "private_budget_warning",
        title: `Private scraping budget is getting high for ${row.email}`,
        detail: `Measured spend is ${spend.total} AUD micros. Action: review private costs before dispatch stops at ${safetyCutoff}.`,
        targetType: "customer",
        targetId: row.userId,
      });
    }
  }

  return {
    measured: true,
    actual,
    proxy,
    vps: vps!,
    overReservation: actual > check.reservedAudMicros,
  };
}

function groupFailureStatus(code: string, supplied: string, wasHealthy: boolean) {
  const normalCode = stateValue(code, "");
  const normalStatus = stateValue(supplied, "");
  if (normalStatus === "waiting_for_access") {
    return wasHealthy ? "access_lost" : "waiting_for_access";
  }
  if (
    ["access_lost", "not_a_member", "group_access_lost"].includes(normalCode) ||
    normalStatus === "access_lost"
  ) {
    return "access_lost";
  }
  if (normalCode === "group_deleted" || normalStatus === "deleted") return "deleted";
  if (normalCode === "group_unavailable" || normalStatus === "unavailable") return "unavailable";
  return "error";
}

export async function savePrivateResult(input: PrivateResultInput) {
  const runId = clean(input.runId, 100);
  if (!runId) throw new Error("bad_run_id");
  const db = getDb();
  const [check] = await db
    .select()
    .from(privateScrapeChecks)
    .where(eq(privateScrapeChecks.runId, runId))
    .limit(1);
  if (!check) throw new Error("unknown_run");
  if (["success", "failed", "cancelled"].includes(check.status)) {
    return { ok: true, duplicate: true, status: check.status };
  }
  if (check.status === "processing") {
    return { ok: true, duplicate: true, processing: true, status: check.status };
  }
  if (
    clean(input.workerId, 100) !== check.workerId ||
    clean(input.accountId, 100) !== check.accountId ||
    (check.kind === "scan_group" && integer(input.sourceId) !== check.sourceId)
  ) {
    throw new Error("run_mismatch");
  }
  const [claimed] = await db
    .update(privateScrapeChecks)
    .set({ status: "processing", deadlineAt: Date.now() + JOB_DEADLINE_MS })
    .where(
      and(
        eq(privateScrapeChecks.runId, runId),
        inArray(privateScrapeChecks.status, ["reserved", "expired"])
      )
    )
    .returning({ runId: privateScrapeChecks.runId });
  if (!claimed) return { ok: true, duplicate: true, processing: true, status: "processing" };

  const startedAt = integer(input.startedAtMs) ?? check.createdAt;
  const finishedAt = integer(input.finishedAtMs) ?? Date.now();
  const bytes = integer(input.bytesTransferred) ?? 0;
  let errorCode = stateValue(input.errorCode, "");
  let errorDetail = clean(input.errorMessage);
  let successful = input.status === "success";
  let posts: FetchedPost[] = [];
  const [sourceForScan] = check.kind === "scan_group"
    ? await db
        .select({
          id: sources.id,
          url: sources.url,
          groupName: sources.groupName,
          visibility: sources.visibility,
        })
        .from(sources)
        .where(eq(sources.id, check.sourceId))
        .limit(1)
    : [];

  if (
    finishedAt < startedAt ||
    startedAt < check.createdAt - 2 * 60 * 1000 ||
    finishedAt > Date.now() + 2 * 60 * 1000 ||
    finishedAt > check.deadlineAt + 2 * 60 * 1000
  ) {
    successful = false;
    errorCode = "bad_result_time";
  }

  if (check.kind === "scan_group" && successful) {
    if (!sourceForScan || sourceForScan.visibility !== "private") {
      successful = false;
      errorCode = "source_not_private";
    } else if (!input.chronologicalVerified) {
      successful = false;
      errorCode = "chronological_unverified";
    } else if (!input.boundaryReached && !input.feedEndReached) {
      successful = false;
      errorCode = "cutoff_unverified";
    } else {
      const validated = validatedPosts(input.posts, startedAt, sourceForScan.url);
      posts = validated.posts;
      if (validated.error) {
        successful = false;
        errorCode = validated.error;
      }
    }
  }

  const cost = await finishCost(check, input);
  if (!cost.measured) {
    successful = false;
    errorCode ||= "cost_measurement_missing";
    errorDetail ||= "Exact proxy and VPS costs were not both reported. The reservation remains held.";
  } else if (cost.overReservation) {
    successful = false;
    errorCode = "cost_reservation_exceeded";
    errorDetail = `Measured cost ${cost.actual} exceeded reservation ${check.reservedAudMicros} AUD micros.`;
    await openPrivateIncident({
      fingerprint: `cost_reservation:${check.workerId}`,
      kind: "cost_reservation_exceeded",
      title: `Private scraper cost guard failed: ${check.workerId}`,
      detail: errorDetail,
      targetType: "worker",
      targetId: check.workerId,
    });
  }

  let postsCollected = 0;
  let pipelineError = "";
  const [previousState] = check.sourceId
    ? await db
        .select()
        .from(privateGroupStates)
        .where(eq(privateGroupStates.sourceId, check.sourceId))
        .limit(1)
    : [];

  if (check.kind === "scan_group" && successful) {
    if (!sourceForScan || sourceForScan.visibility !== "private") {
      successful = false;
      errorCode = "source_not_private";
    } else {
      // Access is now proven. Promote only the pending access rows. Budget,
      // payment, plan and manual pauses remain untouched.
      await db
        .update(groups)
        .set({ status: "watching" })
        .where(
          and(
            eq(groups.sourceId, check.sourceId),
            eq(groups.status, "waiting_for_access")
          )
        );
      const summary = await processSource(check.sourceId, posts);
      postsCollected = posts.length;
      pipelineError = "error" in summary ? clean(summary.error, 200) : "";
      if (pipelineError) {
        successful = false;
        errorCode = "ingestion_failed";
        errorDetail = pipelineError;
      }
    }
  }

  const finalStatus = successful ? "success" : "failed";
  await db
    .update(privateScrapeChecks)
    .set({
      status: finalStatus,
      startedAt,
      finishedAt,
      actualAudMicros: cost.actual,
      proxyAmountMicros: cost.proxy?.amount ?? 0,
      proxyCurrency: cost.proxy?.currency ?? "AUD",
      audRateMicros: cost.proxy?.rate ?? 1_000_000,
      proxyCostAudMicros: cost.proxy?.audMicros ?? 0,
      vpsCostAudMicros: cost.vps,
      bytesTransferred: bytes,
      postsCollected,
      chronologicalVerified: input.chronologicalVerified ? 1 : 0,
      boundaryReached: input.boundaryReached ? 1 : 0,
      feedEndReached: input.feedEndReached ? 1 : 0,
      errorCode,
      errorDetail,
    })
    .where(eq(privateScrapeChecks.runId, runId));

  const accountPatch = {
    lastScanAt: check.kind === "scan_group" ? finishedAt : undefined,
    lastHealthCheckAt: check.kind === "validate_session" ? finishedAt : undefined,
    cookieSavedAt: integer(input.sessionRefreshedAtMs) ?? undefined,
    sessionExpiresAt: integer(input.sessionExpiresAtMs) ?? undefined,
    status: input.accountStatus ? stateValue(input.accountStatus) : undefined,
    sessionStatus: input.sessionStatus ? stateValue(input.sessionStatus) : undefined,
    proxyStatus: input.proxyStatus ? stateValue(input.proxyStatus) : undefined,
    consecutiveFailures: successful ? 0 : sql`${privateScraperAccounts.consecutiveFailures} + 1`,
    latestErrorCode: successful ? "" : errorCode,
    latestError: successful ? "" : errorDetail,
    updatedAt: Date.now(),
  };
  await db
    .update(privateScraperAccounts)
    .set(accountPatch)
    .where(eq(privateScraperAccounts.id, check.accountId));

  const reportedAccountStatus = stateValue(input.accountStatus, "");
  const reportedSessionStatus = stateValue(input.sessionStatus, "");
  const reportedProxyStatus = stateValue(input.proxyStatus, "");
  const accountRootFailure =
    ["blocked", "disabled", "login_required", "error"].includes(reportedAccountStatus) ||
    ["login_required", "challenge", "expired"].includes(reportedSessionStatus) ||
    reportedProxyStatus === "failed";
  if (accountRootFailure) {
    await openPrivateIncident({
      fingerprint: `account_health:${check.accountId}`,
      kind: reportedProxyStatus === "failed" ? "proxy_failed" : "account_unhealthy",
      title: `Facebook account needs help: ${check.accountId}`,
      detail: `${errorDetail || errorCode || "The worker reported an unhealthy account."} Action: ${reportedProxyStatus === "failed" ? "check the proxy on the VPS" : "approve or replace the Facebook session on the VPS"}.`,
      targetType: "account",
      targetId: check.accountId,
    });
  } else if (
    reportedAccountStatus === "healthy" &&
    reportedSessionStatus === "healthy" &&
    reportedProxyStatus === "healthy"
  ) {
    await resolvePrivateIncident(
      `account_health:${check.accountId}`,
      `Account ${check.accountId} passed a live health report.`
    );
  }

  if (check.kind === "validate_session") {
    if (successful) {
      await resolvePrivateIncident(
        `account_health:${check.accountId}`,
        `Session validation passed for ${check.accountId}.`
      );
    } else {
      await openPrivateIncident({
        fingerprint: `account_health:${check.accountId}`,
        kind: errorCode || "session_validation_failed",
        title: `Facebook session validation failed: ${check.accountId}`,
        detail: `${errorDetail || errorCode}. Action: approve or replace the Facebook session on the VPS.`,
        targetType: "account",
        targetId: check.accountId,
      });
    }
  }

  if (check.kind === "scan_group") {
    const failureStatus = groupFailureStatus(
      errorCode,
      stateValue(input.groupStatus, ""),
      (previousState?.lastSuccessAt ?? 0) > 0
    );
    const nextCheckAt = Math.max(
      finishedAt,
      check.createdAt + PRIVATE_SCHEDULE_MINUTES * 60 * 1000
    );
    await db
      .insert(privateGroupStates)
      .values({
        sourceId: check.sourceId,
        accountId: check.accountId,
        status: successful ? "healthy" : failureStatus,
        lastCheckAt: finishedAt,
        lastSuccessAt: successful ? finishedAt : previousState?.lastSuccessAt ?? 0,
        nextCheckAt,
        bytesTransferred: (previousState?.bytesTransferred ?? 0) + bytes,
        postsCollected: (previousState?.postsCollected ?? 0) + postsCollected,
        spendAudMicros: (previousState?.spendAudMicros ?? 0) + cost.actual,
        consecutiveFailures: successful ? 0 : (previousState?.consecutiveFailures ?? 0) + 1,
        latestErrorCode: successful ? "" : errorCode,
        latestError: successful ? "" : errorDetail,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: privateGroupStates.sourceId,
        set: {
          accountId: check.accountId,
          status: successful ? "healthy" : failureStatus,
          lastCheckAt: finishedAt,
          lastSuccessAt: successful ? finishedAt : previousState?.lastSuccessAt ?? 0,
          nextCheckAt,
          bytesTransferred: (previousState?.bytesTransferred ?? 0) + bytes,
          postsCollected: (previousState?.postsCollected ?? 0) + postsCollected,
          spendAudMicros: (previousState?.spendAudMicros ?? 0) + cost.actual,
          consecutiveFailures: successful ? 0 : (previousState?.consecutiveFailures ?? 0) + 1,
          latestErrorCode: successful ? "" : errorCode,
          latestError: successful ? "" : errorDetail,
          updatedAt: Date.now(),
        },
      });

    if (successful) {
      const recoveredMembers = await db
        .select({
          userId: groups.userId,
          email: users.email,
          plan: profiles.plan,
          billingPeriodStart: profiles.billingPeriodStart,
          billingPeriodEnd: profiles.billingPeriodEnd,
          privateBudgetPausedUntil: profiles.privateBudgetPausedUntil,
          budgetStatus: profiles.privateBudgetStatus,
        })
        .from(groups)
        .innerJoin(profiles, eq(profiles.userId, groups.userId))
        .innerJoin(users, eq(users.id, groups.userId))
        .where(and(eq(groups.sourceId, check.sourceId), eq(groups.status, "watching")));
      for (const member of recoveredMembers) {
        if (member.budgetStatus === "health_wait") {
          const spend = await currentPrivateSpend(member);
          const projected = forecastPrivateSpend(
            spend,
            member,
            Math.floor(Date.now() / 1000)
          );
          const atRisk =
            spend.total >= privateScrapingWarningAudMicros(member.plan) ||
            projected >= privateScrapingWarningAudMicros(member.plan);
          await db
            .update(profiles)
            .set({
              privateBudgetStatus: atRisk ? "at_risk" : "ready",
              privateBudgetPausedUntil: 0,
            })
            .where(eq(profiles.userId, member.userId));
          await resolvePrivateIncident(
            `private_budget:${member.userId}`,
            `${member.email} is in a new billing cycle and source ${check.sourceId} passed a live private group check.`
          );
          if (!atRisk) {
            await resolvePrivateIncident(
              `private_budget_warning:${member.userId}`,
              `${member.email} is below the private budget warning level after source ${check.sourceId} passed.`
            );
          }
        } else if (member.budgetStatus === "at_risk") {
          const spend = await currentPrivateSpend(member);
          const projected = forecastPrivateSpend(
            spend,
            member,
            Math.floor(Date.now() / 1000)
          );
          if (
            spend.total < privateScrapingWarningAudMicros(member.plan) &&
            projected < privateScrapingWarningAudMicros(member.plan)
          ) {
            await db
              .update(profiles)
              .set({ privateBudgetStatus: "ready" })
              .where(eq(profiles.userId, member.userId));
            await resolvePrivateIncident(
              `private_budget_warning:${member.userId}`,
              `${member.email} is below the warning level and source ${check.sourceId} passed a live private group check.`
            );
          }
        }
      }
      await resolvePrivateIncident(
        `missed_check:${check.sourceId}`,
        `Private group ${check.sourceId} completed its hourly check.`
      );
      await resolvePrivateIncident(
        `group_access:${check.sourceId}`,
        `Private group ${check.sourceId} is readable again.`
      );
      await resolvePrivateIncident(
        `group_scan:${check.sourceId}`,
        `Private group ${check.sourceId} completed a healthy check.`
      );
    } else if (["access_lost", "deleted", "unavailable"].includes(failureStatus)) {
      await db
        .update(groups)
        .set({ status: "waiting_for_access" })
        .where(
          and(eq(groups.sourceId, check.sourceId), eq(groups.status, "watching"))
        );
      // First-time access approval is expected and is not an emergency.
      if ((previousState?.lastSuccessAt ?? 0) > 0) {
        const derivative = await sourceHasRootOutage(check.sourceId, Date.now());
        await openPrivateIncident({
          fingerprint: `group_access:${check.sourceId}`,
          kind: failureStatus,
          title: `Private Facebook group access was lost: ${sourceForScan?.groupName || check.sourceId}`,
          detail: `${errorDetail || errorCode}. Last good check: ${new Date(previousState!.lastSuccessAt).toISOString()}. Action: approve ${check.accountId} for this Facebook group again.`,
          targetType: "source",
          targetId: check.sourceId,
          ...(derivative ? { severity: "warning" as const, notify: false } : {}),
        });
      }
    } else if (
      !(
        failureStatus === "waiting_for_access" &&
        (previousState?.lastSuccessAt ?? 0) === 0
      ) &&
      (previousState?.consecutiveFailures ?? 0) + 1 >= 3
    ) {
      const derivative = await sourceHasRootOutage(check.sourceId, Date.now());
      await openPrivateIncident({
        fingerprint: `group_scan:${check.sourceId}`,
        kind: errorCode || "repeated_scan_failure",
        title: `Private group check keeps failing: ${sourceForScan?.groupName || check.sourceId}`,
        detail: `${errorDetail || errorCode}. Last good check: ${previousState?.lastSuccessAt ? new Date(previousState.lastSuccessAt).toISOString() : "none yet"}. Action: check the VPS run log and retry this group.`,
        targetType: "source",
        targetId: check.sourceId,
        ...(derivative ? { severity: "warning" as const, notify: false } : {}),
      });
    }
  }

  if (input.bandwidthTargetExceeded) {
    await openPrivateIncident({
      fingerprint: `bandwidth_target:${check.sourceId || check.accountId}`,
      kind: "bandwidth_target_exceeded",
      title: `Private scraper bandwidth target was exceeded`,
      detail: `${bytes} bytes were transferred. The reported target was ${integer(input.bandwidthTargetBytes) ?? 0} bytes.`,
      severity: "warning",
      targetType: check.sourceId ? "source" : "account",
      targetId: check.sourceId || check.accountId,
    });
  }

  await recordPrivateAction({
    kind: check.kind === "scan_group" ? "group_check" : "session_validation",
    message: successful
      ? `${check.kind} completed. ${postsCollected} posts. ${bytes} bytes. ${cost.actual} AUD micros.`
      : `${check.kind} failed: ${errorCode || "unknown"}.`,
    status: finalStatus,
    targetType: check.kind === "scan_group" ? "source" : "account",
    targetId: check.kind === "scan_group" ? check.sourceId : check.accountId,
  });

  return { ok: true, duplicate: false, status: finalStatus, errorCode };
}

async function sourceHasRootOutage(sourceId: number, now: number) {
  const [row] = await getDb()
    .select({
      accountStatus: privateScraperAccounts.status,
      sessionStatus: privateScraperAccounts.sessionStatus,
      proxyStatus: privateScraperAccounts.proxyStatus,
      accountHeartbeat: privateScraperAccounts.lastHeartbeatAt,
      workerStatus: privateScraperWorkers.status,
      workerHeartbeat: privateScraperWorkers.lastHeartbeatAt,
    })
    .from(privateGroupStates)
    .leftJoin(privateScraperAccounts, eq(privateScraperAccounts.id, privateGroupStates.accountId))
    .leftJoin(privateScraperWorkers, eq(privateScraperWorkers.id, privateScraperAccounts.workerId))
    .where(eq(privateGroupStates.sourceId, sourceId))
    .limit(1);
  if (!row) return false;
  return (
    now - Number(row.workerHeartbeat ?? 0) > HEARTBEAT_STALE_MS ||
    now - Number(row.accountHeartbeat ?? 0) > HEARTBEAT_STALE_MS ||
    !["healthy", "degraded"].includes(String(row.workerStatus || "")) ||
    row.accountStatus !== "healthy" ||
    row.sessionStatus !== "healthy" ||
    row.proxyStatus !== "healthy"
  );
}

/** Cloudflare calls this even when the VPS is dead. */
export async function sweepPrivateMonitoringHealth() {
  await enforcePrivatePlanLimits();
  if (!process.env.PRIVATE_SCRAPER_SECRET) return { enabled: false };

  const db = getDb();
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);

  const expired = await db
    .select()
    .from(privateScrapeChecks)
    .where(
      and(
        inArray(privateScrapeChecks.status, ["allocating", "reserved", "processing"]),
        lte(privateScrapeChecks.deadlineAt, now)
      )
    );
  for (const check of expired) {
    await db
      .update(privateScrapeChecks)
      .set({
        status: "expired",
        finishedAt: now,
        errorCode: "job_deadline_missed",
        errorDetail: "The VPS did not return this reserved job before its deadline.",
      })
      .where(eq(privateScrapeChecks.runId, check.runId));
    await db
      .update(privateCostAllocations)
      .set({ status: "released", reservedAudMicros: 0, updatedAt: now })
      .where(eq(privateCostAllocations.runId, check.runId));
    let derivative = check.sourceId ? await sourceHasRootOutage(check.sourceId, now) : false;
    if (!check.sourceId) {
      const [jobWorker] = await db
        .select({ status: privateScraperWorkers.status, heartbeat: privateScraperWorkers.lastHeartbeatAt })
        .from(privateScraperWorkers)
        .where(eq(privateScraperWorkers.id, check.workerId))
        .limit(1);
      derivative =
        !jobWorker ||
        now - jobWorker.heartbeat > HEARTBEAT_STALE_MS ||
        !["healthy", "degraded"].includes(jobWorker.status);
    }
    const [expiredSource] = check.sourceId
      ? await db
          .select({ groupName: sources.groupName })
          .from(sources)
          .where(eq(sources.id, check.sourceId))
          .limit(1)
      : [];
    await openPrivateIncident({
      fingerprint: `job_deadline:${check.sourceId || check.accountId}`,
      kind: "job_deadline_missed",
      title: `Private scraper job was missed: ${expiredSource?.groupName || check.accountId}`,
      detail: `Run ${check.runId} was not returned by ${check.workerId}. Action: check the VPS service and retry the job.`,
      targetType: check.sourceId ? "source" : "account",
      targetId: check.sourceId || check.accountId,
      ...(derivative ? { severity: "warning" as const, notify: false } : {}),
    });
  }

  const workers = await db.select().from(privateScraperWorkers);
  for (const worker of workers) {
    if (now - worker.lastHeartbeatAt > HEARTBEAT_STALE_MS) {
      await openPrivateIncident({
        fingerprint: `worker_health:${worker.id}`,
        kind: "scraper_offline",
        title: `Private scraper is offline: ${worker.name || worker.id}`,
        detail: `Last heartbeat was ${new Date(worker.lastHeartbeatAt).toISOString()}. Action: check the VPS service and network.`,
        targetType: "worker",
        targetId: worker.id,
      });
    } else {
      await resolvePrivateIncident(
        `worker_health:${worker.id}`,
        `Worker ${worker.name || worker.id} is reporting normally.`
      );
    }
  }

  const [privateDemand] = await db
    .select({ id: groups.id })
    .from(groups)
    .innerJoin(sources, eq(sources.id, groups.sourceId))
    .where(
      and(
        eq(sources.active, 1),
        eq(sources.visibility, "private"),
        inArray(groups.status, REQUESTED_GROUP_STATUSES)
      )
    )
    .limit(1);
  if (privateDemand) {
    const accounts = await db.select().from(privateScraperAccounts);
    const liveWorkerIds = new Set(
      workers
        .filter(
          (worker) =>
            now - worker.lastHeartbeatAt <= HEARTBEAT_STALE_MS &&
            ["healthy", "degraded"].includes(worker.status) &&
            ["healthy", "degraded"].includes(worker.proxyStatus)
        )
        .map((worker) => worker.id)
    );
    const healthyCapacity = accounts.some(
      (account) =>
        account.active === 1 &&
        liveWorkerIds.has(account.workerId) &&
        now - account.lastHeartbeatAt <= HEARTBEAT_STALE_MS &&
        account.status === "healthy" &&
        account.sessionStatus === "healthy" &&
        account.proxyStatus === "healthy"
    );
    if (!workers.length) {
      await openPrivateIncident({
        fingerprint: "private_capacity",
        kind: "worker_missing",
        title: "Private monitoring has no VPS worker",
        detail: "Private groups are waiting, but no worker has reported. Action: start the VPS service and check its secret.",
        targetType: "system",
      });
    } else if (!accounts.length && liveWorkerIds.size) {
      await openPrivateIncident({
        fingerprint: "private_capacity",
        kind: "account_missing",
        title: "Private monitoring has no Facebook account",
        detail: "The VPS is online, but it reports no Facebook account. Action: import and validate a session on the VPS.",
        targetType: "system",
      });
    } else if (healthyCapacity) {
      await resolvePrivateIncident(
        "private_capacity",
        "A live VPS worker and healthy Facebook account are ready."
      );
    }
  } else {
    await resolvePrivateIncident(
      "private_capacity",
      "No active private groups currently need scraper capacity."
    );
  }

  // Budget pauses stay in place until Stripe proves a new cycle. A group can
  // re-enter the queue only after its worker, account, session and proxy are
  // healthy. A successful group scan then proves access and closes recovery.
  // Public source rows are never touched here.
  const pausedMembers = await db
    .select({
      userId: profiles.userId,
      email: users.email,
      plan: profiles.plan,
      stripeCustomerId: profiles.stripeCustomerId,
      billingPeriodStart: profiles.billingPeriodStart,
      billingPeriodEnd: profiles.billingPeriodEnd,
      privateBudgetPausedUntil: profiles.privateBudgetPausedUntil,
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(inArray(profiles.privateBudgetStatus, ["paused", "health_wait", "cycle_unknown"]));
  for (const raw of pausedMembers) {
    if (raw.privateBudgetPausedUntil && nowSeconds < raw.privateBudgetPausedUntil) continue;
    const member = await syncStripePeriod(raw);
    if (
      member.billingPeriodStart <= 0 ||
      member.billingPeriodStart > nowSeconds ||
      (raw.privateBudgetPausedUntil > 0 && member.billingPeriodStart < raw.privateBudgetPausedUntil) ||
      member.billingPeriodEnd <= nowSeconds
    ) {
      continue;
    }
    const pausedGroups = await db
      .select({
        id: groups.id,
        sourceId: groups.sourceId,
        accessStatus: privateGroupStates.status,
        accountStatus: privateScraperAccounts.status,
        sessionStatus: privateScraperAccounts.sessionStatus,
        proxyStatus: privateScraperAccounts.proxyStatus,
        workerHeartbeat: privateScraperWorkers.lastHeartbeatAt,
      })
      .from(groups)
      .innerJoin(sources, eq(sources.id, groups.sourceId))
      .leftJoin(privateGroupStates, eq(privateGroupStates.sourceId, groups.sourceId))
      .leftJoin(privateScraperAccounts, eq(privateScraperAccounts.id, privateGroupStates.accountId))
      .leftJoin(privateScraperWorkers, eq(privateScraperWorkers.id, privateScraperAccounts.workerId))
      .where(
        and(
          eq(groups.userId, member.userId),
          eq(groups.status, "budget_paused_private"),
          eq(sources.visibility, "private")
        )
      );
    for (const group of pausedGroups) {
      const healthy =
        group.accountStatus === "healthy" &&
        group.sessionStatus === "healthy" &&
        group.proxyStatus === "healthy" &&
        now - Number(group.workerHeartbeat ?? 0) <= HEARTBEAT_STALE_MS;
      if (!healthy) continue;
      const nextStatus = group.accessStatus === "healthy" ? "watching" : "waiting_for_access";
      await db.update(groups).set({ status: nextStatus }).where(eq(groups.id, group.id));
      if (group.sourceId && nextStatus === "waiting_for_access") {
        await db
          .update(privateGroupStates)
          .set({ nextCheckAt: now, retryRequestedAt: now, updatedAt: now })
          .where(eq(privateGroupStates.sourceId, group.sourceId));
      }
    }
    await db
      .update(profiles)
      .set({
        privateBudgetStatus: "health_wait",
      })
      .where(eq(profiles.userId, member.userId));
  }
  if (pausedMembers.length) await enforcePrivatePlanLimits();

  const states = await db.select().from(privateGroupStates);
  for (const state of states) {
    if (!state.nextCheckAt || state.nextCheckAt + 15 * 60 * 1000 > now) continue;
    if (state.status === "waiting_for_access" && !state.lastSuccessAt) continue;
    const watchers = await sourceWatchers(state.sourceId);
    if (!watchers.length) continue;
    const derivative = await sourceHasRootOutage(state.sourceId, now);
    const [missedSource] = await db
      .select({ groupName: sources.groupName })
      .from(sources)
      .where(eq(sources.id, state.sourceId))
      .limit(1);
    await openPrivateIncident({
      fingerprint: `missed_check:${state.sourceId}`,
      kind: "missed_hourly_check",
      title: `Private group missed its hourly check: ${missedSource?.groupName || state.sourceId}`,
      detail: `The check was due at ${new Date(state.nextCheckAt).toISOString()}. Last good check: ${state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : "none yet"}. Action: check the VPS queue and retry this group.`,
      targetType: "source",
      targetId: state.sourceId,
      ...(derivative ? { severity: "warning" as const, notify: false } : {}),
    });
  }

  return { enabled: true, expired: expired.length };
}
