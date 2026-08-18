import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { requireAdmin } from "../../../../db/admin";
import {
  PRIVATE_LOOKBACK_MINUTES,
  PRIVATE_SCHEDULE_MINUTES,
  sweepPrivateMonitoringHealth,
} from "../../../../db/private-monitoring";
import {
  privateScrapingBudgetAudMicros,
  privateScrapingSafetyCutoffAudMicros,
  privateScrapingWarningAudMicros,
  planFor,
} from "../../../../db/plans";
import { recordPrivateAction } from "../../../../db/private-alerts";
import {
  groups,
  privateActions,
  privateCostAllocations,
  privateGroupStates,
  privateIncidents,
  privateScrapeChecks,
  privateScraperAccounts,
  privateScraperWorkers,
  profiles,
  sources,
  users,
} from "../../../../db/schema";

const iso = (value: number) => (value ? new Date(value).toISOString() : null);
const stripeIso = (value: number) => (value ? new Date(value * 1000).toISOString() : null);

async function applyAction(body: {
  action?: string;
  targetType?: string;
  targetId?: string | number;
}) {
  if (!body.action || body.action === "status") return;
  const db = getDb();
  const now = Date.now();
  const sourceId = Number(body.targetId);
  const accountId = String(body.targetId ?? "");

  if (body.action === "retry_check" && body.targetType === "source" && sourceId > 0) {
    await db
      .update(privateGroupStates)
      .set({ retryRequestedAt: now, nextCheckAt: now, updatedAt: now })
      .where(eq(privateGroupStates.sourceId, sourceId));
  } else if (body.action === "pause_source" && body.targetType === "source" && sourceId > 0) {
    const [source] = await db
      .select({ visibility: sources.visibility })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    if (source?.visibility !== "private") throw new Error("not_private_source");
    await db.update(sources).set({ active: 0 }).where(eq(sources.id, sourceId));
    await db
      .update(groups)
      .set({ status: "paused_private" })
      .where(
        and(
          eq(groups.sourceId, sourceId),
          inArray(groups.status, ["watching", "waiting_for_access"])
        )
      );
  } else if (body.action === "resume_source" && body.targetType === "source" && sourceId > 0) {
    const [state] = await db
      .select({ status: privateGroupStates.status })
      .from(privateGroupStates)
      .where(eq(privateGroupStates.sourceId, sourceId))
      .limit(1);
    await db.update(sources).set({ active: 1 }).where(eq(sources.id, sourceId));
    await db
      .update(groups)
      .set({ status: state?.status === "healthy" ? "watching" : "waiting_for_access" })
      .where(and(eq(groups.sourceId, sourceId), eq(groups.status, "paused_private")));
  } else if (
    body.action === "validate_session" &&
    body.targetType === "account" &&
    accountId
  ) {
    await db
      .update(privateScraperAccounts)
      .set({ validateRequestedAt: now, updatedAt: now })
      .where(eq(privateScraperAccounts.id, accountId));
  } else if (
    body.action === "acknowledge_incident" &&
    body.targetType === "incident" &&
    sourceId > 0
  ) {
    await db
      .update(privateIncidents)
      .set({ status: "acknowledged", nextReminderAt: now + 24 * 60 * 60 * 1000 })
      .where(eq(privateIncidents.id, sourceId));
  } else {
    throw new Error("bad_action");
  }

  await recordPrivateAction({
    kind: `admin_${body.action}`,
    message: `Admin requested ${body.action} for ${body.targetType} ${body.targetId}.`,
    targetType: body.targetType,
    targetId: body.targetId,
  });
}

async function snapshot() {
  const db = getDb();
  await sweepPrivateMonitoringHealth();
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const [
    workerRows,
    accountRows,
    sourceRows,
    groupRows,
    profileRows,
    checkRows,
    incidentRows,
    actionRows,
    customerCostRows,
    accountCostRows,
    aggregateRows,
    hourlyRows,
    incidentAggregateRows,
  ] =
    await Promise.all([
      db.select().from(privateScraperWorkers).orderBy(asc(privateScraperWorkers.id)),
      db.select().from(privateScraperAccounts).orderBy(asc(privateScraperAccounts.id)),
      db.select().from(sources).where(eq(sources.visibility, "private")).orderBy(asc(sources.id)),
      db.select().from(groups).orderBy(asc(groups.id)),
      db
        .select({
          userId: profiles.userId,
          email: users.email,
          plan: profiles.plan,
          billingPeriodStart: profiles.billingPeriodStart,
          billingPeriodEnd: profiles.billingPeriodEnd,
          budgetStatus: profiles.privateBudgetStatus,
        })
        .from(profiles)
        .innerJoin(users, eq(users.id, profiles.userId))
        .orderBy(asc(users.email)),
      db
        .select()
        .from(privateScrapeChecks)
        .orderBy(desc(privateScrapeChecks.createdAt))
        .limit(200),
      db.select().from(privateIncidents).orderBy(desc(privateIncidents.lastSeenAt)).limit(200),
      db.select().from(privateActions).orderBy(desc(privateActions.createdAt)).limit(200),
      db
        .select({
          userId: profiles.userId,
          actualAudMicros: sql<number>`coalesce(sum(${privateCostAllocations.actualAudMicros}), 0)`,
          reservedAudMicros: sql<number>`coalesce(sum(${privateCostAllocations.reservedAudMicros}), 0)`,
        })
        .from(profiles)
        .leftJoin(
          privateCostAllocations,
          and(
            eq(privateCostAllocations.userId, profiles.userId),
            eq(privateCostAllocations.periodStart, profiles.billingPeriodStart),
            eq(privateCostAllocations.periodEnd, profiles.billingPeriodEnd),
            ne(privateCostAllocations.status, "released")
          )
        )
        .groupBy(profiles.userId),
      db
        .select({
          accountId: privateScrapeChecks.accountId,
          bytesTransferred: sql<number>`coalesce(sum(${privateScrapeChecks.bytesTransferred}), 0)`,
          audMicros: sql<number>`coalesce(sum(${privateScrapeChecks.actualAudMicros}), 0)`,
          proxyAudMicros: sql<number>`coalesce(sum(${privateScrapeChecks.proxyCostAudMicros}), 0)`,
          vpsAudMicros: sql<number>`coalesce(sum(${privateScrapeChecks.vpsCostAudMicros}), 0)`,
        })
        .from(privateScrapeChecks)
        .groupBy(privateScrapeChecks.accountId),
      db
        .select({
          checks: sql<number>`count(*)`,
          posts: sql<number>`coalesce(sum(${privateScrapeChecks.postsCollected}), 0)`,
          bytesTransferred: sql<number>`coalesce(sum(${privateScrapeChecks.bytesTransferred}), 0)`,
          audMicros: sql<number>`coalesce(sum(${privateScrapeChecks.actualAudMicros}), 0)`,
          failures: sql<number>`coalesce(sum(case when ${privateScrapeChecks.status} <> 'success' then 1 else 0 end), 0)`,
        })
        .from(privateScrapeChecks)
        .where(gte(privateScrapeChecks.finishedAt, thirtyDaysAgo)),
      db
        .select({
          hour: sql<string>`strftime('%H', ${privateScrapeChecks.finishedAt} / 1000, 'unixepoch', '+8 hours')`,
          checks: sql<number>`count(*)`,
          posts: sql<number>`coalesce(sum(${privateScrapeChecks.postsCollected}), 0)`,
          bytesTransferred: sql<number>`coalesce(sum(${privateScrapeChecks.bytesTransferred}), 0)`,
          audMicros: sql<number>`coalesce(sum(${privateScrapeChecks.actualAudMicros}), 0)`,
          failures: sql<number>`coalesce(sum(case when ${privateScrapeChecks.status} <> 'success' then 1 else 0 end), 0)`,
        })
        .from(privateScrapeChecks)
        .where(gte(privateScrapeChecks.finishedAt, thirtyDaysAgo))
        .groupBy(sql`strftime('%H', ${privateScrapeChecks.finishedAt} / 1000, 'unixepoch', '+8 hours')`),
      db
        .select({
          open: sql<number>`coalesce(sum(case when ${privateIncidents.status} <> 'resolved' then 1 else 0 end), 0)`,
          lastSmsAt: sql<number>`coalesce(max(case when ${privateIncidents.smsState} = 'sent' then ${privateIncidents.lastAlertAt} else 0 end), 0)`,
        })
        .from(privateIncidents),
    ]);

  const states = await db.select().from(privateGroupStates);
  const stateBySource = new Map(states.map((row) => [row.sourceId, row]));
  const accountById = new Map(accountRows.map((row) => [row.id, row]));
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const checksByAccount = new Map<string, typeof checkRows>();
  for (const check of checkRows) {
    const bucket = checksByAccount.get(check.accountId) ?? [];
    bucket.push(check);
    checksByAccount.set(check.accountId, bucket);
  }
  const costsByAccount = new Map(accountCostRows.map((row) => [row.accountId, row]));
  const costsByCustomer = new Map(customerCostRows.map((row) => [row.userId, row]));

  const workers = workerRows.map((row) => ({
    id: row.id,
    name: row.name || row.id,
    status: row.status,
    proxyStatus: row.proxyStatus,
    version: row.version,
    estimatedMaxCostAudMicros: row.estimatedMaxCostAudMicros,
    lastHeartbeatAt: iso(row.lastHeartbeatAt),
    lastError: row.lastError,
  }));

  const accounts = accountRows.map((row) => {
    const checks = checksByAccount.get(row.id) ?? [];
    const assigned = states.filter((state) => state.accountId === row.id);
    const last = checks[0];
    const totals = costsByAccount.get(row.id);
    return {
      id: row.id,
      label: row.label || row.id,
      status: row.status,
      sessionStatus: row.sessionStatus,
      proxyStatus: row.proxyStatus,
      groupsAssigned: assigned.length,
      lastHealthCheckAt: iso(row.lastHealthCheckAt),
      lastScanAt: iso(row.lastScanAt),
      nextScanAt: iso(
        assigned.reduce(
          (minimum, state) => !minimum || state.nextCheckAt < minimum ? state.nextCheckAt : minimum,
          0
        )
      ),
      cookieSavedAt: iso(row.cookieSavedAt),
      sessionExpiresAt: iso(row.sessionExpiresAt),
      healthValidationDue: row.validateRequestedAt > row.lastHealthCheckAt,
      bytesTransferred: Number(totals?.bytesTransferred ?? 0),
      audMicros: Number(totals?.audMicros ?? 0),
      proxyAudMicros: Number(totals?.proxyAudMicros ?? 0),
      vpsAudMicros: Number(totals?.vpsAudMicros ?? 0),
      consecutiveFailures: row.consecutiveFailures,
      latestErrorCode: row.latestErrorCode || last?.errorCode || "",
      latestError: row.latestError || last?.errorDetail || "",
    };
  });

  const privateGroups = sourceRows.map((source) => {
    const state = stateBySource.get(source.id);
    const account = state ? accountById.get(state.accountId) : undefined;
    const watchers = groupRows.filter((group) => group.sourceId === source.id);
    return {
      id: source.id,
      name: source.groupName,
      status: source.active ? "active" : "paused",
      accessStatus: state?.status || "waiting_for_access",
      accountLabel: account?.label || "",
      lastScanAt: iso(state?.lastCheckAt ?? 0),
      lastSuccessAt: iso(state?.lastSuccessAt ?? 0),
      nextScanAt: iso(state?.nextCheckAt ?? 0),
      bytesTransferred: state?.bytesTransferred ?? 0,
      audMicros: state?.spendAudMicros ?? 0,
      postsCollected: state?.postsCollected ?? 0,
      latestErrorCode: state?.latestErrorCode || source.lastError,
      latestError: state?.latestError || source.lastError,
      watchers: watchers.length,
    };
  });

  const customers = profileRows.map((profile) => {
    const myGroups = groupRows.filter((group) => group.userId === profile.userId);
    const privateCount = myGroups.filter((group) =>
      group.sourceId ? sourceById.has(group.sourceId) : false
    ).length;
    const publicCount = myGroups.filter(
      (group) => group.sourceId && !sourceById.has(group.sourceId)
    ).length;
    const cost = costsByCustomer.get(profile.userId);
    const actual = Number(cost?.actualAudMicros ?? 0);
    const reserved = Number(cost?.reservedAudMicros ?? 0);
    const budget = privateScrapingBudgetAudMicros(profile.plan);
    const safetyCutoff = privateScrapingSafetyCutoffAudMicros(profile.plan);
    const warningAt = privateScrapingWarningAudMicros(profile.plan);
    const elapsed = Math.max(1, Math.floor(now / 1000) - profile.billingPeriodStart);
    const duration = Math.max(elapsed, profile.billingPeriodEnd - profile.billingPeriodStart);
    const forecast = profile.billingPeriodStart && profile.billingPeriodEnd
      ? Math.max(actual + reserved, Math.ceil(actual * duration / elapsed) + reserved)
      : actual + reserved;
    return {
      id: profile.userId,
      email: profile.email,
      planName: planFor(profile.plan).name,
      planPriceAudMicros: planFor(profile.plan).priceAud * 1_000_000,
      budgetStatus: profile.budgetStatus,
      privateGroups: privateCount,
      publicGroups: publicCount,
      actualAudMicros: actual,
      reservedAudMicros: reserved,
      forecastAudMicros: forecast,
      budgetAudMicros: budget,
      safetyCutoffAudMicros: safetyCutoff,
      warningAudMicros: warningAt,
      remainingAudMicros: Math.max(0, budget - actual - reserved),
      safetyRemainingAudMicros: Math.max(0, safetyCutoff - actual - reserved),
      billingCycleEndsAt: stripeIso(profile.billingPeriodEnd),
      pausedPrivateGroups: myGroups.filter((group) => group.status === "budget_paused_private").length,
    };
  });

  const checks = checkRows.map((row) => ({
    id: row.runId,
    kind: row.kind,
    groupName: sourceById.get(row.sourceId)?.groupName || (row.kind === "validate_session" ? "Session check" : `Source ${row.sourceId}`),
    accountLabel: accountById.get(row.accountId)?.label || row.accountId,
    status: row.status,
    startedAt: iso(row.startedAt || row.createdAt),
    durationMs: row.finishedAt && (row.startedAt || row.createdAt)
      ? row.finishedAt - (row.startedAt || row.createdAt)
      : 0,
    bytesTransferred: row.bytesTransferred,
    postsCollected: row.postsCollected,
    audMicros: row.actualAudMicros,
    errorCode: row.errorCode,
    errorDetail: row.errorDetail,
    chronologicalVerified: row.chronologicalVerified === 1,
    boundaryReached: row.boundaryReached === 1,
    feedEndReached: row.feedEndReached === 1,
  }));

  const incidents = incidentRows.map((row) => ({
    id: row.id,
    severity: row.severity,
    status: row.status,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    createdAt: iso(row.firstSeenAt),
    lastAlertAt: iso(row.lastAlertAt),
    resolvedAt: iso(row.resolvedAt),
    smsState: row.smsState,
    emailState: row.emailState,
    recoveryState: row.recoveryState,
  }));

  const actions = actionRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    message: row.message,
    status: row.status,
    createdAt: iso(row.createdAt),
  }));

  const hourlyByHour = new Map(
    hourlyRows.map((row) => [Number(row.hour), row])
  );
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    checks: Number(hourlyByHour.get(hour)?.checks ?? 0),
    posts: Number(hourlyByHour.get(hour)?.posts ?? 0),
    bytesTransferred: Number(hourlyByHour.get(hour)?.bytesTransferred ?? 0),
    audMicros: Number(hourlyByHour.get(hour)?.audMicros ?? 0),
    failures: Number(hourlyByHour.get(hour)?.failures ?? 0),
  }));

  const configured = Boolean(process.env.PRIVATE_SCRAPER_SECRET);
  const liveWorkers = workerRows.filter((row) => now - row.lastHeartbeatAt <= 10 * 60 * 1000);
  const usableWorkerIds = new Set(
    liveWorkers
      .filter(
        (row) =>
          ["healthy", "degraded"].includes(row.status) &&
          ["healthy", "degraded"].includes(row.proxyStatus)
      )
      .map((row) => row.id)
  );
  const hasUsableAccount = accountRows.some(
    (row) =>
      row.active === 1 &&
      usableWorkerIds.has(row.workerId) &&
      now - row.lastHeartbeatAt <= 10 * 60 * 1000 &&
      row.status === "healthy" &&
      row.sessionStatus === "healthy" &&
      row.proxyStatus === "healthy"
  );
  const aggregate = aggregateRows[0] ?? {
    checks: 0,
    posts: 0,
    bytesTransferred: 0,
    audMicros: 0,
    failures: 0,
  };
  const incidentAggregate = incidentAggregateRows[0] ?? { open: 0, lastSmsAt: 0 };
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    summary: {
      status: !configured
        ? "not_configured"
        : !liveWorkers.length
          ? "offline"
          : usableWorkerIds.size && hasUsableAccount
            ? "running"
            : "degraded",
      lastHeartbeatAt: iso(Math.max(0, ...workerRows.map((row) => row.lastHeartbeatAt))),
      activeAccounts: accountRows.filter((row) => row.active).length,
      healthyAccounts: accountRows.filter(
        (row) =>
          row.active === 1 &&
          usableWorkerIds.has(row.workerId) &&
          now - row.lastHeartbeatAt <= 10 * 60 * 1000 &&
          row.status === "healthy" &&
          row.sessionStatus === "healthy" &&
          row.proxyStatus === "healthy"
      ).length,
      privateGroups: sourceRows.length,
      groupsDue: states.filter((row) => row.nextCheckAt <= now).length,
      openIncidents: Number(incidentAggregate.open),
      bytesThisCycle: Number(aggregate.bytesTransferred),
      audMicrosThisCycle: Number(aggregate.audMicros),
      costWindow: "last_30_days",
      lastSmsAt: iso(Number(incidentAggregate.lastSmsAt)),
      lookbackMinutes: PRIVATE_LOOKBACK_MINUTES,
      scheduleMinutes: PRIVATE_SCHEDULE_MINUTES,
    },
    workers,
    accounts,
    groups: privateGroups,
    customers,
    checks,
    incidents,
    actions,
    hours,
    aggregate: {
      window: "last_30_days",
      checks: Number(aggregate.checks),
      posts: Number(aggregate.posts),
      bytesTransferred: Number(aggregate.bytesTransferred),
      audMicros: Number(aggregate.audMicros),
      failures: Number(aggregate.failures),
    },
  };
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    password?: string;
    action?: string;
    targetType?: string;
    targetId?: string | number;
  };
  const denied = await requireAdmin(body);
  if (denied) return denied;
  try {
    await applyAction(body);
    return Response.json(await snapshot());
  } catch (err) {
    const error = err instanceof Error ? err.message : "private_monitoring_failed";
    return Response.json(
      { error },
      { status: ["bad_action", "not_private_source"].includes(error) ? 400 : 500 }
    );
  }
}
