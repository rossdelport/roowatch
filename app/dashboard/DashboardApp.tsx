"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { groupSlug, parseGroupInput } from "../../db/fbgroups";
import { suburbsFor } from "../../db/suburbs";
import { OTHER_TRADE, STATES, TRADES } from "../../db/trades";
import { PLAN_KEYS, PLANS, TRIAL_DAYS, type Plan, type PlanKey } from "../../db/plans";
import { BRIEF_MAX, BRIEF_MIN } from "../../db/brief";
import { LEAD_STATUSES, leadStatus } from "../../db/leadstatus";

const PIXEL_ID = "4105570149577363";

type Pixel = ((...args: unknown[]) => void) & {
  queue?: unknown[];
  callMethod?: (...args: unknown[]) => void;
  loaded?: boolean;
  version?: string;
};

/** The standard Meta snippet, written once when the dashboard opens after
 *  checkout. Loaded here rather than on every dashboard visit, so it never
 *  runs for a member who is just checking their leads. */
function startPixel() {
  const w = window as unknown as { fbq?: Pixel; _fbq?: Pixel };
  if (w.fbq) return;
  const fbq: Pixel = function (...args: unknown[]) {
    if (fbq.callMethod) fbq.callMethod(...args);
    else fbq.queue!.push(args);
  } as Pixel;
  fbq.queue = [];
  fbq.loaded = true;
  fbq.version = "2.0";
  w.fbq = fbq;
  w._fbq = fbq;

  const script = document.createElement("script");
  script.async = true;
  script.src = "https://connect.facebook.net/en_US/fbevents.js";
  document.head.appendChild(script);

  fbq("init", PIXEL_ID);
}

type User = { id: string; email: string; name: string };
type Profile = {
  businessName: string;
  trade: string;
  state: string;
  plan: string;
  website: string;
  gbpUrl: string;
  services: string;
  location: string;
  brief: string;
  alertPhone: string;
  smsEnabled: number;
  onboardedAt: string | null;
  /** The setup wizard as they left it, JSON. Empty once setup is finished. */
  wizardDraft?: string;
} | null;

type Source = {
  id: number;
  groupName: string;
  url: string;
  active: boolean;
  lastChecked: number;
  lastCount: number;
  lastMatches: number;
  lastError: string;
  watchers: number;
};
type Group = {
  id: number;
  name: string;
  status: string;
  url?: string;
  /** Why we cannot read it, in Facebook's words. Empty when all is well. */
  problem?: string;
};

/**
 * True while a group is still showing the number out of its own web address.
 *
 * Facebook only tells us a group's real name inside a post, so a group that
 * has not posted since it was added has no name we could know. It fixes
 * itself on the first post. Saying so beats leaving somebody to wonder why
 * their dashboard is full of phone numbers.
 *
 * Only numeric addresses are affected. A group at /groups/cairnsnoticeboard
 * already reads well enough.
 */
function stillNumbers(group: { name: string; url?: string }) {
  const slug = groupSlug(group.url ?? "");
  return /^\d+$/.test(slug) && group.name.includes(slug);
}

/** 83200 -> 83k. Room is tight in a row and nobody needs the last digit. */
function shortCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** Facebook lets nobody but members read a private group, us included. */
function isPrivate(group: { problem?: string }) {
  return /private/i.test(group.problem ?? "");
}
type Alert = {
  id: number;
  groupName: string;
  postText: string;
  postUrl: string;
  reason: string;
  sentAt: string;
};
type Me = {
  user: User | null;
  isAdmin?: boolean;
  profile?: Profile;
  onboarded?: boolean;
  groups?: Group[];
  alerts?: Alert[];
  avatar?: string;
  postsUsed?: number;
  smsUsed?: number;
  hasPassword?: boolean;
  impersonating?: boolean;
  supportUnread?: number;
  plan?: Plan;
  trialEndsAt?: number;
  cancelAt?: number;
  subscriptionStatus?: string;
};
type UserStats = {
  mrr: number; trialMrr: number; total: number; paying: number;
  trialing: number; onboarded: number;
  byPlan: { key: string; name: string; count: number }[];
};
type HistoryPoint = { day: string; users: number; mrr: number };
type Member = {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  createdAt: string;
  onboarded: boolean;
  plan: string;
  planName: string;
  planGroups: number;
  planPrice: number;
  postsPerMonth: number;
  postsUsed: number;
  subscriptionStatus: string;
  /** Unix seconds their plan stops, 0 when it is not cancelled. */
  cancelAt?: number;
  stripeCustomerId: string;
  businessName: string;
  trade: string;
  state: string;
  phone: string;
  website: string;
  services: string;
  location: string;
  brief: string;
  groups: Group[];
  alertCount: number;
};
type StripeRow = {
  id: string;
  created: number;
  status: string;
  amount: number | null;
  email: string | null;
  phone: string | null;
  name: string | null;
};
type AdminTab = "users" | "support" | "usage" | "members" | "stripe" | "pipeline" | "funnel";

const I = {
  grid: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="18" height="18"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>,
  eye: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  bell: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>,
  gear: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33 1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  card: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="18" height="18"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>,
  people: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  chart: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M3 3v18h18"/><path d="M7 16l4-5 4 3 5-7"/></svg>,
  flow: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M4 4v6a2 2 0 0 0 2 2h12a2 2 0 0 1 2 2v6"/><circle cx="4" cy="3" r="1.6"/><circle cx="20" cy="21" r="1.6"/></svg>,
  out: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  tick: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="13" height="13"><polyline points="20 6 9 17 4 12"/></svg>,
  pencil: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>,
  send: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="17" height="17"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
  x: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" width="15" height="15"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  chat: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.8L3 21l1.9-4.1A8.4 8.4 0 0 1 4 11.5a8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 8 8.4z"/></svg>,
  dots: <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>,
  bin: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>,
  spark: <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2.5l1.9 5.3 5.3 1.9-5.3 1.9L12 16.9l-1.9-5.3L4.8 9.7l5.3-1.9z"/><path d="M18.5 15l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/></svg>,
};

export default function DashboardApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState("overview");
  const [leadsView, setLeadsView] = useState<"leads" | "posts">("leads");
  // Set once the member closes the celebration. Not read from the URL at
  // mount: this page is rendered on the server first, where there is no
  // window, and hydration keeps the server's answer. Reading the URL on every
  // render instead means the flag is still there when the profile finally
  // loads and we know whether they actually paid.
  const [partyDone, setPartyDone] = useState(false);
  /** The phone menu. Never opens on a desktop, where the sidebar is always there. */
  const [drawer, setDrawer] = useState(false);
  /**
   * Setup can be put aside. Every answer is already saved as a draft, so
   * closing it loses nothing, and being trapped in a modal on a phone with no
   * way out is worse than an unfinished watchlist.
   */
  const [adminTab, setAdminTab] = useState<AdminTab | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageDays, setUsageDays] = useState(14);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [waiting, setWaiting] = useState(0);
  const [adminError, setAdminError] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminReady, setAdminReady] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [userStats, setUserStats] = useState<UserStats | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [adminFlash, setAdminFlash] = useState("");
  /** How far back the ad funnel looks. It used to be a hidden 7 days, which
   *  quietly hid two thirds of Ross's waitlist. */
  const [funnelDays, setFunnelDays] = useState(90);
  const [stripeRows, setStripeRows] = useState<StripeRow[]>([]);
  const [stripeOn, setStripeOn] = useState(true);
  const [sources, setSources] = useState<Source[]>([]);
  const [uncovered, setUncovered] = useState<string[]>([]);
  const [keys, setKeys] = useState<{ apify: boolean; anthropic: boolean }>({ apify: false, anthropic: false });
  const [funnel, setFunnel] = useState<{ label: string; count: number; rate: number }[]>([]);
  const [signupFunnel, setSignupFunnel] = useState<{ label: string; count: number; rate: number }[]>([]);
  const [signups, setSignups] = useState<{ email: string; name: string; phone: string; trade: string; status?: string; createdAt: string }[]>([]);
  const [tradeStats, setTradeStats] = useState<{ slug: string; views: number; signups: number; rate: number }[]>([]);
  const adminStarted = useRef(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/me");
    setMe((await res.json()) as Me);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me")
      .then((res) => res.json() as Promise<Me>)
      .then((data: Me) => {
        if (!cancelled) setMe(data);
      })
      .catch(() => {
        if (!cancelled) setMe({ user: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Stripe sends them back here the moment checkout completes, card and all.
    //
    // The last of three. Lead fires at signup, CompleteRegistration when they
    // finish setup and head for the card, and Purchase here, once the card has
    // actually gone through. Three stages so Meta can be pointed at whichever
    // one currently has enough volume to learn from.
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") !== "success") return;
    // The parameter is left in place until they close the celebration. It is
    // the only thing telling us they have just come back from Stripe.
    startPixel();
    (window as unknown as { fbq?: Pixel }).fbq?.("track", "Purchase", {
      content_name: "RooWatch subscription",
      value: PLANS[(me?.profile?.plan ?? "local") as PlanKey]?.priceAud ?? 197,
      currency: "AUD",
    });
  }, [me?.profile?.plan]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    adminStarted.current = false;
    setAdminTab(null);
    setAdminReady(false);
    setMembers([]);
    refresh();
  }

  const loadAdmin = useCallback(async (
    target: AdminTab,
    days = funnelDays,
    uDays = usageDays
  ) => {
    setAdminBusy(true);
    setAdminError("");
    try {
      const post = (path: string, extra: Record<string, unknown> = {}) =>
        fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(extra),
        });
      const [mRes, sRes, pRes, fRes, tRes, uRes] = await Promise.all([
        post("/api/admin/members"),
        post("/api/admin/stripe"),
        post("/api/admin/sources"),
        post("/api/admin/funnel", { days }),
        post("/api/admin/support"),
        post("/api/admin/usage", { days: uDays }),
      ]);
      if (mRes.status === 401) {
        setAdminError("Your admin session has ended. Log in again.");
        return;
      }
      if (!mRes.ok) {
        setAdminError("The command centre could not load.");
        return;
      }
      const m = (await mRes.json()) as {
        members?: Member[]; stats?: UserStats; history?: HistoryPoint[]; flash?: string;
      };
      setMembers(m.members ?? []);
      setUserStats(m.stats ?? null);
      setHistory(m.history ?? []);
      setAdminReady(true);
      if (m.flash) setAdminFlash(m.flash);
      if (sRes.ok) {
        const s = (await sRes.json()) as { rows?: StripeRow[]; stripe?: boolean };
        setStripeRows(s.rows ?? []);
        setStripeOn(Boolean(s.stripe));
      }
      if (pRes.ok) {
        const p = (await pRes.json()) as {
          sources?: Source[];
          uncovered?: string[];
          keys?: { apify: boolean; anthropic: boolean };
        };
        setSources(p.sources ?? []);
        setUncovered(p.uncovered ?? []);
        setKeys(p.keys ?? { apify: false, anthropic: false });
      }
      if (fRes.ok) {
        const f = (await fRes.json()) as {
          funnel?: { label: string; count: number; rate: number }[];
          signupFunnel?: { label: string; count: number; rate: number }[];
          signups?: { email: string; name: string; phone: string; trade: string; status?: string; createdAt: string }[];
          trades?: { slug: string; views: number; signups: number; rate: number }[];
        };
        setFunnel(f.funnel ?? []);
        setSignupFunnel(f.signupFunnel ?? []);
        setSignups(f.signups ?? []);
        setTradeStats(f.trades ?? []);
      }
      if (tRes.ok) {
        const t = (await tRes.json()) as { threads?: Thread[]; waiting?: number; flash?: string };
        setThreads(t.threads ?? []);
        setWaiting(t.waiting ?? 0);
        if (t.flash) setAdminFlash(t.flash);
      }
      if (uRes.ok) setUsage((await uRes.json()) as Usage);
      const missing = [
        !sRes.ok && "payments",
        !pRes.ok && "pipeline",
        !fRes.ok && "marketing",
        !tRes.ok && "support",
        !uRes.ok && "usage",
      ].filter(Boolean);
      if (missing.length) setAdminError(`Some data did not load: ${missing.join(", ")}.`);
      setAdminTab(target);
    } catch {
      setAdminError("The command centre could not reach RooWatch.");
    } finally {
      setAdminBusy(false);
    }
  }, [funnelDays, usageDays]);

  useEffect(() => {
    if (!me?.isAdmin || adminStarted.current) return;
    adminStarted.current = true;
    setAdminTab("users");
    void loadAdmin("users");
  }, [loadAdmin, me?.isAdmin]);

  async function scanSource(sourceId: number) {
    const res = await fetch("/api/admin/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId }),
    });
    const data = (await res.json().catch(() => ({}))) as { matches?: number; posts?: number; error?: string };
    await loadAdmin("pipeline");
    return { ok: res.ok, ...data } as { ok: boolean; matches?: number; posts?: number; error?: string };
  }

  async function adminCall(path: string, payload: Record<string, unknown>) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    // A refused plan change means Stripe would not move and nothing changed.
    // Saying so out loud beats a silent no-op that looks like it worked.
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      setAdminFlash(d.message || `That did not work (${d.error || res.status}).`);
    }
    await loadAdmin(adminTab ?? "users");
    return res.ok;
  }

  if (!me) return <div className="dash"><style>{CSS}</style><div className="boot">Loading</div></div>;

  if (!me.user) {
    return (
      <div className="dash">
        <style>{CSS}</style>
        <Login />
      </div>
    );
  }

  const needsOnboarding = !me.onboarded && !me.isAdmin;
  /**
   * Nothing in the app used to check whether a member had actually paid.
   * Abandon the Stripe page and you still landed in a working dashboard,
   * free forever. Three of the first four signups did exactly that.
   *
   * past_due is deliberately allowed through. Stripe retries a failed card
   * for days, and locking somebody out over a bank hiccup is how you lose a
   * customer who fully intended to pay.
   */
  const paid = ["trialing", "active", "past_due"].includes(me.subscriptionStatus ?? "");
  // Read fresh every render, so it survives hydration.
  const justBack =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("checkout") === "success";
  /**
   * The card is asked for at the end of setup, not before it.
   *
   * Somebody who has picked their suburbs, had a brief written for them and
   * pasted twenty group links has put real work in, and is a different person
   * at a card form than the stranger who arrived ninety seconds ago. So the
   * wall only goes up once setup is finished, which is also the moment they
   * come back from Stripe having abandoned it.
   */
  const needsCard = !paid && Boolean(me.onboarded) && !me.isAdmin && !me.impersonating;
  const activeAdminTab = adminTab ?? "users";
  const adminNav: { key: AdminTab; label: string; icon: ReactNode }[] = [
    { key: "users", label: "Command centre", icon: I.grid },
    { key: "members", label: "Customers", icon: I.people },
    { key: "support", label: waiting ? `Support (${waiting})` : "Support", icon: I.chat },
    { key: "usage", label: "Usage", icon: I.chart },
    { key: "stripe", label: "Payments", icon: I.card },
    { key: "pipeline", label: "Pipeline", icon: I.flow },
    { key: "funnel", label: "Marketing", icon: I.spark },
  ];

  return (
    <div className="dash">
      <style>{CSS}</style>
      {me.impersonating && (
        <div className="ghost-bar">
          <span>You are signed in as <strong>{me.user.email}</strong>. Anything you change is theirs.</span>
          <button
            onClick={async () => {
              await fetch("/api/admin/impersonate", { method: "DELETE" });
              window.location.href = "/dashboard";
            }}
          >
            Back to my account
          </button>
        </div>
      )}
      {/* Phones only. The sidebar used to wrap into three rows of buttons and
          eat three hundred pixels before a member saw anything. */}
      <header className="topbar">
        <Link className="brand" href="/dashboard">
          <span className="brand-mark">R</span>
          <span>RooWatch</span>
        </Link>
        <button
          className="burger"
          onClick={() => setDrawer(true)}
          aria-label="Open menu"
          aria-expanded={drawer}
        >
          <i /><i /><i />
        </button>
      </header>

      {drawer && (
        <div className="drawer-veil" onClick={() => setDrawer(false)} aria-hidden="true" />
      )}

      <div className={me.isAdmin ? "shell admin-shell" : "shell"}>
        <aside
          className={`${me.isAdmin ? "side side-admin" : "side"}${drawer ? " open" : ""}`}
        >
          <button className="drawer-close" onClick={() => setDrawer(false)} aria-label="Close menu">
            {I.x}
          </button>
          <Link className="brand" href="/dashboard">
            <span className="brand-mark">R</span>
            <span>RooWatch</span>
          </Link>
          <nav className="nav">
            {me.isAdmin ? (
              <>
                <span className="admin-kicker">ROSS ADMIN</span>
                {adminNav.map((item) => (
                  <button key={item.key} className={activeAdminTab === item.key ? "on" : ""} onClick={() => { setAdminTab(item.key); setDrawer(false); }}>
                    {item.icon} {item.label}
                  </button>
                ))}
              </>
            ) : (
              <>
                <button className={tab === "overview" ? "on" : ""} onClick={() => { setTab("overview"); setDrawer(false); }}>{I.grid} Overview</button>
                <button className={tab === "groups" ? "on" : ""} onClick={() => { setTab("groups"); setDrawer(false); }}>{I.eye} Groups watching</button>
                <button className={tab === "alerts" ? "on" : ""} onClick={() => { setTab("alerts"); setDrawer(false); }}>{I.bell} Leads</button>
              </>
            )}
          </nav>
          <div className="side-bottom">
            {!me.isAdmin && <button className={tab === "settings" ? "on" : ""} onClick={() => { setTab("settings"); setDrawer(false); }}>{I.gear} Settings</button>}
            <div className="side-user">
              <Avatar avatar={me.avatar} name={me.user.name || me.user.email} />
              <div className="side-user-meta">
                <strong>{me.isAdmin ? "Ross Admin" : me.user.name || "Member"}</strong>
                <span>{me.user.email}</span>
              </div>
              <button className="logout" title="Log out" onClick={logout}>{I.out}</button>
            </div>
          </div>
        </aside>

        <main className={me.isAdmin ? "main admin-main" : "main"}>
          {me.isAdmin ? (
            <AdminHub
              active={activeAdminTab}
              funnel={funnel} signupFunnel={signupFunnel} signups={signups} tradeStats={tradeStats}
              funnelDays={funnelDays}
              onFunnelDays={(d) => { setFunnelDays(d); loadAdmin("funnel", d); }}
              onLeadStatus={(email, status) => adminCall("/api/admin/funnel", { action: "status", email, status, days: funnelDays })}
              userStats={userStats} history={history} flash={adminFlash} error={adminError} ready={adminReady}
              threads={threads} waiting={waiting}
              usage={usage} usageDays={usageDays}
              onUsageDays={(d) => { setUsageDays(d); loadAdmin("usage", funnelDays, d); }}
              members={members} adminCall={adminCall}
              sources={sources} uncovered={uncovered} keys={keys} onScan={scanSource}
              stripeRows={stripeRows} stripeOn={stripeOn} onRefreshStripe={() => loadAdmin("stripe")} adminBusy={adminBusy}
            />
          ) : (
            <MemberView
              me={me}
              tab={tab}
              leadsView={leadsView}
              setLeadsView={setLeadsView}
              onGo={(next, sub) => { setTab(next); if (sub) setLeadsView(sub); }}
              onLogout={logout}
              onRefresh={refresh}
            />
          )}
        </main>

        {needsCard ? (
          <NeedCard me={me} onRefresh={refresh} onLogout={logout} />
        ) : needsOnboarding ? (
          <Onboarding
            me={me}
            // Only reached by somebody already paying, or if checkout could
            // not be opened. The celebration now fires on the way back from
            // Stripe instead.
            onDone={refresh}
          />
        ) : null}

      </div>

      {/* Where modals are rendered. See Portal below for why. */}
      <div id="roo-modals" />
      {!me.isAdmin && <SupportBubble me={me} onRefresh={refresh} />}
      {/* Stripe redirects the instant the card clears, but its webhook can be a
          second or two behind it. Waiting for `paid` means nobody ever gets
          confetti and a card wall at the same time. */}
      {justBack && paid && !partyDone && (
        <>
          <Confetti onDone={() => {}} />
          <AllSet
            onClose={() => {
              setPartyDone(true);
              const params = new URLSearchParams(window.location.search);
              params.delete("checkout");
              const rest = params.toString();
              window.history.replaceState(
                {},
                "",
                window.location.pathname + (rest ? `?${rest}` : "")
              );
            }}
          />
        </>
      )}
    </div>
  );
}

/**
 * Renders a modal outside the page content.
 *
 * `.page` and `.subpanel` both animate `transform`, and `animation-fill-mode:
 * both` keeps that transform applied after the animation finishes. A
 * transformed ancestor becomes the containing block for anything
 * `position: fixed` inside it, so a full screen overlay was being clipped to
 * the 920px content column instead of covering the window.
 *
 * The host sits inside `.dash`, not on `document.body`, so the CSS variables
 * and every `.dash input` style still reach the modal.
 */
type FeedPost = {
  id: string;
  seenAt: number;
  text: string;
  url: string;
  author: string;
  groupName: string;
};

/**
 * The scan card.
 *
 * The scanner really does run every minute, so this is a picture of something
 * true rather than a decorative spinner: the bar fills across the gap between
 * runs, then the card works through what a pass actually does.
 *
 * It exists because the product is invisible. Between leads there is nothing
 * to look at, and nothing to look at reads as nothing happening.
 */
const SCAN_SECONDS = 60;
const SCAN_STEPS = [
  "Scanning all groups",
  "Reading posts",
  "Updating database",
  "Checking for new leads",
  "Done",
];
const STEP_MS = 1000;

function ScanCard({ watching }: { watching: number }) {
  // step -1 is the wait between passes, 0 upwards walks what a pass does.
  // prev and token live alongside it so the label swap is decided in the one
  // place the step changes, rather than worked out again further down.
  const [phase, setPhase] = useState({ step: -1, prev: "", token: 0 });
  const label = phase.step < 0 ? "Waiting for next scan" : SCAN_STEPS[phase.step];

  useEffect(() => {
    // Nothing to scan, nothing to animate. A bar sweeping across every minute
    // while we watch no groups at all is a lie told once a minute.
    if (!watching) return;
    const last = phase.step >= SCAN_STEPS.length - 1;
    const delay = phase.step < 0 ? SCAN_SECONDS * 1000 : STEP_MS;

    const timer = setTimeout(() => {
      setPhase((p) => {
        const was = p.step < 0 ? "Waiting for next scan" : SCAN_STEPS[p.step];
        // Past the last step it goes back to waiting, and the new token
        // remounts the bar, which is what replays it from empty.
        const step = last ? -1 : p.step + 1;
        return { step, prev: was, token: p.token + 1 };
      });
    }, delay);

    return () => clearTimeout(timer);
  }, [phase.step, phase.token, watching]);

  const working = phase.step >= 0;

  if (!watching) {
    return (
      <div className="tile scan idle">
        <div className="scan-top">
          <span className="scan-face"><span className="scan-still" /></span>
          <span className="scan-idle-label">Nothing to scan yet</span>
        </div>
        <p className="tiny scan-idle-note">Add a group and we start watching within a minute.</p>
      </div>
    );
  }

  return (
    <div className={working ? "tile scan working" : "tile scan"}>
      <div className="scan-top">
        <span className="scan-face">
          {working ? <span className="scan-spin" /> : <span className="scan-dot" />}
        </span>
        <Roll text={label} prev={phase.prev} token={phase.token} />
      </div>
      <div className="scan-track">
        {working ? (
          <i className="scan-full" />
        ) : (
          <i
            key={phase.token}
            className="scan-fill"
            style={{ animationDuration: `${SCAN_SECONDS}s` }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Swaps one line of text for another: the old one rolls down and out of the
 * way, the new one rolls up into its place.
 *
 * Both sit in the box together for the length of the swap. That is the only
 * way to get the old line leaving rather than simply blinking out.
 */
function Roll({ text, prev, token }: { text: string; prev: string; token: number }) {
  return (
    <span className="roll">
      {prev && prev !== text && (
        <span className="roll-out" key={`out-${token}`}>{prev}</span>
      )}
      <span className="roll-in" key={`in-${token}`}>{text}</span>
    </span>
  );
}

/**
 * The posts we have actually read, arriving on screen.
 *
 * A member who has no leads yet has no way of telling whether they are paying
 * for a working machine or a spinner. This is the proof: their own groups,
 * their own posts, the real times we read them.
 *
 * The first load deals them out about three a second rather than dumping the
 * lot, because a page that fills itself in front of you reads as alive and a
 * page that is simply full reads as a screenshot. After that it polls, and
 * anything new slides in at the top and pushes the rest down.
 */
function LiveFeed({ groups, onGo }: {
  groups: Group[];
  onGo: (tab: string, view?: string) => void;
}) {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [shown, setShown] = useState(0);
  const [today, setToday] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const known = useRef(new Set<string>());
  const dealt = useRef(false);

  const watching = groups.filter((g) => g.status === "watching").length;

  useEffect(() => {
    let alive = true;

    async function pull() {
      try {
        // The browser is the only thing that knows the member's timezone, so
        // it tells the server where their day actually starts. Without this a
        // Queensland tradie gets the server's UTC day, which begins at 10am
        // their time and wipes the whole morning.
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        const res = await fetch(
          `/api/member/posts?limit=40&today=1&since=${dayStart.getTime()}`
        );
        const data = (await res.json()) as { posts?: FeedPost[]; today?: number };
        if (!alive) return;
        const rows = data.posts ?? [];
        setToday(data.today ?? 0);
        setPosts(rows);
        setLoaded(true);
        // First run deals them out. Later runs are already on screen, so any
        // new arrival just appears at the top.
        if (!dealt.current) {
          dealt.current = true;
        } else {
          setShown(rows.length);
        }
        rows.forEach((p) => known.current.add(p.id));
      } catch {
        if (alive) setLoaded(true);
      }
    }

    pull();
    const timer = setInterval(pull, 9000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // The deal. One row every 320ms until the list is out.
  useEffect(() => {
    if (!posts.length || shown >= posts.length) return;
    const timer = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 250 : 320);
    return () => clearTimeout(timer);
  }, [posts.length, shown]);

  const visible = posts.slice(0, shown);

  return (
    <div className="card feed">
      <div className="feed-head">
        <div>
          <h3>Posts we are reading</h3>
          <p className="tiny">
            {today > 0
              ? `${today.toLocaleString()} read today across your ${watching} ${watching === 1 ? "group" : "groups"}. None matched yet.`
              : `Watching ${watching} ${watching === 1 ? "group" : "groups"}, day and night.`}
          </p>
        </div>
        <span className="live"><i /> Live</span>
      </div>

      {!loaded ? (
        <div className="feed-wait"><span className="spinner" /> Opening your groups</div>
      ) : visible.length === 0 ? (
        <div className="empty small">
          <p><strong>Nothing read yet today.</strong></p>
          <p className="muted">
            {watching === 0
              ? "Add a group and posts start appearing here."
              : "Your groups are quiet so far. Every new post lands here as we read it."}
          </p>
        </div>
      ) : (
        <div className="feed-rows">
          {visible.map((p) => (
            <a
              className="feed-row"
              key={p.id}
              href={p.url || undefined}
              target="_blank"
              rel="noreferrer"
            >
              <span className="feed-when">{shortTime(p.seenAt)}</span>
              <span className="feed-body">
                <span className="feed-group">{p.groupName}</span>
                <span className="feed-text">{p.text}</span>
              </span>
            </a>
          ))}
        </div>
      )}

      {posts.length > 0 && (
        <button className="feed-more" onClick={() => onGo("alerts", "posts")}>
          See every post we have read
        </button>
      )}
    </div>
  );
}

/**
 * Milliseconds from a stored timestamp, whichever way it was written.
 *
 * onboardedAt comes from toISOString and already carries a Z. Other columns
 * come from SQL CURRENT_TIMESTAMP and carry none, so they need one added or
 * they read as local time. Appending a second Z gives NaN, which is how the
 * first lead strip managed to never appear at all.
 */
function whenMs(value: string | null | undefined): number {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const stamped = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`;
  const ms = Date.parse(stamped);
  return Number.isFinite(ms) ? ms : 0;
}

/** "9:42 am" for something read today, "Tue 4:10 pm" for older. */
function shortTime(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString("en-AU", { weekday: "short" })} ${time}`;
}

/**
 * What to fix, instead of a row of noughts.
 *
 * On day one every number this dashboard owns is zero, which reads as broken.
 * These are the things that actually change how many leads somebody gets, so
 * a quiet day turns into a short list of jobs rather than a wall of failure.
 */
/**
 * Says something before the reading stops, not after.
 *
 * The cap exists for the outlier: the median group posts four times a day and
 * never comes close, but one measured group does seventy four on its own, and
 * a watchlist full of those would cost more than the plan. Somebody heading
 * for the ceiling can pause their noisiest group and keep the rest running,
 * which is a much better month than going quiet on the twentieth.
 */
function UsageWarning({ me, groups, onGo }: {
  me: Me;
  groups: Group[];
  onGo: (tab: string, view?: string) => void;
}) {
  const cap = me.plan?.postsPerMonth ?? 0;
  const used = me.postsUsed ?? 0;
  if (!cap || used < cap * 0.8) return null;

  const done = used >= cap;
  const watching = groups.filter((g) => g.status === "watching").length;

  return (
    <button className={done ? "usage-warn stopped" : "usage-warn"} onClick={() => onGo("groups")}>
      <span>
        <strong>
          {done
            ? "You have hit this month's reading limit"
            : `${Math.round((used / cap) * 100)}% of this month's reading used`}
        </strong>
        <em>
          {done
            ? "Reading starts again on the first. Remove a busy group to make the rest last longer."
            : `${(cap - used).toLocaleString()} posts left across your ${watching} groups. Your busiest group is using most of it.`}
        </em>
      </span>
      <i>Manage groups</i>
    </button>
  );
}

function SetupScore({ me, groups, alerts, onGo }: {
  me: Me;
  groups: Group[];
  alerts: Alert[];
  onGo: (tab: string, view?: string) => void;
}) {
  const limit = me.plan?.groups ?? PLANS.local.groups;
  const watching = groups.filter((g) => g.status === "watching");
  const privates = groups.filter(isPrivate);
  const brief = (me.profile?.brief ?? "").trim();
  const texts = me.profile?.smsEnabled === 1 && Boolean(me.profile?.alertPhone);

  const jobs = [
    {
      key: "private",
      done: privates.length === 0,
      // The one that costs them real leads, so it goes first when it applies.
      label: privates.length
        ? `${privates.length} ${privates.length === 1 ? "group is not public yet" : "groups are not public yet"}`
        : "All groups public",
      go: () => onGo("groups"),
    },
    {
      key: "groups",
      done: watching.length >= limit,
      label: `${watching.length} of ${limit} groups used`,
      go: () => onGo("groups"),
    },
    {
      key: "brief",
      done: brief.length >= 20,
      label: brief.length >= 20 ? "Job brief written" : "Tell us what jobs you want",
      go: () => onGo("settings"),
    },
    {
      key: "texts",
      done: texts,
      label: texts ? "Texts switched on" : "Switch texts on",
      go: () => onGo("settings"),
    },
  ];

  const done = jobs.filter((j) => j.done).length;
  const finished = done === jobs.length;
  if (finished && alerts.length > 0) return null;

  return (
    <div className={finished ? "card score all-done" : "card score"}>
      <div className="score-head">
        <h3>{finished ? "Setup complete" : "Complete your setup"}</h3>
        <span className="score-count">{done} of {jobs.length}</span>
      </div>
      <div className="score-bar"><i style={{ width: `${(done / jobs.length) * 100}%` }} /></div>
      <div className="score-list">
        {jobs.map((j) => (
          <button className={j.done ? "score-row done" : "score-row"} key={j.key} onClick={j.go}>
            <span className="score-mark">{j.done ? I.tick : ""}</span>
            <span className="score-label">{j.label}</span>
            {!j.done && <span className="score-go">Fix</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * How long they have been waiting, against how long it usually takes.
 *
 * Day two is when somebody with no lead yet decides the thing does not work.
 * Saying the number out loud, before they have to ask, is the cheapest way to
 * keep them.
 */
function FirstLead({ me }: { me: Me }) {
  const TARGET_HOURS = 48;
  const started = whenMs(me.profile?.onboardedAt);
  const [nowMs] = useState(() => Date.now());
  if (!started) return null;

  const hours = Math.max(0, (nowMs - started) / 3_600_000);
  // Past the window it stops being reassurance and starts being a full bar
  // telling somebody their lead is late. Nothing at all beats that.
  if (hours >= TARGET_HOURS) return null;

  const pct = Math.min(100, (hours / TARGET_HOURS) * 100);

  return (
    <div className="firstlead">
      <div className="fl-top">
        <div>
          <strong>Your first lead is on its way</strong>
          <p className="tiny">Most tradies get theirs within {TARGET_HOURS} hours of setting up.</p>
        </div>
        <span className="fl-count">{hours < 1 ? "Just started" : `${Math.floor(hours)}h in`}</span>
      </div>
      <div className="fl-track">
        <i style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
    </div>
  );
}

/**
 * Shown to anybody without a card on file.
 *
 * The tone matters here. These are not people who failed at anything, they
 * are people who stopped at the card form and meant to come back. So it does
 * not say "payment failed", it says how close they are and that today is
 * free. The plan and the real dates are spelled out because vagueness at a
 * card form is what makes people leave in the first place.
 *
 * It clears itself. Stripe tells us through the webhook a second or two after
 * the card goes through, so this polls rather than making somebody refresh a
 * page they are already suspicious of.
 */
function NeedCard({ me, onRefresh, onLogout }: {
  me: Me;
  onRefresh: () => void;
  onLogout: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const plan = me.plan ?? PLANS.local;
  // Somebody who once had a subscription is a different conversation from
  // somebody who never started one.
  const lapsed = Boolean(me.subscriptionStatus);

  /**
   * The date the first bill lands, so nobody has to count days in their head.
   * Pinned once, because reading the clock during a render is not allowed and
   * the answer would wobble on every re-render anyway.
   */
  const [billsOn] = useState(() =>
    new Date(Date.now() + TRIAL_DAYS * 864e5).toLocaleDateString("en-AU", {
      day: "numeric",
      month: "long",
    })
  );

  useEffect(() => {
    // Catches the member who pays in another tab, and covers the second or
    // two between Stripe taking the card and the webhook reaching us.
    const timer = setInterval(onRefresh, 4000);
    return () => clearInterval(timer);
  }, [onRefresh]);

  async function pay() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: plan.key }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string };
      if (!data.url) {
        setError("We could not open the payment page. Please try again.");
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("We could not open the payment page. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div className="overlay">
        <div className="modal needcard">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="needcard-roo" src="/roowatch-mascot-3d-binos.png" alt="" />
          <h2>{lapsed ? "Your plan has stopped" : "One last step"}</h2>
          <p className="muted">
            {lapsed
              ? "We have stopped watching your groups. Put a card back on to start again."
              : `Add your card and we start watching your groups straight away. Nothing is charged for ${TRIAL_DAYS} days.`}
          </p>

          <div className="needcard-plan">
            <div className="needcard-row">
              <span>{plan.name} plan</span>
              <strong>{plan.groups} groups</strong>
            </div>
            <div className="needcard-row">
              <span>Today</span>
              <strong className="free">$0</strong>
            </div>
            <div className="needcard-row">
              <span>Free until</span>
              <strong>{billsOn}</strong>
            </div>
            <div className="needcard-row muted-row">
              <span>Then</span>
              <span>${plan.priceAud} a month. Cancel any time.</span>
            </div>
          </div>

          {error && <p className="error">{error}</p>}
          <button className="btn primary wide" disabled={busy} onClick={pay}>
            {busy ? "Opening" : lapsed ? "Start my plan again" : `Start my ${TRIAL_DAYS} day free trial`}
          </button>
          <button className="needcard-out" onClick={onLogout}>Log out</button>
        </div>
      </div>
    </Portal>
  );
}

/**
 * The first thing a member sees after setup.
 *
 * The worry at this moment is "what do I do now?". The answer is nothing, so
 * the popup says exactly that. The kangaroo is here because a wall of text is
 * a poor reward for finishing.
 */
function AllSet({ onClose }: { onClose: () => void }) {
  return (
    <Portal>
      <div className="overlay" onClick={onClose}>
        <div className="modal allset" onClick={(e) => e.stopPropagation()}>
          {/* One fixed size, so Next's optimiser adds nothing here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="allset-roo" src="/roowatch-mascot-3d.png" alt="RooWatch kangaroo waving" />
          <h2>Congratulations, you are all set up</h2>
          <p className="muted">
            We are watching your groups now. You do not need to do anything.
            As soon as we find a lead we send you a text and an email with a
            link straight to the post.
          </p>
          <button className="btn primary wide" onClick={onClose}>Sounds good</button>
        </div>
      </div>
    </Portal>
  );
}

/**
 * Confetti, once, when a member finishes setup.
 *
 * Hand rolled rather than a library: this ships inside the dashboard bundle
 * that every member loads on every visit, and a few dozen divs are not worth
 * a dependency. Pieces are generated once in state, never during render, so
 * the component stays pure and does not reshuffle on every re-render.
 */
function Confetti({ onDone }: { onDone: () => void }) {
  const [pieces] = useState(() =>
    Array.from({ length: 70 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 900,
      fall: 2600 + Math.random() * 2200,
      drift: (Math.random() - 0.5) * 140,
      spin: 360 + Math.random() * 720,
      size: 7 + Math.random() * 7,
      round: Math.random() > 0.65,
      tone: ["#ff6a4d", "#2eaa81", "#f5c451", "#111d36", "#f04f31"][i % 5],
    }))
  );

  useEffect(() => {
    const timer = setTimeout(onDone, 5200);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <Portal>
      <div className="confetti" aria-hidden="true">
        {pieces.map((p) => (
          <i
            key={p.id}
            style={{
              left: `${p.left}%`,
              width: `${p.size}px`,
              height: `${p.size * (p.round ? 1 : 1.6)}px`,
              background: p.tone,
              borderRadius: p.round ? "99px" : "2px",
              animationDelay: `${p.delay}ms`,
              animationDuration: `${p.fall}ms`,
              ["--drift" as string]: `${p.drift}px`,
              ["--spin" as string]: `${p.spin}deg`,
            }}
          />
        ))}
      </div>
    </Portal>
  );
}

function Portal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  const host = document.getElementById("roo-modals");
  return host ? createPortal(children, host) : <>{children}</>;
}

function Avatar({ avatar, name }: { avatar?: string; name: string }) {
  // Avatar values are member-uploaded data URLs, so Next's remote image
  // optimizer cannot safely handle them.
  // eslint-disable-next-line @next/next/no-img-element
  if (avatar) return <img className="avatar-img" src={avatar} alt="" />;
  const initials = name.replace(/@.*/, "").split(/[ .]/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return <span className="avatar-fallback">{initials || "R"}</span>;
}

/** Log in and sign up both live on /signup now, so send people there. */
function Login() {
  useEffect(() => {
    window.location.replace("/signup?mode=login");
  }, []);

  return (
    <div className="login">
      <div className="login-card">
        <Link className="brand brand-dark" href="/">
          <span className="brand-mark">R</span>
          <span>RooWatch</span>
        </Link>
        <h1>Taking you to the login page</h1>
        <p className="muted">One moment.</p>
        <Link className="btn primary wide" href="/signup?mode=login">Log in</Link>
      </div>
    </div>
  );
}

type WizardGroup = { url: string; name: string; members?: number };
type Stage = "business" | "trade" | "suburbs" | "jobs" | "groups" | "review";
const STAGES: Stage[] = ["business", "trade", "suburbs", "jobs", "groups", "review"];

type Draft = {
  stage?: Stage;
  state?: string;
  website?: string;
  gbpUrl?: string;
  businessName?: string;
  services?: string;
  trade?: string;
  tradeOther?: string;
  suburbs?: string[];
  brief?: string;
  groups?: WizardGroup[];
  logo?: string;
};

/** Whatever they had typed last time, or nothing if this is their first go. */
function readDraft(raw: string | null | undefined): Draft {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Draft;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A draft we cannot read is not worth blocking setup over.
    return {};
  }
}

function Onboarding({ me, onDone }: { me: Me; onDone: () => void }) {
  const known = me.profile;
  // Read once. Later saves must not pull the member back to an older step.
  const [draft] = useState(() => readDraft(known?.wizardDraft));
  const [state, setState] = useState(draft.state ?? known?.state ?? "");
  const [stage, setStage] = useState<Stage>(
    draft.stage && STAGES.includes(draft.stage) ? draft.stage : "business"
  );

  const [website, setWebsite] = useState(draft.website ?? known?.website ?? "");
  const [gbpUrl] = useState(draft.gbpUrl ?? known?.gbpUrl ?? "");
  const [businessName, setBusinessName] = useState(draft.businessName ?? known?.businessName ?? "");
  const [services, setServices] = useState(draft.services ?? known?.services ?? "");
  const [trade, setTrade] = useState(draft.trade ?? known?.trade ?? "");
  const [tradeOther, setTradeOther] = useState(draft.tradeOther ?? "");
  const [suburbs, setSuburbs] = useState<string[]>(draft.suburbs ?? []);
  const [brief, setBrief] = useState(draft.brief ?? known?.brief ?? "");
  const [groupList, setGroupList] = useState<WizardGroup[]>(draft.groups ?? []);

  const [logo, setLogo] = useState(draft.logo ?? "");
  const [scanning, setScanning] = useState(false);
  const [thinking, setThinking] = useState(false);
  const briefTried = useRef(Boolean(draft.brief));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [help, setHelp] = useState(false);
  // The paste box stays out of the way. Twenty groups arrive on their own, so
  // asking a tradie for a Facebook link makes an automatic step look manual.
  const [manual, setManual] = useState(false);

  const chosenTrade = trade === OTHER_TRADE ? tradeOther.trim() : trade;
  const planGroups = me.plan?.groups ?? PLANS.local.groups;
  // The page behind the wizard was still scrolling under the overlay on a
  // phone, so a tradie mid setup could drag the dashboard around behind it.
  // overscroll-behavior on .overlay stops the scroll chaining; this stops the
  // page moving at all.
  useEffect(() => {
    const html = document.documentElement;
    const prevHtml = html.style.overflow;
    const prevBody = document.body.style.overflow;
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
    };
  }, []);

  const step = STAGES.indexOf(stage);

  function say(message: string) {
    setToast(message);
  }

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  /**
   * Keep the server copy up to date, a moment after they stop typing.
   *
   * The wizard used to live only in the browser. A member pasted ten group
   * links, closed the tab, and every one of them was gone. The wait is there
   * so a long brief is one save and not one per keystroke.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      fetch("/api/onboarding/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draft: {
            stage,
            state,
            website,
            gbpUrl,
            businessName,
            services,
            trade,
            tradeOther,
            suburbs,
            brief,
            groups: groupList,
            logo,
          },
        }),
        keepalive: true,
      }).catch(() => {
        // Losing one save is fine. The next change writes the lot again.
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [stage, state, website, gbpUrl, businessName, services, trade, tradeOther, suburbs, brief, groupList, logo]);

  /** Step 1. Read the website and the Google listing, then move on. */
  async function scan() {
    setScanning(true);
    setNote("");
    try {
      const res = await fetch("/api/onboarding/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ website, gbpUrl }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        businessName?: string;
        trade?: string;
        state?: string;
        suburbs?: string[];
        services?: string;
        logo?: string;
        note?: string;
        error?: string;
      };
      if (data.logo) setLogo(data.logo);
      if (data.businessName && !businessName) setBusinessName(data.businessName);
      if (data.services && !services) setServices(data.services);
      if (data.trade) setTrade(data.trade);
      // The website names the suburbs, the gazetteer names the state. Between
      // them the whole suburbs step is filled in before it is ever seen.
      if (data.state) setState(data.state);
      if (data.suburbs?.length) setSuburbs(data.suburbs);
      setNote(
        data.error === "bad_website"
          ? "That web address does not look right. You can fill the rest in yourself."
          : data.note ?? ""
      );
    } catch {
      setNote("We could not read your website. You can fill the rest in yourself.");
    } finally {
      // A short pause so the message is readable and the jump is not jarring.
      setTimeout(() => {
        setScanning(false);
        setStage("trade");
      }, 900);
    }
  }

  /** Step 4. Ask Claude for the job brief, once, when the member arrives. */
  const askForBrief = useCallback(async () => {
    setThinking(true);
    try {
      const res = await fetch("/api/member/brief-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName,
          website,
          services,
          trade: chosenTrade,
          location: suburbs.join(", "),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { brief?: string };
      if (data.brief) setBrief(data.brief);
    } catch {
      // The member writes it themselves. The placeholder shows them how.
    } finally {
      setThinking(false);
    }
  }, [businessName, website, services, chosenTrade, suburbs]);

  /** Move on. Arriving at the jobs step starts the draft, once. */
  function goNext() {
    const next = STAGES[step + 1];
    if (next === "jobs" && !brief.trim() && !briefTried.current) {
      briefTried.current = true;
      askForBrief();
    }
    setStage(next);
  }

  const [finding, setFinding] = useState(false);
  const filled = useRef(false);

  /**
   * Add a whole batch in one go.
   *
   * Not a loop over addGroup: each of those reads the current list from the
   * closure it was created in, so eight of them all see the same empty list
   * and the last write wins. Everything is checked first, then the list is
   * written once.
   */

  /**
   * Fill their watchlist for them.
   *
   * A tradie should never hunt around Facebook copying links. We know their
   * suburbs, so the moment they reach this step we go and get the groups and
   * put them straight in. They rename, delete, add their own, and carry on.
   * Runs once, so coming back to the step never undoes their edits.
   */
  useEffect(() => {
    if (stage !== "groups" || filled.current) return;
    filled.current = true;
    setFinding(true);
    fetch("/api/onboarding/suggest-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, suburbs }),
    })
      .then((r) => r.json())
      .then((d: { groups?: { name: string; url: string; members?: number }[] }) => {
        setGroupList((have) => {
          const room = Math.min(planGroups, 20) - have.length;
          if (room <= 0) return have;
          const fresh = (d.groups ?? [])
            .filter((g) => !have.some((h) => h.url === g.url))
            .slice(0, room)
            .map((g) => ({ url: g.url, name: g.name, members: g.members ?? 0 }));
          return [...have, ...fresh];
        });
      })
      .catch(() => {})
      .finally(() => setFinding(false));
  }, [stage, state, suburbs, planGroups]);

  async function addGroup(raw: string) {
    const parsed = parseGroupInput(raw);
    if (!parsed?.url) return false;
    if (groupList.some((g) => g.url === parsed.url)) {
      say("This group is already on your list");
      return false;
    }
    if (groupList.length >= planGroups) {
      say(`Your plan covers ${planGroups} groups`);
      return false;
    }
    // Turn a private group away here rather than let somebody finish setup
    // and wonder for a week why that one never sends anything.
    try {
      const res = await fetch("/api/onboarding/check-group", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: parsed.url }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (data.error === "private") {
          say("Public groups only for now");
          return false;
        }
      }
    } catch {
      // If the check itself fails, let them add it. The scan settles it.
    }
    setGroupList([...groupList, { url: parsed.url, name: parsed.name }]);
    say("Group added");
    return true;
  }

  /**
   * Save everything, then send them to Stripe.
   *
   * The order matters. Saving first creates their sources, and those are
   * written an hour behind so the very next scan picks them up. That scan
   * runs while they are on the card page, so by the time they come back
   * their own groups already have posts in them.
   */
  async function finish() {
    setBusy(true);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName,
          website,
          gbpUrl,
          trade: chosenTrade,
          services,
          // Asked in setup now, not at signup, and the suburb list is filtered
          // by it, so it has to be saved with everything else.
          state,
          suburbs,
          brief,
          groups: groupList.map((g) => g.url),
        }),
      });
      if (!res.ok) {
        setNote("We could not save that. Please check every step and try again.");
        return;
      }

      // Already paying, so there is nothing to check out. Straight through.
      if (me.subscriptionStatus) {
        onDone();
        return;
      }

      // Setup is saved and they are on their way to the card. This is the
      // real registration: suburbs picked, brief written, groups pasted.
      // Fired before the checkout call rather than after it, so the beacon
      // has the whole round trip to leave before the page navigates away.
      startPixel();
      (window as unknown as { fbq?: Pixel }).fbq?.("track", "CompleteRegistration", {
        content_name: "RooWatch setup finished",
        value: me.plan?.priceAud ?? 197,
        currency: "AUD",
      });

      const checkout = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: me.plan?.key ?? "local" }),
      });
      const session = (await checkout.json().catch(() => ({}))) as { url?: string };
      if (!session.url) {
        // Their setup is saved either way, so send them to the dashboard and
        // let the card screen there ask again.
        onDone();
        return;
      }
      window.location.href = session.url;
    } finally {
      setBusy(false);
    }
  }

  const canGo: Record<Stage, boolean> = {
    business: Boolean(website.trim()),
    trade: chosenTrade.length > 1,
    suburbs: state.length > 1 && suburbs.length > 0,
    jobs: brief.trim().length >= BRIEF_MIN && brief.trim().length <= BRIEF_MAX,
    // At least one, always. Five of the first seven paying members finished
    // setup with none and were watching nothing, which is a customer paying
    // for silence. The suggestions below keep this from costing a card.
    groups: groupList.length > 0,
    review: true,
  };

  return (
    <div className="overlay">
      <div className="modal modal-wide">
        {scanning && (
          <div className="scan-veil">
            <span className="spinner big" />
            <strong>Getting your business info</strong>
            <p className="muted">We are reading your website. This takes a few seconds.</p>
          </div>
        )}

        {logo && (
          <div className="wiz-brand">
            {/* Their own logo, hotlinked from their site. If it will not load we
                drop it rather than show a broken image on their first screen. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="wiz-logo" src={logo} alt="" onError={() => setLogo("")} />
            <span>{businessName || "Your business"}</span>
          </div>
        )}

        <div className="wiz-top">
          <div className="steps-dots">
            {STAGES.map((s, i) => (
              <span key={s} className={i === step ? "dot on" : i < step ? "dot done" : "dot"} />
            ))}
          </div>
          {stage === "groups" && (
            <button className="help-dot" onClick={() => setHelp(true)} aria-label="How to find groups">
              ?
            </button>
          )}
        </div>

        <div className="wiz-body">
        {stage === "business" && (
          <>
            <h2>Enter your website</h2>
            <p className="muted">We read it to work out your trade and your suburbs. It saves you the typing.</p>
            <label className="lbl">Your website <span className="req">*</span></label>
            <input placeholder="https://mybusiness.com.au" value={website} onChange={(e) => setWebsite(e.target.value)} autoFocus />
          </>
        )}

        {stage === "trade" && (
          <>
            <h2>What is your trade?</h2>
            <p className="muted">This helps us pick out the posts meant for you.</p>
            {note && <p className="warn-line">{note}</p>}
            <label className="lbl">Your trade <span className="req">*</span></label>
            <select value={trade} onChange={(e) => setTrade(e.target.value)}>
              <option value="">Pick your trade</option>
              {TRADES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
              <option value={OTHER_TRADE}>{OTHER_TRADE}</option>
            </select>
            {trade === OTHER_TRADE && (
              <>
                <label className="lbl">Tell us your trade</label>
                <input placeholder="Blind and curtain fitting" value={tradeOther} onChange={(e) => setTradeOther(e.target.value)} autoFocus />
              </>
            )}
            <p className="tiny">We picked this from your website. Change it if we got it wrong.</p>
          </>
        )}

        {stage === "suburbs" && (
          <>
            <h2>Where do you work?</h2>
            <p className="muted">Pick the suburbs you drive to. We only send you jobs from these areas.</p>
            <label className="lbl">Your state <span className="req">*</span></label>
            <select
              value={state}
              onChange={(e) => { setState(e.target.value); setSuburbs([]); }}
            >
              <option value="">Pick your state</option>
              {STATES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            {state && <SuburbPicker state={state} chosen={suburbs} onChange={setSuburbs} onSay={say} />}
          </>
        )}

        {stage === "jobs" && (
          <>
            <h2>What jobs do you want?</h2>
            <p className="muted">
              {chosenTrade ? `You are ${aOrAn(chosenTrade)}. ` : ""}
              We wrote a first draft. Change it so it sounds like your work.
            </p>
            {thinking ? (
              <div className="think">
                <span className="spinner" />
                <span>Working out your best jobs</span>
              </div>
            ) : (
              <>
                <textarea
                  rows={8}
                  placeholder="Home electrical jobs. Emergency call outs, switchboard repairs, new power points. Skip solar and new builds."
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                />
                <div className="count-row">
                  <p className="tiny">Say what you want and what to skip. This is what we look for.</p>
                  <span className={brief.trim().length > BRIEF_MAX ? "counter over" : "counter"}>
                    {brief.trim().length} / {BRIEF_MAX}
                  </span>
                </div>
                <button className="ai-btn small" onClick={askForBrief}>
                  <span className="ai-face">{I.spark} Write it again</span>
                </button>
              </>
            )}
          </>
        )}

        {stage === "groups" && (
          <>
            <h2>
              {finding
                ? "Finding your groups"
                : groupList.length
                ? `${groupList.length} groups added for you`
                : "Public groups only"}
            </h2>
            <p className="muted">
              {finding
                ? `Searching ${suburbs.slice(0, 3).join(", ") || "your area"} for local groups.`
                : groupList.length
                ? "We picked these from your suburbs. Rename, delete or add your own, then carry on."
                : "Private group scanning is coming soon. Paste a public group link to get started."}
            </p>
            <GroupTable rows={groupList} onChange={setGroupList} onSay={say} filling={finding} />
            <p className="tiny">
              {finding
                ? "This takes a few seconds."
                : groupList.length === 0
                ? "Add at least one group to finish."
                : `${groupList.length} of ${planGroups} groups. Edit or delete any you do not want.`}
            </p>

            {/* Opened for them when we found nothing, so the screen is never a
                dead end. Otherwise it waits to be asked for. */}
            {manual || (!finding && groupList.length === 0) ? (
              <div className="manual-open">
                <GroupAdder onAdd={addGroup} />
              </div>
            ) : (
              !finding && (
                <button className="manual-link" onClick={() => setManual(true)}>
                  Enter groups manually
                </button>
              )
            )}
          </>
        )}

        {stage === "review" && (
          <>
            <h2>All set. Have a quick look.</h2>
            <p className="muted">Change anything later in Settings.</p>
            <div className="review">
              <div className="kv"><span>Trade</span><strong>{chosenTrade || "not set"}</strong></div>
              <div className="kv"><span>Suburbs</span><strong>{suburbs.join(", ") || "not set"}</strong></div>
              <div className="kv"><span>Groups</span><strong>{groupList.length} to watch</strong></div>
            </div>
            <label className="lbl">The jobs you want</label>
            <p className="review-brief">{brief}</p>
            {note && <p className="error">{note}</p>}
          </>
        )}

        </div>
        <div className="row spread">
          {step > 0 ? (
            <button className="btn ghost" onClick={() => setStage(STAGES[step - 1])}>Back</button>
          ) : (
            <span className="tiny">{me.user!.email}</span>
          )}
          {stage === "business" ? (
            <button className="btn primary" disabled={!canGo.business || scanning} onClick={scan}>Continue</button>
          ) : stage === "review" ? (
            <button className="btn primary" disabled={busy} onClick={finish}>{busy ? "Saving" : "Start scanning"}</button>
          ) : (
            <button className="btn primary" disabled={!canGo[stage] || thinking} onClick={goNext}>Continue</button>
          )}
        </div>

        {toast && <div className="toast">{I.tick} {toast}</div>}
        {help && <GroupHelp onClose={() => setHelp(false)} />}
      </div>
    </div>
  );
}

/** Search and pick suburbs. Anything they type is allowed, list or not. */
function SuburbPicker({ state, chosen, onChange, onSay }: {
  state: string;
  chosen: string[];
  onChange: (next: string[]) => void;
  onSay: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const all = useMemo(() => suburbsFor(state), [state]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return all
      .filter((s) => s.toLowerCase().includes(q) && !chosen.includes(s))
      .slice(0, 8);
  }, [query, all, chosen]);

  function add(name: string) {
    const clean = name.trim();
    if (!clean) return;
    if (chosen.some((s) => s.toLowerCase() === clean.toLowerCase())) {
      onSay("That suburb is already on your list");
      setQuery("");
      return;
    }
    if (chosen.length >= 20) {
      onSay("20 suburbs is the most we can watch");
      return;
    }
    onChange([...chosen, clean]);
    setQuery("");
  }

  return (
    <div className="picker">
      <input
        placeholder="Type a suburb, for example Fremantle"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          add(matches[0] ?? query);
        }}
      />
      {matches.length > 0 && (
        <div className="picker-list">
          {matches.map((s) => (
            <button key={s} className="picker-opt" onClick={() => add(s)}>{s}</button>
          ))}
        </div>
      )}
      {query.trim() && matches.length === 0 && (
        <div className="picker-list">
          <button className="picker-opt" onClick={() => add(query)}>
            Add &ldquo;{query.trim()}&rdquo;
          </button>
        </div>
      )}
      {chosen.length > 0 && (
        <div className="chips">
          {chosen.map((s) => (
            <span key={s} className="chip pop">
              {s}
              <button onClick={() => onChange(chosen.filter((x) => x !== s))} aria-label={`Remove ${s}`}>&times;</button>
            </span>
          ))}
        </div>
      )}
      <p className="tiny">
        {chosen.length === 0
          ? "Pick at least one suburb."
          : `${chosen.length} picked. Add more to catch more jobs.`}
      </p>
    </div>
  );
}

/** The add box, with a live tick or cross so nobody pastes the wrong thing. */
function GroupAdder({ onAdd }: { onAdd: (raw: string) => Promise<boolean> }) {
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const typed = value.trim();
  const good = Boolean(groupSlug(typed));
  const bad = typed.length > 0 && !good;

  async function submit() {
    if (!good || checking) return;
    setChecking(true);
    try {
      if (await onAdd(typed)) setValue("");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="adder">
      <label className="lbl">Paste a Facebook group link</label>
      <div className="adder-row">
        <div className={bad ? "adder-input bad" : good ? "adder-input good" : "adder-input"}>
          <input
            placeholder="https://facebook.com/groups/123456789/"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          {good && <span className="mark ok">{I.tick}</span>}
          {bad && <span className="mark no">&times;</span>}
        </div>
        <button className="btn primary" disabled={!good || checking} onClick={submit}>{checking ? "Checking" : "Add group"}</button>
      </div>
      {bad && (
        <p className="error">
          Paste the whole link. It has to look like facebook.com/groups/123456789/
        </p>
      )}
    </div>
  );
}

/**
 * The watchlist during setup: rename, delete, and how big each group is.
 *
 * Rows slide in one after another as the list fills, so a member watches it
 * being built rather than staring at a spinner.
 */
/**
 * One row per group: the name, how it is going, and a menu.
 *
 * The slug used to sit under every name. It is a meaningless string of digits
 * to a tradie, so it is gone. The status runs through finding, adding and
 * added rather than sitting on a spinner, because a spinner that never
 * resolves reads as broken.
 */
function GroupRow({ group, index, onRename, onDelete }: {
  group: WizardGroup;
  index: number;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const STEPS = ["Finding group", "Adding group", "Group added"];
  const [step, setStep] = useState(0);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);

  useEffect(() => {
    if (step >= STEPS.length - 1) return;
    const timer = setTimeout(() => setStep((n) => n + 1), 700);
    return () => clearTimeout(timer);
  }, [step]);

  const done = step >= STEPS.length - 1;

  return (
    <tr className="wiz-row" style={{ animationDelay: `${Math.min(index, 20) * 70}ms` }}>
      <td>
        {editing ? (
          <input
            className="row-edit"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { onRename(draft); setEditing(false); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onRename(draft); setEditing(false); }
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <div className="g-name">
            <span className={done ? "g-tick on" : "g-tick"}>{I.tick}</span>
            <strong>{group.name}</strong>
          </div>
        )}
      </td>
      <td className="size-cell">
        {done ? (
          <span className="state-pill done">{I.tick} Added</span>
        ) : (
          <span className="state-pill" key={step}>{STEPS[step]}</span>
        )}
      </td>
      <td className="act-cell">
        <div className="row-menu">
          <button
            className="dots"
            onClick={() => setMenu(!menu)}
            aria-label="Group options"
            aria-expanded={menu}
          >
            <i /><i /><i />
          </button>
          {menu && (
            <>
              <div className="menu-veil" onClick={() => setMenu(false)} />
              <div className="menu-pop">
                <button onClick={() => { setDraft(group.name); setEditing(true); setMenu(false); }}>
                  Rename
                </button>
                <button className="danger" onClick={() => { setMenu(false); onDelete(); }}>
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

/** The watchlist during setup. Rows slide in as the list fills. */
function GroupTable({ rows, onChange, onSay, filling }: {
  rows: WizardGroup[];
  onChange: (next: WizardGroup[]) => void;
  onSay: (message: string) => void;
  filling?: boolean;
}) {
  if (rows.length === 0) {
    return filling ? (
      <div className="empty tight">
        <span className="spinner" />
        <p className="muted">Looking for groups near you.</p>
      </div>
    ) : (
      <div className="empty tight">
        <p><strong>No groups yet.</strong></p>
        <p className="muted">Paste a link above and we start watching it the moment you finish.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="wiz-table">
        <tbody>
          {rows.map((g, i) => (
            <GroupRow
              key={g.url}
              group={g}
              index={i}
              onRename={(name) => {
                if (name.trim().length < 2) return;
                onChange(rows.map((r) => (r.url === g.url ? { ...r, name: name.trim() } : r)));
                onSay("Name saved");
              }}
              onDelete={() => {
                onChange(rows.filter((r) => r.url !== g.url));
                onSay("Group removed");
              }}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupHelp({ onClose }: { onClose: () => void }) {
  return (
    <Portal>
    <div className="overlay inner" onClick={onClose}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="help-head">
          <h2>How to find your local groups</h2>
          <button className="mini" onClick={onClose}>Close</button>
        </div>

        <ol className="help-steps">
          <li>
            <strong>Search Facebook for groups near you.</strong>
            <p className="muted">Try your suburb name with these words.</p>
            <div className="mock search">
              <span className="mock-ico">{I.eye}</span>
              <span>Fremantle locals</span>
            </div>
            <p className="tiny">Also try: &ldquo;[your suburb] community&rdquo;, &ldquo;[your suburb] buy swap sell&rdquo;, &ldquo;[your area] tradies&rdquo;.</p>
          </li>
          <li>
            <strong>Check it says Public group.</strong>
            <p className="muted">Look under the group name on Facebook. We can only read public groups for now.</p>
          </li>
          <li>
            <strong>Join the group.</strong>
            <p className="muted">Press Join on the group page. Wait for the admin to let you in.</p>
          </li>
          <li>
            <strong>Copy the whole link.</strong>
            <p className="muted">Open the group. Copy everything in the address bar at the top.</p>
            <div className="mock bar">
              <span className="mock-lock">{I.shield}</span>
              <span className="mock-url">https://www.facebook.com/groups/<b>123456789</b>/</span>
            </div>
          </li>
          <li>
            <strong>Paste it here.</strong>
            <p className="muted">Paste it in the box and press Add group.</p>
          </li>
        </ol>

        <div className="help-warn">
          <p><span className="no-mark">&times;</span> The group name on its own will not work.</p>
          <p><span className="no-mark">&times;</span> Private groups do not work yet.</p>
          <p><span className="yes-mark">{I.tick}</span> Paste the whole link: https://facebook.com/groups/123456789/</p>
        </div>

        <button className="btn primary wide" onClick={onClose}>Got it</button>
      </div>
    </div>
    </Portal>
  );
}

/** Email always goes. Texts are the member's choice. */
function LeadDelivery({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  const plan = me.plan ?? PLANS.local;
  const phone = me.profile?.alertPhone ?? "";
  const [texts, setTexts] = useState(Boolean(me.profile?.smsEnabled));
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !texts;
    setTexts(next);
    setBusy(true);
    try {
      await fetch("/api/member/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smsEnabled: next }),
      });
      onRefresh();
    } catch {
      setTexts(!next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>Where your leads go</h3>
      <div className="group-row">
        <span className="group-name">Email ({me.user!.email})</span>
        <span className="chip-status ok">Always on</span>
      </div>
      <div className="group-row">
        <span className="group-name">
          Text message {phone ? `(${phone})` : ""}
          {!phone && <span className="tiny block">Add your mobile above to turn this on.</span>}
        </span>
        <button
          className={texts && phone ? "switch on" : "switch"}
          disabled={busy || !phone}
          aria-pressed={texts && Boolean(phone)}
          onClick={toggle}
        >
          <i />
        </button>
      </div>
      {texts && phone && (
        <div className="kv">
          <span>Texts this month</span>
          <strong>{(me.smsUsed ?? 0).toLocaleString()} of {plan.smsPerMonth.toLocaleString()}</strong>
        </div>
      )}
      <p className="tiny">
        Every lead is emailed to you, always. A text is the quick nudge so you see it while
        you are on the tools. Past your monthly texts you still get every lead by email.
      </p>
    </div>
  );
}

function PasswordCard({ hasPassword, onRefresh }: { hasPassword: boolean; onRefresh: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const ready = next.length >= 8 && (!hasPassword || current.length > 0);

  async function save() {
    setBusy(true);
    setError("");
    setDone(false);
    try {
      const res = await fetch("/api/member/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: next, currentPassword: current }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setError(
          d.error === "wrong_password"
            ? "That is not your current password."
            : d.message || "Could not save that."
        );
        return;
      }
      setCurrent("");
      setNext("");
      setDone(true);
      onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3>Password</h3>
      <p className="muted">
        {hasPassword
          ? "Change the password you log in with."
          : "You log in with an email link. Set a password to skip that step."}
      </p>
      {hasPassword && (
        <>
          <label className="lbl">Current password</label>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </>
      )}
      <label className="lbl">{hasPassword ? "New password" : "Your password"}</label>
      <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ready && save()} />
      <p className="tiny">8 letters or more.</p>
      {error && <p className="error">{error}</p>}
      {done && <p className="flash">Password saved.</p>}
      <button className="btn primary mt" disabled={!ready || busy} onClick={save}>
        {busy ? "Saving" : hasPassword ? "Change password" : "Set password"}
      </button>
    </div>
  );
}

/** "a plumber" but "an electrician". */
function aOrAn(word: string) {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word.toLowerCase()}`;
}

function MemberView({ me, tab, leadsView, setLeadsView, onGo, onLogout, onRefresh }: {
  me: Me;
  tab: string;
  leadsView: "leads" | "posts";
  setLeadsView: (v: "leads" | "posts") => void;
  onGo: (tab: string, sub?: "leads" | "posts") => void;
  onLogout: () => void;
  onRefresh: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const groups = me.groups ?? [];
  const alerts = me.alerts ?? [];
  const user = me.user!;
  const plan = me.plan ?? PLANS.local;

  async function pickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const dataUrl = await shrinkImage(f);
    await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatar: dataUrl }),
    });
    onRefresh();
  }

  if (tab === "overview") {
    const firstName = (user.name || "").split(" ")[0];
    // Counted from the first of the month where the member is, not where the
    // server is. Same reason the ticker takes its day start from the browser.
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const leadsThisMonth = alerts.filter(
      (a) => whenMs(a.sentAt) >= monthStart.getTime()
    ).length;
    const watchingGroupCount = groups.filter((group) => group.status === "watching").length;
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>G&apos;day{firstName ? `, ${firstName}` : ""}</h1>
            <p className="muted">Your leads land here and on your phone.</p>
          </div>
          <span className="live"><i /> Watching live</span>
        </header>
        <UsageWarning me={me} groups={groups} onGo={onGo} />

        {alerts.length === 0 && <FirstLead me={me} />}

        <div className="tiles">
          <button className="tile tap" onClick={() => onGo("groups")}><span className="tile-num">{watchingGroupCount}/{plan.groups}</span><span className="tile-label">Groups watching</span></button>
          <button className="tile tap" onClick={() => onGo("alerts", "leads")}><span className="tile-num">{leadsThisMonth}</span><span className="tile-label">Leads this month</span></button>
          <button className="tile tap" onClick={() => onGo("alerts", "posts")}><span className="tile-num">{(me.postsUsed ?? 0).toLocaleString()}</span><span className="tile-label">Posts read this month</span></button>
          <ScanCard watching={groups.filter((g) => g.status === "watching").length} />
        </div>

        <div className="ov-split">
          <LiveFeed groups={groups} onGo={onGo} />
          <div className="ov-side">
            <SetupScore me={me} groups={groups} alerts={alerts} onGo={onGo} />
            <div className="card">
              <h3>Latest leads</h3>
              {alerts.length === 0 ? (
                <div className="empty small">
                  <p className="muted">Nothing yet. The moment a job comes up we text you.</p>
                </div>
              ) : (
                alerts.slice(0, 3).map((a) => <AlertRow key={a.id} alert={a} />)
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (tab === "groups") {
    return <GroupsTab groups={groups} limit={plan.groups} onRefresh={onRefresh} />;
  }

  if (tab === "alerts") return <LeadsPage me={me} view={leadsView} setView={setLeadsView} />;

  return (
    <div className="page">
      <header className="page-head"><div><h1>Settings</h1><p className="muted">Your account and your plan.</p></div></header>
      <div className="card">
        <h3>Profile</h3>
        <div className="profile-row">
          <Avatar avatar={me.avatar} name={user.name || user.email} />
          <button className="btn ghost" onClick={() => fileRef.current?.click()}>Change photo</button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickAvatar} />
        </div>
        <div className="kv"><span>Email</span><strong>{user.email}</strong></div>
      </div>
      <ProfileForm me={me} onRefresh={onRefresh} />
      <PasswordCard hasPassword={Boolean(me.hasPassword)} onRefresh={onRefresh} />
      <LeadDelivery me={me} onRefresh={onRefresh} />
      <div className="card">
        <h3>Your plan</h3>
        <div className="kv"><span>Plan</span><strong>{plan.name}. ${plan.priceAud} a month.</strong></div>
        <div className="kv"><span>Groups watched</span><strong>{groups.length} of {plan.groups}</strong></div>
        <div className="kv"><span>Alert speed</span><strong>Under 60 seconds</strong></div>
        <div className="kv"><span>Posts checked this month</span><strong>{(me.postsUsed ?? 0).toLocaleString()} of {plan.postsPerMonth.toLocaleString()}</strong></div>
        <div className="kv"><span>Guarantee</span><strong>A lead this month or we refund you</strong></div>
        <p className="tiny">Need to change anything? Email ross@roowatch.com.au and we sort it same day.</p>
      </div>
      <div className="card">
        <h3>Session</h3>
        <button className="btn ghost" onClick={onLogout}>Log out</button>
      </div>
      <ManageSubscription plan={plan} trialEndsAt={me.trialEndsAt ?? 0} cancelAt={me.cancelAt ?? 0} status={me.subscriptionStatus ?? ""} />
    </div>
  );
}

type ReadPost = {
  id: string;
  seenAt: number;
  text: string;
  url: string;
  author: string;
  groupName: string;
};

/**
 * Leads, and everything we read to find them.
 *
 * The Posts tab exists so a member with no leads yet can see the machine
 * working. Without it, "nothing matched" and "it is broken" look identical.
 */
function LeadsPage({ me, view, setView }: {
  me: Me;
  view: "leads" | "posts";
  setView: (v: "leads" | "posts") => void;
}) {
  const [now] = useState(() => Date.now());
  const [posts, setPosts] = useState<ReadPost[] | null>(null);
  const [total, setTotal] = useState(0);
  const alerts = me.alerts ?? [];

  useEffect(() => {
    if (view !== "posts" || posts) return;
    let live = true;
    fetch("/api/member/posts")
      .then((r) => r.json())
      .then((d: { posts?: ReadPost[]; total?: number }) => {
        if (!live) return;
        setPosts(d.posts ?? []);
        setTotal(d.total ?? 0);
      })
      .catch(() => live && setPosts([]));
    return () => { live = false; };
  }, [view, posts]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Leads</h1>
          <p className="muted">
            {view === "leads"
              ? "Every lead we have sent you, newest first."
              : "Every post we read in your groups. We keep 14 days."}
          </p>
        </div>
        {view === "leads" && alerts.length > 0 && <span className="live"><i /> {alerts.length} so far</span>}
        {view === "posts" && total > 0 && <span className="live"><i /> {total.toLocaleString()} read</span>}
      </header>

      <div className="subtabs" role="tablist">
        <button role="tab" aria-selected={view === "leads"} className={view === "leads" ? "subtab on" : "subtab"} onClick={() => setView("leads")}>
          Leads{alerts.length > 0 ? ` (${alerts.length})` : ""}
        </button>
        <button role="tab" aria-selected={view === "posts"} className={view === "posts" ? "subtab on" : "subtab"} onClick={() => setView("posts")}>
          Posts we read
        </button>
      </div>

      {view === "leads" ? (
        <div className="card">
          {alerts.length === 0 ? (
            <div className="empty">
              <p><strong>No leads yet.</strong></p>
              <p className="muted">When someone posts a job that matches your brief, it lands here and in your inbox.</p>
              {(me.postsUsed ?? 0) > 0 && (
                <button className="btn ghost mt" onClick={() => setView("posts")}>
                  See the {(me.postsUsed ?? 0).toLocaleString()} posts we read
                </button>
              )}
            </div>
          ) : (
            byDay(alerts, (a) => new Date(a.sentAt + "Z").getTime(), now).map((g) => (
              <div className="day-group" key={g.key}>
                <DayHeading label={g.label} count={g.items.length} noun="lead" />
                {g.items.map((a) => <AlertRow key={a.id} alert={a} />)}
              </div>
            ))
          )}
        </div>
      ) : (
        <PostsRead posts={posts} />
      )}
    </div>
  );
}

function PostsRead({ posts }: { posts: ReadPost[] | null }) {
  // Pinned once, the way MemberView does it. Reading the clock during render
  // makes the component impure and the output non-deterministic.
  const [now] = useState(() => Date.now());
  if (posts === null) {
    return <div className="card"><div className="empty"><span className="spinner" /></div></div>;
  }
  if (!posts.length) {
    return (
      <div className="card">
        <div className="empty">
          <p><strong>Nothing read yet.</strong></p>
          <p className="muted">Once your groups are being watched, every post we check turns up here.</p>
        </div>
      </div>
    );
  }

  const when = (ms: number) => {
    const mins = Math.max(0, Math.round((now - ms) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 1440)}d ago`;
  };

  return (
    <div className="card">
      {byDay(posts, (p) => p.seenAt, now).map((g) => (
        <div className="day-group" key={g.key}>
          <DayHeading label={g.label} count={g.items.length} noun="post" />
          <div className="read-list">
            {g.items.map((p) => (
              <article className="read-row" key={p.id}>
                <div className="read-meta">
                  <span className="read-group">{p.groupName}</span>
                  <span className="read-when">{when(p.seenAt)}</span>
                </div>
                <p className="read-text">{p.text || "This post had no text we could read."}</p>
                <div className="read-foot">
                  <span className="read-author">{p.author || "Someone"}</span>
                  {p.url && (
                    <a className="read-link" href={p.url} target="_blank" rel="noreferrer noopener">
                      See post
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      ))}
      <p className="tiny">We keep 14 days of posts. Anything older is deleted.</p>
    </div>
  );
}

/**
 * The three dots on a group row.
 *
 * Remove used to sit right there in the open, one stray tap from deleting a
 * group. It is now behind the menu, next to a way to open the group on
 * Facebook, so a member can go and look before deciding.
 */
function GroupMenu({ group, busy, onRemove, onRename }: {
  group: Group;
  busy: boolean;
  onRemove: () => void;
  onRename: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const shut = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", shut);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", shut);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <span className="dots-wrap" ref={box}>
      <button
        className={open ? "dots on" : "dots"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Options for ${group.name}`}
        onClick={() => setOpen(!open)}
      >
        {I.dots}
      </button>
      {open && (
        <span className="dots-menu" role="menu">
          <button
            className="dots-item"
            role="menuitem"
            disabled={busy}
            onClick={() => { setOpen(false); onRename(); }}
          >
            {I.pencil} Rename
          </button>
          {group.url ? (
            <a className="dots-item" role="menuitem" href={group.url} target="_blank" rel="noreferrer noopener" onClick={() => setOpen(false)}>
              {I.out} Visit group on Facebook
            </a>
          ) : (
            <span className="dots-item off">Still connecting this group</span>
          )}
          <button
            className="dots-item danger"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              if (confirm(`Stop watching ${group.name}? You will not get leads from it any more.`)) onRemove();
            }}
          >
            {I.bin} Remove
          </button>
        </span>
      )}
    </span>
  );
}

type SupportMessage = {
  id: number;
  userId: string;
  fromAdmin: number;
  body: string;
  createdAt: string;
};

function chatTime(raw: string) {
  return new Date(raw.replace(" ", "T") + "Z").toLocaleString("en-AU", {
    timeZone: "Australia/Perth",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The support bubble, bottom right on every page.
 *
 * Members do not get a Support tab any more. A tradie should be able to ask a
 * question from wherever they are without losing their place, the way every
 * SaaS chat widget works. Ross still gets the full thread view in the admin
 * dashboard, because he is triaging many people and they are only ever in one
 * conversation.
 *
 * It renders through the same portal as the modals, so the transforms on
 * .page and .subpanel cannot trap it in the content column.
 */
function SupportBubble({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [messages, setMessages] = useState<SupportMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [justSent, setJustSent] = useState<number | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const unread = me.supportUnread ?? 0;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/member/support");
      const d = (await res.json()) as { messages?: SupportMessage[] };
      setMessages(d.messages ?? []);
      // Opening marks Ross's replies read, so refresh the badge.
      if (unread) onRefresh();
    } catch {
      setMessages([]);
    }
  }, [unread, onRefresh]);

  useEffect(() => {
    if (open && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [open, messages]);

  function shut() {
    // Let the close animation finish before the panel leaves the tree.
    setClosing(true);
    setTimeout(() => { setClosing(false); setOpen(false); }, 180);
  }

  async function send() {
    const text = draft.trim();
    if (text.length < 2 || busy) return;
    setBusy(true);
    setDraft("");
    try {
      const res = await fetch("/api/member/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const d = (await res.json()) as { messages?: SupportMessage[] };
      if (d.messages) {
        setMessages(d.messages);
        setJustSent(d.messages[d.messages.length - 1]?.id ?? null);
      }
    } catch {
      setDraft(text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div className="rw-chat">
        {(open || closing) && (
          <section className={closing ? "rw-panel out" : "rw-panel"} role="dialog" aria-label="Support">
            <header className="rw-panel-head">
              <div>
                <strong>Support</strong>
                <span>We reply here and by email</span>
              </div>
              <button className="rw-x" onClick={shut} aria-label="Close support">{I.x}</button>
            </header>

            <div className="rw-log" ref={log}>
              {messages === null ? (
                <div className="rw-empty"><span className="spinner" /></div>
              ) : messages.length === 0 ? (
                <div className="rw-empty">
                  <strong>Say g&apos;day</strong>
                  <p>Stuck on a group? Leads not right? Want more groups watched? Ask away and Ross will come back to you.</p>
                </div>
              ) : (
                messages.map((m) => (
                  <div
                    className={`bubble-row ${m.fromAdmin ? "them" : "me"}${m.id === justSent ? " pop" : ""}`}
                    key={m.id}
                  >
                    <div className="bubble">
                      <p>{m.body}</p>
                      <span className="bubble-time">{m.fromAdmin ? "Ross" : "You"} &middot; {chatTime(m.createdAt)}</span>
                    </div>
                  </div>
                ))
              )}
              {busy && (
                <div className="bubble-row me">
                  <div className="bubble sending"><span className="dot" /><span className="dot" /><span className="dot" /></div>
                </div>
              )}
            </div>

            <div className="rw-send">
              <textarea
                rows={1}
                placeholder="Type your message"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                }}
              />
              <button className="rw-send-btn" disabled={busy || draft.trim().length < 2} onClick={send} aria-label="Send">
                {I.send}
              </button>
            </div>
          </section>
        )}

        <button
          className={open ? "rw-launcher open" : "rw-launcher"}
          onClick={() => {
            if (open) return shut();
            setOpen(true);
            // Fetch on the click rather than in an effect. Opening is the
            // event, and this keeps render pure.
            if (messages === null) load();
          }}
          aria-label={open ? "Close support" : "Open support"}
        >
          <span className="rw-icon-swap">{open ? I.x : I.chat}</span>
          {!open && unread > 0 && <span className="rw-badge">{unread}</span>}
        </button>
      </div>
    </Portal>
  );
}

type Thread = {
  userId: string;
  email: string;
  name: string;
  avatar?: string;
  businessName: string;
  plan: string;
  unread: number;
  lastAt: string;
  lastFromAdmin: boolean;
  preview: string;
  messages: SupportMessage[];
};

/** Ross's side: every conversation, whoever is waiting at the top. */
function SupportView({ threads, flash, onAction }: {
  threads: Thread[];
  flash: string;
  onAction: (path: string, payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const [openId, setOpenId] = useState<string | null>(threads[0]?.userId ?? null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const open = threads.find((t) => t.userId === openId) ?? threads[0] ?? null;

  async function reply() {
    if (!open || draft.trim().length < 2 || busy) return;
    setBusy(true);
    try {
      await onAction("/api/admin/support", {
        action: "reply",
        userId: open.userId,
        message: draft.trim(),
      });
      setDraft("");
    } finally {
      setBusy(false);
    }
  }

  if (!threads.length) {
    return (
      <div className="subview">
        <div className="card">
          <div className="empty">
            <p><strong>No messages yet.</strong></p>
            <p className="muted">When a member writes from their dashboard it lands here, and in your inbox.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="subview">
      {flash && <p className="flash mb">{flash}</p>}
      <div className="chat-split">
        <div className="thread-list">
          {threads.map((t) => (
            <button
              key={t.userId}
              className={t.userId === open?.userId ? "thread on" : "thread"}
              onClick={() => { setOpenId(t.userId); if (t.unread) onAction("/api/admin/support", { action: "read", userId: t.userId }); }}
            >
              <div className="thread-top">
                <strong>{t.businessName || t.name || t.email}</strong>
                {t.unread > 0 && <span className="unread">{t.unread}</span>}
              </div>
              <span className="thread-preview">{t.lastFromAdmin ? "You: " : ""}{t.preview}</span>
              <span className="thread-meta">{t.plan} &middot; {chatTime(t.lastAt)}</span>
            </button>
          ))}
        </div>

        <div className="card chat-card">
          {open && (
            <>
              <div className="chat-head">
                <strong>{open.businessName || open.name || open.email}</strong>
                <span className="tiny">{open.email} &middot; {open.plan}</span>
              </div>
              <div className="chat-log">
                {open.messages.map((m) => (
                  <div className={m.fromAdmin ? "bubble-row me" : "bubble-row them"} key={m.id}>
                    <div className="bubble">
                      <p>{m.body}</p>
                      <span className="bubble-time">{m.fromAdmin ? "You" : open.name || "Them"} &middot; {chatTime(m.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="chat-send">
                <textarea
                  rows={2}
                  placeholder={`Reply to ${open.name || open.email}`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) reply(); }}
                />
                <button className="btn primary" disabled={busy || draft.trim().length < 2} onClick={reply}>
                  {busy ? "Sending" : "Reply"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <p className="tiny">Replying emails them too, so they see it without opening the dashboard.</p>
    </div>
  );
}

function GroupsTab({ groups, limit, onRefresh }: { groups: Group[]; limit: number; onRefresh: () => void }) {
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const LIMIT = limit;

  async function call(payload: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/member/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          d.error === "need_url"
            ? "Paste the whole Facebook link, like facebook.com/groups/123456789. A name on its own cannot be watched."
            : d.error === "plan_limit"
            ? `Your plan covers ${LIMIT} groups. Remove one first.`
            : d.error === "duplicate"
            ? "That group is already on your list."
            : d.error === "private"
            ? "Public groups only for now. Private group scanning is coming soon."
            : "Could not save that."
        );
        return;
      }
      setName("");
      onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveName(groupId: number) {
    const next = draft.trim();
    setEditingId(null);
    if (next.length < 2) return;
    await call({ action: "rename", groupId, name: next });
  }

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Groups watching</h1><p className="muted">The groups we read for you, day and night. Public groups only.</p></div>
        <span className="tiny">{groups.length} of {LIMIT}</span>
      </header>
      <div className="card">
        {groups.length === 0 ? (
          <div className="empty"><p><strong>No groups yet.</strong></p><p className="muted">Add the local groups your customers use. We take it from there.</p></div>
        ) : (
          groups.map((g) => (
            <div className="group-row" key={g.id}>
              {editingId === g.id ? (
                <input
                  className="name-edit"
                  value={draft}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveName(g.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <span className="group-stack">
                  <span className="group-name">{g.name}</span>
                  {stillNumbers(g) && (
                    <span className="group-waiting">
                      <i className="spinner tiny" /> Group name will update automatically
                    </span>
                  )}
                </span>
              )}
              <span className="row gap">
                {editingId === g.id ? (
                  <>
                    <button className="icon-btn save" disabled={busy || draft.trim().length < 2} onClick={() => saveName(g.id)} aria-label="Save name">{I.tick}</button>
                    <button className="icon-btn" onClick={() => setEditingId(null)} aria-label="Cancel">{I.x}</button>
                  </>
                ) : (
                  <>
                    {isPrivate(g) ? (
                      <span className="chip-status pending" title={g.problem}>Access getting approved</span>
                    ) : (
                      <span className={g.status === "watching" ? "chip-status ok" : "chip-status pending"}>{g.status === "watching" ? "Watching" : g.status === "paused" ? "Paused" : "Setting up"}</span>
                    )}
                    <GroupMenu
                      group={g}
                      busy={busy}
                      onRemove={() => call({ action: "remove", groupId: g.id })}
                      onRename={() => { setDraft(g.name); setEditingId(g.id); }}
                    />
                  </>
                )}
              </span>
            </div>
          ))
        )}
        <div className="row gap mt">
          <input placeholder="Paste the Facebook group link" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && call({ action: "add", name })} />
          <button className="btn ghost square" disabled={busy || !name.trim()} onClick={() => call({ action: "add", name })}>Add</button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
      <p className="tiny">Open the group on Facebook and copy the address from your browser. We start watching it straight away.</p>
    </div>
  );
}

function ProfileForm({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  const [name, setName] = useState(me.user?.name ?? "");
  const [businessName, setBusinessName] = useState(me.profile?.businessName ?? "");
  const [website, setWebsite] = useState(me.profile?.website ?? "");
  const [services, setServices] = useState(me.profile?.services ?? "");
  const [location, setLocation] = useState(me.profile?.location ?? "");
  const [phone, setPhone] = useState(me.profile?.alertPhone ?? "");
  const [brief, setBrief] = useState(me.profile?.brief ?? "");
  const [status, setStatus] = useState<"clean" | "typing" | "saving" | "saved">("clean");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const first = useRef(true);

  // Auto save. A tradie should never lose a change because they missed a
  // button. We wait until they stop typing so we are not writing every letter.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setStatus("typing");
    const timer = setTimeout(async () => {
      setStatus("saving");
      try {
        await fetch("/api/member/account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, businessName, website, services, location, brief, alertPhone: phone }),
        });
        setStatus("saved");
        onRefresh();
      } catch {
        setStatus("typing");
      }
    }, 900);
    return () => clearTimeout(timer);
    // onRefresh is stable enough here and adding it would re-run on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, businessName, website, services, location, phone, brief]);

  // "Saved" is a receipt, not a permanent label. Let it fade.
  useEffect(() => {
    if (status !== "saved") return;
    const timer = setTimeout(() => setStatus("clean"), 2500);
    return () => clearTimeout(timer);
  }, [status]);

  async function askAi() {
    setAiBusy(true);
    setAiError("");
    try {
      const res = await fetch("/api/member/brief-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessName, website, services, location }),
      });
      const data = (await res.json().catch(() => ({}))) as { brief?: string; error?: string };
      if (!res.ok || !data.brief) {
        setAiError(
          data.error === "not_enough"
            ? "Fill in your website or what you do first."
            : "Could not write it just now. Try again in a moment."
        );
        return;
      }
      setBrief(data.brief);
    } catch {
      setAiError("Could not write it just now. Try again in a moment.");
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Your business</h3>
        <SaveState status={status} />
      </div>
      <label className="lbl">Your name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <label className="lbl">Business name</label>
      <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
      <label className="lbl">Website</label>
      <input value={website} onChange={(e) => setWebsite(e.target.value)} />
      <label className="lbl">What you do</label>
      <textarea rows={3} value={services} onChange={(e) => setServices(e.target.value)} />
      <label className="lbl">Suburbs you serve</label>
      <input value={location} onChange={(e) => setLocation(e.target.value)} />
      <label className="lbl">Mobile</label>
      <input type="tel" placeholder="0400 000 000" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <p className="tiny">We text your leads here. Australian mobiles only.</p>

      <div className="lbl-row">
        <label className="lbl">What a good lead sounds like</label>
        <button className="ai-btn" onClick={askAi} disabled={aiBusy}>
          <span className="ai-face">{I.spark} {aiBusy ? "Writing it" : "Ask AI"}</span>
        </button>
      </div>
      <textarea rows={6} placeholder="Tell me when someone asks for a solar quote or an installer near me." value={brief} onChange={(e) => setBrief(e.target.value)} />
      {aiError ? (
        <p className="error">{aiError}</p>
      ) : (
        <p className="tiny">This is what we look for. The clearer it is, the better your leads. Ask AI reads your website and writes it for you.</p>
      )}
    </div>
  );
}

/** Quiet save state. It only speaks up while something is happening. */
function SaveState({ status }: { status: "clean" | "typing" | "saving" | "saved" }) {
  if (status === "clean") return null;
  if (status === "saved") return <span className="save-state ok">{I.tick} Saved</span>;
  return <span className="save-state">Saving</span>;
}

/**
 * Everything about their subscription happens on Stripe, not here.
 *
 * One time link into Stripe's own billing portal, where they can move between
 * plans, cancel, change their card or read invoices. Their customer id comes
 * from their own row, so this can only ever reach their own subscription, and
 * no billing logic or card details ever live in RooWatch.
 *
 * A plan change there fires customer.subscription.updated, and the webhook
 * reads the new price back onto their profile. So an upgrade lifts their group
 * and post limits without anyone touching the admin panel.
 */
function ManageSubscription({ plan, trialEndsAt, cancelAt, status }: {
  plan: Plan;
  trialEndsAt: number;
  cancelAt: number;
  status: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Pinned once. Reading the clock during render makes the component impure.
  const [now] = useState(() => Date.now());

  // Only while the trial is genuinely running. A trial_end in the past means
  // it has converted, and showing "0 days left" then would be a lie.
  const trialDays =
    status === "trialing" && trialEndsAt * 1000 > now
      ? Math.floor((trialEndsAt * 1000 - now) / 86400000)
      : null;

  // A cancellation booked for the end of the period they paid for. Without
  // this the dashboard looks completely normal and they assume it failed.
  const endsOn =
    cancelAt * 1000 > now
      ? new Date(cancelAt * 1000).toLocaleDateString("en-AU", {
          day: "numeric",
          month: "long",
        })
      : null;

  async function openPortal() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/member/billing", { method: "POST" });
      const d = (await res.json()) as { url?: string; error?: string };
      if (d.url) {
        window.location.href = d.url;
        return;
      }
      setError(
        d.error === "no_subscription"
          ? "We cannot find a subscription for your account. Email ross@roowatch.com.au and we will sort it."
          : "Could not open your billing page. Try again in a moment."
      );
    } catch {
      setError("Could not open your billing page. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h3>Your subscription</h3>
        {endsOn ? (
          <span className="chip-status warn">Cancelled, ends {endsOn}</span>
        ) : trialDays !== null && (
          <span className="chip-status ok">
            {trialDays === 0
              ? "Last day of your trial"
              : `${trialDays} day${trialDays === 1 ? "" : "s"} left of your trial`}
          </span>
        )}
      </div>
      <p className="muted">
        Move up a plan for more groups, drop down, change your card, grab an invoice,
        or cancel. It all happens on our secure billing page.
      </p>
      <div className="sub-plans">
        {PLAN_KEYS.map((k) => (
          <span key={k} className={plan.key === k ? "sub-plan on" : "sub-plan"}>
            <strong>{PLANS[k].name}</strong>
            <span>${PLANS[k].priceAud} &middot; {PLANS[k].groups} groups</span>
            {plan.key === k && <em>Your plan</em>}
          </span>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <button className="btn primary mt" disabled={busy} onClick={openPortal}>
        {busy ? "Opening" : "Manage subscription"}
      </button>
      <p className="tiny">
        {endsOn
          ? `Your subscription ends on ${endsOn}. You keep getting leads right up until then, and you can turn it back on any time before that date.`
          : "Upgrades take effect straight away and the difference goes on your next invoice. If you cancel you keep your leads until the end of the period you have paid for."}
      </p>
    </div>
  );
}

/**
 * Group a list into days, newest day first, newest item first inside it.
 *
 * A tradie scanning their leads needs to know at a glance which ones landed
 * today. One unbroken column of cards does not tell them that.
 */
function byDay<T>(items: T[], at: (item: T) => number, now: number) {
  const startOf = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const today = startOf(now);

  const label = (ms: number) => {
    const days = Math.round((today - startOf(ms)) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return new Date(ms).toLocaleDateString("en-AU", {
      weekday: "short", day: "numeric", month: "short",
    });
  };

  const groups: { key: number; label: string; items: T[] }[] = [];
  for (const item of [...items].sort((a, b) => at(b) - at(a))) {
    const key = startOf(at(item));
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: label(at(item)), items: [item] });
  }
  return groups;
}

function DayHeading({ label, count, noun }: { label: string; count: number; noun: string }) {
  return (
    <div className="day-head">
      <span className="day-name">{label}</span>
      <span className="day-count">{count} {noun}{count === 1 ? "" : "s"}</span>
    </div>
  );
}

function AlertRow({ alert }: { alert: Alert }) {
  const when = new Date(alert.sentAt + "Z").toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="alert-item">
      <div className="alert-main">
        <div className="alert-top">
          <strong>{alert.groupName}</strong>
          <span className="tiny">{when}</span>
        </div>
        <p className="alert-text">{alert.postText}</p>
        {alert.reason && <p className="alert-reason">{alert.reason}</p>}
      </div>
      {alert.postUrl && (
        <a className="btn-go" href={alert.postUrl} target="_blank" rel="noreferrer">
          Go to post
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="15" height="15"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        </a>
      )}
    </div>
  );
}

/** Every user, what they are worth, and everything Ross can do to them. */
function UsersView({ members, stats, history, flash, onAction }: {
  members: Member[];
  stats: UserStats | null;
  history: HistoryPoint[];
  flash: string;
  onAction: (path: string, payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const open = members.find((m) => m.id === openId) ?? null;
  const leftAtStripe = members.filter((member) => checkoutJourney(member).key === "left-at-stripe").length;
  const cardAdded = members.filter((member) => checkoutJourney(member).key === "card-added").length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) =>
      [m.email, m.name, m.businessName, m.trade, m.state, m.planName]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [members, query]);

  return (
    <div className="subview">
      <header className="subhead">
        <div><p className="muted">Everyone who has an account, and what they are worth.</p></div>
      </header>

      {flash && <p className="flash mb">{flash}</p>}

      <div className="tiles">
        <div className="tile tile-accent">
          <span className="tile-num">${(stats?.mrr ?? 0).toLocaleString()}</span>
          <span className="tile-label">MRR</span>
        </div>
        <div className="tile">
          <span className="tile-num">${(stats?.trialMrr ?? 0).toLocaleString()}</span>
          <span className="tile-label">On trial, not paying yet</span>
        </div>
        <div className="tile">
          <span className="tile-num">{stats?.total ?? 0}</span>
          <span className="tile-label">Accounts</span>
        </div>
        <div className="tile tile-warn">
          <span className="tile-num">{leftAtStripe}</span>
          <span className="tile-label">Setup complete, no card</span>
        </div>
        <div className="tile tile-success">
          <span className="tile-num">{cardAdded}</span>
          <span className="tile-label">Card accepted</span>
        </div>
      </div>

      <div className="card">
        <h3>Users and MRR, last 30 days</h3>
        <Growth history={history} />
        <p className="tiny">
          Everyone counts from the day they signed up, at the plan they are on today. Plan
          changes are not kept as history, so an upgrade looks like it was always there.
        </p>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Everyone</h3>
          <input className="user-search" placeholder="Search name, email, trade" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {shown.length === 0 ? (
          <div className="empty tight"><p className="muted">Nobody matches that.</p></div>
        ) : (
          <div className="user-grid">
            {shown.map((m) => {
              const journey = checkoutJourney(m);
              return (
                <button key={m.id} className={`user-card journey-${journey.key}`} onClick={() => setOpenId(m.id)}>
                  <div className="user-card-top">
                    <Avatar avatar={m.avatar} name={m.businessName || m.name || m.email} />
                    <div className="user-card-who">
                      <strong>{m.businessName || m.name || m.email}</strong>
                      <span>{m.email}</span>
                    </div>
                  </div>
                  <div className="user-card-meta">
                    <span className={`plan-tag plan-${m.plan}`}>{m.planName}</span>
                    <CheckoutJourneyChip member={m} />
                  </div>
                  <div className={`user-card-money ${journey.tone}`}>{journey.valueLabel}</div>
                  <div className="user-card-foot">
                    <span>{m.trade || "no trade set"}</span>
                    <span>{m.groups.length} groups &middot; {m.alertCount} leads</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {open && <UserModal member={open} onClose={() => setOpenId(null)} onAction={onAction} />}
    </div>
  );
}

type CheckoutJourney = {
  key: "setup" | "left-at-stripe" | "card-added" | "payment-issue" | "plan-stopped";
  label: string;
  tone: "ok" | "pending" | "warn" | "bad";
  valueLabel: string;
};

function checkoutJourney(member: Pick<Member, "onboarded" | "subscriptionStatus" | "stripeCustomerId" | "planPrice">): CheckoutJourney {
  const status = member.subscriptionStatus.trim().toLowerCase();

  if (!member.onboarded) {
    return { key: "setup", label: "Setup not finished", tone: "pending", valueLabel: "No Stripe checkout yet." };
  }
  if (!status && !member.stripeCustomerId) {
    return { key: "left-at-stripe", label: "Setup complete, no card", tone: "warn", valueLabel: "Finished setup. No card added." };
  }
  // Checked before the status, because Stripe keeps saying trialing or active
  // right up until the day the plan actually stops.
  if (member.cancelAt && member.cancelAt * 1000 > Date.now()) {
    const ends = new Date(member.cancelAt * 1000).toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
    });
    return {
      key: "leaving",
      label: `Cancelled, ends ${ends}`,
      tone: "warn",
      valueLabel: `Cancelled. Access ends ${ends}.`,
    };
  }
  if (status === "trialing") {
    return {
      key: "card-added",
      label: "Card accepted, on trial",
      tone: "ok",
      valueLabel: `Card accepted. $${member.planPrice.toLocaleString()} a month after trial.`,
    };
  }
  if (status === "active") {
    return {
      key: "card-added",
      label: "Card accepted, paying",
      tone: "ok",
      valueLabel: `Card accepted. $${member.planPrice.toLocaleString()} a month now.`,
    };
  }
  if (status === "past_due") {
    return { key: "payment-issue", label: "Card accepted, payment issue", tone: "bad", valueLabel: "Card is saved. Payment needs help." };
  }
  if (status === "unpaid" || status === "canceled") {
    return { key: "plan-stopped", label: "Plan stopped", tone: "bad", valueLabel: "No active plan." };
  }
  if (member.stripeCustomerId) {
    return { key: "payment-issue", label: "Card accepted, check Stripe", tone: "bad", valueLabel: "Card is saved. Check Stripe." };
  }
  return { key: "left-at-stripe", label: "Setup complete, no card", tone: "warn", valueLabel: "Finished setup. No card added." };
}

function CheckoutJourneyChip({ member }: { member: Member }) {
  const journey = checkoutJourney(member);
  return <span className={`chip-status ${journey.tone}`}>{journey.label}</span>;
}

/**
 * Two lines on one grid: accounts and MRR. Drawn by hand, no chart library.
 *
 * Two scales, because accounts are counted in ones and MRR in hundreds. Each
 * line is read against its own axis, in its own colour, so nobody has to guess
 * which number belongs to which line.
 *
 * The tick labels are HTML rather than SVG text. The plot is stretched to fill
 * whatever width it is given, and stretched text looks broken.
 */
function Growth({ history }: { history: HistoryPoint[] }) {
  if (history.length < 2) {
    return <div className="empty tight"><p className="muted">Not enough days yet.</p></div>;
  }
  const W = 640;
  const H = 170;

  /** Round a maximum up to something a person would actually write down. */
  function niceTop(value: number): number {
    if (value <= 5) return 5;
    const pow = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 2.5, 5, 10]) {
      const top = step * pow;
      if (top >= value) return top;
    }
    return 10 * pow;
  }

  const topUsers = niceTop(Math.max(1, ...history.map((h) => h.users)));
  const topMrr = niceTop(Math.max(1, ...history.map((h) => h.mrr)));
  const x = (i: number) => (i / (history.length - 1)) * W;
  const line = (pick: (h: HistoryPoint) => number, max: number) =>
    history
      .map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${(H - (pick(h) / max) * H).toFixed(1)}`)
      .join(" ");

  // Four rows, top to bottom, so the labels read the way the chart does.
  const rows = [1, 0.75, 0.5, 0.25, 0];
  const last = history[history.length - 1];

  /** A few dates across the bottom, never more than will fit. */
  const marks = [0, Math.round((history.length - 1) / 2), history.length - 1]
    .filter((v, i, all) => all.indexOf(v) === i)
    .map((i) => history[i].day.slice(5));

  return (
    <div className="growth">
      <div className="growth-plot">
        <div className="growth-axis left" aria-hidden="true">
          {rows.map((r) => (
            <span key={r}>{Math.round(topUsers * r).toLocaleString()}</span>
          ))}
        </div>

        <div className="growth-canvas">
          <svg viewBox={`0 0 ${W} ${H}`} className="growth-svg" preserveAspectRatio="none" aria-hidden="true">
            {rows.map((r) => (
              <line key={r} x1="0" x2={W} y1={H - r * H} y2={H - r * H} className="growth-grid" />
            ))}
            <path d={`${line((h) => h.users, topUsers)} L${W},${H} L0,${H} Z`} className="growth-fill" />
            <path d={line((h) => h.users, topUsers)} className="growth-users" />
            <path d={line((h) => h.mrr, topMrr)} className="growth-mrr" />
          </svg>
          <div className="growth-x" aria-hidden="true">
            {marks.map((m) => <span key={m}>{m}</span>)}
          </div>
        </div>

        <div className="growth-axis right" aria-hidden="true">
          {rows.map((r) => (
            <span key={r}>${Math.round(topMrr * r).toLocaleString()}</span>
          ))}
        </div>
      </div>

      <div className="growth-key">
        <span><i className="key-users" /> Accounts, now {last.users}</span>
        <span><i className="key-mrr" /> MRR, now ${last.mrr.toLocaleString()}</span>
        <span className="tiny">{history[0].day} to {last.day}</span>
      </div>
    </div>
  );
}

function UserModal({ member, onClose, onAction }: {
  member: Member;
  onClose: () => void;
  onAction: (path: string, payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState(member.name);
  const [businessName, setBusinessName] = useState(member.businessName);
  const [brief, setBrief] = useState(member.brief);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty =
    name !== member.name || businessName !== member.businessName || brief !== member.brief;

  async function call(payload: Record<string, unknown>) {
    setBusy(true);
    try {
      await onAction("/api/admin/members", { userId: member.id, ...payload });
    } finally {
      setBusy(false);
    }
  }

  const postPct = member.postsPerMonth
    ? Math.min(100, (member.postsUsed / member.postsPerMonth) * 100)
    : 0;

  return (
    <Portal>
      <div className="overlay" onClick={onClose}>
        <div className="modal user-modal" onClick={(e) => e.stopPropagation()}>
          <header className="um-head">
            <div className="user-card-top">
              <Avatar avatar={member.avatar} name={member.businessName || member.name || member.email} />
              <div className="user-card-who">
                <strong>{member.businessName || member.name || member.email}</strong>
                <span>{member.email}</span>
              </div>
            </div>
            <button className="um-close" onClick={onClose} aria-label="Close">&times;</button>
          </header>

          <div className="um-body">
            <section className="um-section">
              <div className="um-badges">
                <span className={`plan-tag plan-${member.plan}`}>{member.planName} &middot; ${member.planPrice}/mo</span>
                <CheckoutJourneyChip member={member} />
              </div>

              <div className="um-stats">
                <div className="um-stat">
                  <strong>{member.groups.length}<small> / {member.planGroups}</small></strong>
                  <span>Groups</span>
                </div>
                <div className="um-stat">
                  <strong>{member.alertCount}</strong>
                  <span>Leads sent</span>
                </div>
                <div className="um-stat">
                  <strong>{member.postsUsed.toLocaleString()}<small> / {(member.postsPerMonth / 1000)}k</small></strong>
                  <span>Posts read</span>
                  <div className="um-bar"><i style={{ width: `${postPct}%` }} /></div>
                </div>
              </div>
            </section>

            <section className="um-section">
              <h4 className="um-label">Contact</h4>
              <div className="kv"><span>Phone</span><strong>{member.phone ? <a href={`tel:${member.phone}`}>{member.phone}</a> : "not given"}</strong></div>
              <div className="kv"><span>Trade</span><strong>{member.trade || "not set"}</strong></div>
              <div className="kv"><span>Where</span><strong>{member.location || member.state || "not set"}</strong></div>
              <div className="kv"><span>Website</span><strong>{member.website || "not given"}</strong></div>
              <div className="kv"><span>Joined</span><strong>{(member.createdAt || "").slice(0, 10)}</strong></div>
            </section>

            <section className="um-section">
              <h4 className="um-label">Plan</h4>
              <p className="um-note">Moves their Stripe subscription at the same time.</p>
              <div className="plan-switch left">
                {PLAN_KEYS.map((k) => (
                  <button
                    key={k}
                    className={member.plan === k ? "plan-pick on" : "plan-pick"}
                    disabled={busy}
                    onClick={() => {
                      if (member.plan === k) return;
                      const now = PLANS[member.plan as keyof typeof PLANS];
                      if (!confirm(
                        `Move ${member.businessName || member.email} from ${now?.name ?? member.plan} to ${PLANS[k].name}?\n\n` +
                        `Groups: ${now?.groups ?? "?"} to ${PLANS[k].groups}\n` +
                        `Price: $${now?.priceAud ?? "?"} to $${PLANS[k].priceAud} a month\n\n` +
                        `Their Stripe subscription moves to the new price at the same time. ` +
                        `The difference goes on their next invoice, their card is not charged now. ` +
                        `A trial keeps running.`
                      )) return;
                      call({ action: "plan", plan: k });
                    }}
                  >
                    {PLANS[k].name} &middot; {PLANS[k].groups}g
                  </button>
                ))}
              </div>
            </section>

            <section className="um-section">
              <h4 className="um-label">Their details</h4>
              <div className="form-grid">
                <label className="field">
                  <span className="field-label">Their name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="field">
                  <span className="field-label">Business name</span>
                  <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
                </label>
              </div>
              <label className="field">
                <span className="field-label">What a good lead sounds like</span>
                <textarea rows={7} value={brief} onChange={(e) => setBrief(e.target.value)} />
              </label>
              <div className="um-actions">
                <button
                  className="btn primary"
                  disabled={busy || !dirty}
                  onClick={() => call({ action: "update", name, businessName, brief })}
                >
                  {busy ? "Saving" : "Save changes"}
                </button>
                {dirty && <span className="tiny">Unsaved changes</span>}
              </div>
            </section>

            <section className="um-section">
              <h4 className="um-label">Send them an email</h4>
              <label className="field">
                <span className="field-label">Subject</span>
                <input placeholder="A note from RooWatch" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">Message</span>
                <textarea rows={4} placeholder="G'day, just checking how the leads are going." value={message} onChange={(e) => setMessage(e.target.value)} />
              </label>
              <div className="um-actions">
                <button
                  className="btn primary"
                  disabled={busy || message.trim().length < 3}
                  onClick={async () => { await call({ action: "message", subject, message }); setMessage(""); setSubject(""); }}
                >
                  {busy ? "Sending" : "Send email"}
                </button>
                <span className="tiny">Goes to {member.email}</span>
              </div>
            </section>

            <section className="um-section">
              <h4 className="um-label">See what they see</h4>
              <p className="um-note">
                Signs you in as them so you can fix their groups or show an upsell from inside
                their own dashboard. A banner brings you back.
              </p>
              <button
                className="btn ghost"
                disabled={busy}
                onClick={async () => {
                  if (!confirm(`Sign in as ${member.email}? You can switch back at any time.`)) return;
                  setBusy(true);
                  const res = await fetch("/api/admin/impersonate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ userId: member.id }),
                  });
                  if (res.ok) window.location.href = "/dashboard";
                  else { setBusy(false); alert("Could not sign in as them."); }
                }}
              >
                Sign in as {member.name || member.email}
              </button>
            </section>

            <section className="um-section um-danger">
              <h4 className="um-label">Delete this account</h4>
              <p className="um-note">
                Removes their account, groups and leads, and cancels any live Stripe
                subscription so they stop being charged. This cannot be undone.
              </p>
              <button
                className="btn danger-btn"
                disabled={busy}
                onClick={async () => {
                  if (!confirm(`Delete ${member.email}, all their data, and cancel their Stripe subscription?`)) return;
                  await call({ action: "delete" });
                  onClose();
                }}
              >
                Delete and cancel billing
              </button>
            </section>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function MembersView({ members, onAction }: { members: Member[]; onAction: (path: string, payload: Record<string, unknown>) => Promise<boolean> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [alertGroup, setAlertGroup] = useState("");
  const [alertText, setAlertText] = useState("");
  const [alertUrl, setAlertUrl] = useState("");
  const [alertReason, setAlertReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");

  const member = members.find((m) => m.id === open) ?? null;

  async function createMember() {
    setBusy(true);
    const ok = await onAction("/api/admin/members", { action: "create", email: newEmail, name: newName });
    if (ok) {
      setNewEmail("");
      setNewName("");
      setFlash("Member created and emailed.");
      setTimeout(() => setFlash(""), 3000);
    }
    setBusy(false);
  }

  async function addGroup() {
    if (!member || !groupName.trim()) return;
    setBusy(true);
    await onAction("/api/admin/groups", { action: "add", userId: member.id, name: groupName });
    setGroupName("");
    setBusy(false);
  }

  async function sendAlert() {
    if (!member || !alertGroup.trim() || !alertText.trim()) return;
    setBusy(true);
    const ok = await onAction("/api/admin/alert", {
      userId: member.id,
      groupName: alertGroup,
      postText: alertText,
      postUrl: alertUrl,
      reason: alertReason,
    });
    if (ok) {
      setAlertText("");
      setAlertUrl("");
      setAlertReason("");
      setFlash("Lead sent and emailed.");
      setTimeout(() => setFlash(""), 3000);
    }
    setBusy(false);
  }

  return (
    <div className="subview">
      <header className="subhead">
        <div><p className="muted">Everyone who has signed up. Only you see this.</p></div>
      </header>
      <div className="card">
        <h3>Add a member</h3>
        <div className="form-grid">
          <input placeholder="their@email.com.au" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          <input placeholder="Business name (optional)" value={newName} onChange={(e) => setNewName(e.target.value)} />
        </div>
        <button className="btn primary mt" disabled={busy || !newEmail.trim()} onClick={createMember}>Create and email them</button>
      </div>
      <div className="tiles">
        <div className="tile"><span className="tile-num">{members.length}</span><span className="tile-label">Members</span></div>
        <div className="tile"><span className="tile-num">{members.filter((m) => m.onboarded).length}</span><span className="tile-label">Onboarded</span></div>
        <div className="tile"><span className="tile-num">{members.reduce((n, m) => n + m.groups.length, 0)}</span><span className="tile-label">Groups watched</span></div>
        <div className="tile tile-accent"><span className="tile-num">{members.reduce((n, m) => n + m.alertCount, 0)}</span><span className="tile-label">Leads sent</span></div>
      </div>

      {members.length === 0 && (
        <div className="card"><div className="empty"><p><strong>No members yet.</strong></p><p className="muted">When someone logs in for the first time, they show here.</p></div></div>
      )}

      {members.map((m) => (
        <div className="card" key={m.id}>
          <div className="member-head" onClick={() => { setOpen(open === m.id ? null : m.id); setAlertGroup(m.groups[0]?.name ?? ""); }}>
            <div>
              <strong>{m.name || m.email}</strong>
              <span className="tiny block">{m.email} · {PLANS[(m.plan as keyof typeof PLANS)]?.name ?? "Local"} · {m.groups.length} of {m.planGroups} groups · {m.alertCount} leads sent</span>
            </div>
            <span className={m.onboarded ? "chip-status ok" : "chip-status pending"}>{m.onboarded ? "Onboarded" : "Not finished"}</span>
          </div>

          {open === m.id && (
            <div className="member-body">
              <div className="kv">
                <span>Plan</span>
                <span className="plan-switch">
                  {PLAN_KEYS.map((k) => (
                    <button
                      key={k}
                      className={m.plan === k ? "plan-pick on" : "plan-pick"}
                      disabled={busy}
                      onClick={() => {
                        if (m.plan === k) return;
                        if (!confirm(`Move ${m.email} to ${PLANS[k].name}? This moves their Stripe subscription too.`)) return;
                        onAction("/api/admin/members", { action: "plan", userId: m.id, plan: k });
                      }}
                    >
                      {PLANS[k].name} · {PLANS[k].groups}g · {(PLANS[k].postsPerMonth/1000)}k
                    </button>
                  ))}
                </span>
              </div>
              <div className="kv"><span>Website</span><strong>{m.website || "-"}</strong></div>
              <div className="kv"><span>Area</span><strong>{m.location || "-"}</strong></div>
              <div className="kv"><span>Services</span><strong>{m.services || "-"}</strong></div>
              <div className="kv"><span>Their brief</span><strong>{m.brief || "-"}</strong></div>

              <h3 className="mt">Their groups</h3>
              {m.groups.map((g) => (
                <div className="group-row" key={g.id}>
                  <span className="group-name">{g.name}</span>
                  <span className="row gap">
                    <span className={g.status === "watching" ? "chip-status ok" : "chip-status pending"}>{g.status === "paused" ? "Paused" : g.status}</span>
                    <button className="mini" onClick={() => onAction("/api/admin/groups", { action: "remove", groupId: g.id })}>Remove</button>
                  </span>
                </div>
              ))}
              <div className="row gap mt">
                <input placeholder="Add a group name" value={groupName} onChange={(e) => setGroupName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addGroup()} />
                <button className="btn ghost" onClick={addGroup} disabled={busy}>Add</button>
              </div>

              <h3 className="mt">Send them a lead</h3>
              <div className="form-grid">
                <input placeholder="Group name" value={alertGroup} onChange={(e) => setAlertGroup(e.target.value)} />
                <input placeholder="Link to the post" value={alertUrl} onChange={(e) => setAlertUrl(e.target.value)} />
              </div>
              <textarea rows={3} placeholder="What the person posted" value={alertText} onChange={(e) => setAlertText(e.target.value)} />
              <input placeholder="Why it matched (optional)" value={alertReason} onChange={(e) => setAlertReason(e.target.value)} />
              <div className="row gap mt">
                <button className="btn primary" onClick={sendAlert} disabled={busy}>{busy ? "Sending" : "Send lead and email"}</button>
                {flash && <span className="flash">{flash}</span>}
              </div>
              <div className="row gap mt">
                <button className="mini" onClick={() => { if (confirm(`Delete ${m.email} and all their data?`)) onAction("/api/admin/members", { action: "delete", userId: m.id }); }}>Delete this member</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PipelineView({ sources, uncovered, keys, onAction, onScan }: {
  sources: Source[];
  uncovered: string[];
  keys: { apify: boolean; anthropic: boolean };
  onAction: (path: string, payload: Record<string, unknown>) => Promise<boolean>;
  onScan: (sourceId: number) => Promise<{ ok: boolean; matches?: number; posts?: number; error?: string }>;
}) {
  const [groupName, setGroupName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [now] = useState(() => Date.now());

  const ago = (ts: number) =>
    !ts ? "never" : `${Math.max(1, Math.round((now - ts) / 60000))} min ago`;

  async function add() {
    if (!groupName.trim() || !url.trim()) return;
    setBusy(true);
    await onAction("/api/admin/sources", { action: "add", groupName, url });
    setGroupName("");
    setUrl("");
    setBusy(false);
  }

  async function scan(id: number) {
    setBusy(true);
    setFlash("Scanning. This can take a minute.");
    const r = await onScan(id);
    setFlash(
      !r.ok
        ? "Scan failed."
        : r.error
        ? `Scan error: ${r.error}`
        : `Read ${r.posts ?? 0} posts, found ${r.matches ?? 0} leads.`
    );
    setBusy(false);
    setTimeout(() => setFlash(""), 6000);
  }

  return (
    <div className="subview">
      <header className="subhead">
        <div><p className="muted">Every group we scan, and how it is going.</p></div>
        {flash && <span className="flash">{flash}</span>}
      </header>

      <div className="tiles">
        <div className="tile"><span className="tile-num">{sources.filter((s) => s.active).length}</span><span className="tile-label">Active sources</span></div>
        <div className="tile"><span className="tile-num">{sources.reduce((n, s) => n + s.lastMatches, 0)}</span><span className="tile-label">Leads last pass</span></div>
        <div className="tile"><span className="tile-num">{uncovered.length}</span><span className="tile-label">Groups needing a source</span></div>
        <div className={keys.apify ? "tile tile-accent" : "tile tile-warn"}><span className="tile-num">{keys.apify ? "Live" : "No key"}</span><span className="tile-label">Scraper</span></div>
      </div>

      {!keys.apify && (
        <div className="card">
          <h3>Scraper is not connected</h3>
          <p className="muted">Add APIFY_TOKEN as a worker secret to start scanning. Until then the pipeline sits idle and you can still send leads by hand from the Members tab.</p>
        </div>
      )}
      {!keys.anthropic && keys.apify && (
        <div className="card">
          <h3>Matching runs on keywords</h3>
          <p className="muted">Add ANTHROPIC_API_KEY for proper intent matching. Keywords work, but they let more noise through.</p>
        </div>
      )}

      {uncovered.length > 0 && (
        <div className="card">
          <h3>Members are watching these, but we have no source yet</h3>
          <div className="chips">
            {uncovered.map((u) => <span className="chip" key={u}>{u}</span>)}
          </div>
          <p className="tiny">Add the group URL below and scanning starts on the next pass.</p>
        </div>
      )}

      <div className="card">
        <h3>Add a source</h3>
        <div className="form-grid">
          <input placeholder="Group name (must match what members type)" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
          <input placeholder="https://www.facebook.com/groups/..." value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <button className="btn primary mt" disabled={busy} onClick={add}>Add source</button>
      </div>

      <div className="card">
        <h3>Sources</h3>
        {sources.length === 0 ? (
          <div className="empty"><p><strong>No sources yet.</strong></p><p className="muted">Add the first group above.</p></div>
        ) : (
          sources.map((s) => (
            <div className="source-row" key={s.id}>
              <div>
                <strong>{s.groupName}</strong>
                <span className="tiny block">{s.watchers} watching · {s.lastCount} posts last pass · {s.lastMatches} leads · checked {ago(s.lastChecked)}</span>
                {s.lastError && <span className="tiny block err">Error: {s.lastError}</span>}
              </div>
              <span className="row gap">
                <span className={s.active ? "chip-status ok" : "chip-status pending"}>{s.active ? "Active" : "Paused"}</span>
                <button className="mini" disabled={busy} onClick={() => scan(s.id)}>Run now</button>
                <button className="mini" onClick={() => onAction("/api/admin/sources", { action: "update", sourceId: s.id, active: !s.active })}>{s.active ? "Pause" : "Resume"}</button>
                <button className="mini" onClick={() => onAction("/api/admin/sources", { action: "remove", sourceId: s.id })}>Delete</button>
              </span>
            </div>
          ))
        )}
      </div>
      <p className="tiny">The pipeline runs itself every 10 minutes. Run now is for testing a single group.</p>
    </div>
  );
}

function PaymentsView({ rows, stripe, onRefresh, busy }: { rows: StripeRow[]; stripe: boolean; onRefresh: () => void; busy: boolean }) {
  const paid = rows.filter((r) => r.status === "paid");
  const revenue = paid.reduce((s, r) => s + (r.amount ?? 0), 0) / 100;
  const fmt = (ts: number) => new Date(ts * 1000).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="subview">
      <header className="subhead">
        <div><p className="muted">Live from Stripe.</p></div>
        <button className="btn ghost" onClick={onRefresh} disabled={busy}>{busy ? "Refreshing" : "Refresh"}</button>
      </header>
      {!stripe ? (
        <div className="card"><h3>Stripe is not connected</h3><p className="muted">Add STRIPE_SECRET_KEY as a worker secret.</p></div>
      ) : (
        <>
          <div className="tiles">
            <div className="tile"><span className="tile-num">{paid.length}</span><span className="tile-label">Paid reservations</span></div>
            <div className="tile"><span className="tile-num">${revenue.toFixed(0)}</span><span className="tile-label">Revenue</span></div>
            <div className="tile"><span className="tile-num">{rows.length - paid.length}</span><span className="tile-label">Started, not paid</span></div>
            <div className="tile tile-accent"><span className="tile-num">{paid[0] ? fmt(paid[0].created) : "None"}</span><span className="tile-label">Latest</span></div>
          </div>
          <div className="card">
            <h3>Reservations</h3>
            {rows.length === 0 ? (
              <div className="empty"><p><strong>No checkouts yet.</strong></p></div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>When</th><th>Name</th><th>Email</th><th>Phone</th><th>Status</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td>{fmt(r.created)}</td>
                        <td>{r.name ?? "-"}</td>
                        <td>{r.email ? <a href={`mailto:${r.email}`}>{r.email}</a> : "-"}</td>
                        <td>{r.phone ? <a href={`tel:${r.phone}`}>{r.phone}</a> : "-"}</td>
                        <td><span className={r.status === "paid" ? "chip-status ok" : "chip-status pending"}>{r.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function shrinkImage(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 160;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d")!;
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function AdminHub(props: {
  active: AdminTab;
  usage: Usage | null;
  usageDays: number;
  onUsageDays: (days: number) => void;
  threads: Thread[];
  waiting: number;
  userStats: UserStats | null;
  history: HistoryPoint[];
  flash: string;
  error: string;
  ready: boolean;
  funnel: { label: string; count: number; rate: number }[];
  funnelDays: number;
  onFunnelDays: (days: number) => void;
  onLeadStatus: (email: string, status: string) => void;
  signupFunnel: { label: string; count: number; rate: number }[];
  signups: { email: string; name: string; phone: string; trade: string; status?: string; createdAt: string }[];
  tradeStats: { slug: string; views: number; signups: number; rate: number }[];
  members: Member[];
  adminCall: (path: string, payload: Record<string, unknown>) => Promise<boolean>;
  sources: Source[]; uncovered: string[]; keys: { apify: boolean; anthropic: boolean };
  onScan: (id: number) => Promise<{ ok: boolean; matches?: number; posts?: number; error?: string }>;
  stripeRows: StripeRow[]; stripeOn: boolean; onRefreshStripe: () => void; adminBusy: boolean;
}) {
  const pages: Record<AdminTab, { title: string; description: string }> = {
    users: { title: "Command centre", description: "Your numbers and every RooWatch account." },
    members: { title: "Customers", description: "Manage plans, groups, and lead tests." },
    support: { title: "Support", description: "See who needs help and reply from one place." },
    usage: { title: "Usage", description: "See what RooWatch costs to run." },
    stripe: { title: "Payments", description: "Check every Stripe checkout." },
    pipeline: { title: "Pipeline", description: "Watch the public group lead system." },
    funnel: { title: "Marketing", description: "See how people find and join RooWatch." },
  };
  const page = pages[props.active];
  return (
    <div className={props.active === "support" ? "page admin wide" : "page admin"}>
      <header className="page-head admin-head">
        <div>
          <span className="admin-eyebrow">ROOWATCH HQ</span>
          <h1>{page.title}</h1>
          <p className="muted">{page.description}</p>
        </div>
        <span className="admin-session"><i /> Admin access active</span>
      </header>
      {props.error && <p className="admin-error">{props.error}</p>}
      {!props.ready ? (
        <div className="card"><div className="empty"><span className="spinner" /><p className="muted">Loading RooWatch HQ.</p></div></div>
      ) : (
        <div className="subpanel">
          {props.active === "funnel" && <FunnelView rows={props.funnel} signupRows={props.signupFunnel} signups={props.signups} trades={props.tradeStats} days={props.funnelDays} onDays={props.onFunnelDays} onStatus={props.onLeadStatus} />}
          {props.active === "usage" && <UsageView usage={props.usage} days={props.usageDays} onDays={props.onUsageDays} />}
          {props.active === "support" && <SupportView threads={props.threads} flash={props.flash} onAction={props.adminCall} />}
          {props.active === "users" && <UsersView members={props.members} stats={props.userStats} history={props.history} flash={props.flash} onAction={props.adminCall} />}
          {props.active === "members" && <MembersView members={props.members} onAction={props.adminCall} />}
          {props.active === "pipeline" && <PipelineView sources={props.sources} uncovered={props.uncovered} keys={props.keys} onAction={props.adminCall} onScan={props.onScan} />}
          {props.active === "stripe" && <PaymentsView rows={props.stripeRows} stripe={props.stripeOn} onRefresh={props.onRefreshStripe} busy={props.adminBusy} />}
        </div>
      )}
    </div>
  );
}

/** One funnel drawn as bars. Shared by the signup path and the ad path. */
function Bars({ rows, empty }: {
  rows: { label: string; count: number; rate: number }[];
  empty: string;
}) {
  const top = rows[0]?.count ?? 0;
  if (top === 0) {
    return (
      <div className="empty">
        <p><strong>Nothing recorded yet.</strong></p>
        <p className="muted">{empty}</p>
      </div>
    );
  }
  return (
    <div className="funnel-chart">
      {rows.map((r, i) => {
        const prev = i > 0 ? rows[i - 1].count : r.count;
        const stepDrop = i > 0 && prev > 0 ? Math.round(((prev - r.count) / prev) * 100) : 0;
        const width = Math.max((r.count / top) * 100, r.count > 0 ? 3 : 0);
        return (
          <div className="fbar-row" key={r.label} title={`${r.label}: ${r.count} (${r.rate}% of top)`}>
            <span className="fbar-label">{r.label}</span>
            <div className="fbar-track">
              <div className="fbar-fill" style={{ width: `${width}%` }}>
                <span className="fbar-count">{r.count}</span>
              </div>
              <span className="fbar-rate">{r.rate}%</span>
            </div>
            {i > 0 && stepDrop > 0 && <span className="fbar-drop">&minus;{stepDrop}%</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Where Ross got to with a waitlist lead. Click the pill, pick the next step. */
function LeadPill({ email, status, onSet }: {
  email: string;
  status?: string;
  onSet: (email: string, status: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const current = leadStatus(status);

  useEffect(() => {
    if (!open) return;
    const shut = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", shut);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", shut);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <span className="dots-wrap" ref={box}>
      <button className={`lead-pill tone-${current.tone}`} onClick={() => setOpen(!open)}>
        {current.label}
        <i className="caret" />
      </button>
      {open && (
        <span className="dots-menu" role="menu">
          {LEAD_STATUSES.map((st) => (
            <button
              key={st.key}
              className={st.key === current.key ? "dots-item on" : "dots-item"}
              role="menuitem"
              onClick={() => { setOpen(false); if (st.key !== current.key) onSet(email, st.key); }}
            >
              <i className={`tone-dot tone-${st.tone}`} />
              {st.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

type UsageRow = {
  day: string;
  records: number;
  posts: number;
  texts: number;
  scraping: number;
  reading: number;
  texting: number;
  total: number;
};
type Usage = {
  days: number;
  rows: UsageRow[];
  totals: {
    scraping: number; reading: number; texting: number; spend: number;
    platform: number; records: number; posts: number; texts: number;
    postsThisMonth: number;
  };
  smsBalance: number | null;
  measured: { scraping: boolean; texting: boolean; reading: boolean };
};

const money = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

/** Every supplier bill in one place, by day. */
function UsageView({ usage, days, onDays }: {
  usage: Usage | null;
  days: number;
  onDays: (days: number) => void;
}) {
  if (!usage) {
    return <div className="subview"><div className="card"><div className="empty"><span className="spinner" /></div></div></div>;
  }

  const t = usage.totals;
  const perDay = usage.rows.length ? t.spend / usage.rows.length : 0;
  const peak = Math.max(0.0001, ...usage.rows.map((r) => r.total));
  const label = (d: string) =>
    new Date(d + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "short" });

  return (
    <div className="subview">
      <header className="subhead">
        <div><p className="muted">Everything RooWatch costs you to run, in Australian dollars.</p></div>
        <div className="range">
          {[7, 14, 30].map((d) => (
            <button key={d} className={days === d ? "range-pick on" : "range-pick"} onClick={() => onDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </header>

      <div className="tiles">
        <div className="tile tile-accent">
          <span className="tile-num">{money(t.spend)}</span>
          <span className="tile-label">Spent over {usage.days} days</span>
        </div>
        <div className="tile">
          <span className="tile-num">{money(perDay)}</span>
          <span className="tile-label">Average a day</span>
        </div>
        <div className="tile">
          <span className="tile-num">{money(perDay * 30 + t.platform)}</span>
          <span className="tile-label">On track for a month</span>
        </div>
        <div className="tile">
          <span className="tile-num">{usage.smsBalance === null ? "n/a" : money(usage.smsBalance)}</span>
          <span className="tile-label">ClickSend balance</span>
        </div>
      </div>

      <div className="card">
        <h3>What you spent, day by day</h3>
        <div className="usage-chart">
          {usage.rows.map((r) => (
            <div className="ubar-col" key={r.day} title={`${label(r.day)}  scraping ${money(r.scraping)} · reading ${money(r.reading)} · texts ${money(r.texting)}`}>
              <span className="ubar-total">{r.total > 0 ? money(r.total) : ""}</span>
              <div className="ubar-stack" style={{ height: `${Math.max(2, (r.total / peak) * 100)}%` }}>
                <i className="seg scrape" style={{ flexGrow: r.scraping || 0 }} />
                <i className="seg read" style={{ flexGrow: r.reading || 0 }} />
                <i className="seg text" style={{ flexGrow: r.texting || 0 }} />
              </div>
              <span className="ubar-day">{label(r.day)}</span>
            </div>
          ))}
        </div>
        <div className="usage-key">
          <span><i className="seg scrape" /> Scraping, Bright Data</span>
          <span><i className="seg read" /> Reading posts, Claude</span>
          <span><i className="seg text" /> Text messages, ClickSend</span>
        </div>
      </div>

      <div className="card">
        <h3>Where the money goes</h3>
        <div className="spend-grid">
          <div className="spend-row">
            <div>
              <strong>Scraping</strong>
              <span className="tiny block">Bright Data &middot; {t.records.toLocaleString()} posts bought &middot; measured</span>
            </div>
            <strong>{money(t.scraping)}</strong>
          </div>
          <div className="spend-row">
            <div>
              <strong>Reading posts</strong>
              <span className="tiny block">Claude &middot; {t.posts.toLocaleString()} posts checked &middot; estimated</span>
            </div>
            <strong>{money(t.reading)}</strong>
          </div>
          <div className="spend-row">
            <div>
              <strong>Text messages</strong>
              <span className="tiny block">ClickSend &middot; {t.texts.toLocaleString()} sent &middot; measured</span>
            </div>
            <strong>{money(t.texting)}</strong>
          </div>
          <div className="spend-row">
            <div>
              <strong>Hosting</strong>
              <span className="tiny block">Cloudflare Workers and D1 &middot; flat monthly</span>
            </div>
            <strong>{money(t.platform)}</strong>
          </div>
        </div>
        <p className="tiny">
          Scraping and texts come from the suppliers&apos; own APIs, so they are real numbers.
          Reading is worked out from how many posts we checked, because Anthropic does not
          report usage per key. Everything is converted to AUD.
        </p>
      </div>
    </div>
  );
}

function FunnelView({ rows, signupRows, signups, trades, days, onDays, onStatus }: {
  rows: { label: string; count: number; rate: number }[];
  signupRows: { label: string; count: number; rate: number }[];
  signups: { email: string; name: string; phone: string; trade: string; createdAt: string }[];
  trades: { slug: string; views: number; signups: number; rate: number }[];
  days: number;
  onDays: (days: number) => void;
  onStatus: (email: string, status: string) => void;
}) {
  const activeTrades = trades.filter((t) => t.views > 0 || t.signups > 0);
  const when = (t: string) =>
    new Date(t.replace(" ", "T") + "Z").toLocaleString("en-AU", {
      timeZone: "Australia/Perth", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  return (
    <div className="subview">
      <header className="subhead">
        <div><p className="muted">Where visitors drop out. Everything on this tab uses the range below.</p></div>
        <div className="range">
          {[7, 30, 90].map((d) => (
            <button key={d} className={days === d ? "range-pick on" : "range-pick"} onClick={() => onDays(d)}>
              {d} days
            </button>
          ))}
        </div>
      </header>
      <div className="card">
        <h3>Signups from the website</h3>
        <p className="muted">Every button on the home page goes to the signup page.</p>
        <Bars rows={signupRows} empty="Tracking starts from now. Send traffic to the home page and this fills in." />
      </div>
      <div className="card">
        <h3>Waitlist funnel from the ads</h3>
        <p className="muted">Your trade ads land on the reserve pages.</p>
        <Bars rows={rows} empty="Tracking starts from now. Send some ad traffic and this fills in." />
      </div>
      <div className="card">
        <h3>Which trade is converting</h3>
        {activeTrades.length === 0 ? (
          <div className="empty">
            <p><strong>No trade page visits yet.</strong></p>
            <p className="muted">When your ads send people to the trade pages, each one shows here with views, signups and conversion.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Trade page</th><th>Views</th><th>Signups</th><th>Conversion</th></tr></thead>
              <tbody>
                {activeTrades.map((t) => (
                  <tr key={t.slug}>
                    <td>{t.slug}</td>
                    <td>{t.views}</td>
                    <td><strong>{t.signups}</strong></td>
                    <td><span className={t.rate >= 5 ? "chip-status ok" : "chip-status pending"}>{t.rate}%</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <h3>Waitlist signups ({signups.length})</h3>
        {signups.length === 0 ? (
          <div className="empty">
            <p><strong>No signups yet.</strong></p>
            <p className="muted">Everyone who joins the waitlist shows here with their details.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Name</th><th>Trade</th><th>Phone</th><th>Email</th><th>Status</th></tr></thead>
              <tbody>
                {signups.map((w) => (
                  <tr key={w.email}>
                    <td>{when(w.createdAt)}</td>
                    <td>{w.name || "-"}</td>
                    <td>{w.trade || "-"}</td>
                    <td>{w.phone ? <a href={`tel:${w.phone.replace(/\s/g, "")}`}>{w.phone}</a> : "-"}</td>
                    <td><a href={`mailto:${w.email}`}>{w.email}</a></td>
                    <td><LeadPill email={w.email} status={w.status} onSet={onStatus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const CSS = `
.dash { --cream:#fff9f1; --ink:#172038; --muted:#6b7385; --line:#ece5da; --navy:#111d36; --coral:#ff6a4d; --coral-deep:#f04f31; --mint:#2eaa81; --mint-soft:#c9efdb; --shadow:0 30px 70px rgba(23,32,56,.13); --shadow-soft:0 12px 30px rgba(23,32,56,.08); --ease:cubic-bezier(.22,1,.36,1);
  background:var(--cream); color:var(--ink); font-family:var(--font-inter-tight),"Inter Tight",Arial,sans-serif;
  /* A column exactly one window tall. The signed-in-as bar takes its slice
     off the top and the shell fills whatever is left, so the shell is
     never pushed part way off the bottom. */
  display:flex; flex-direction:column; height:100vh; overflow:hidden; }
.dash *{box-sizing:border-box;font-family:inherit;}
.dash button{cursor:pointer;}
.boot{align-items:center;color:var(--muted);display:flex;justify-content:center;min-height:100vh;}
@keyframes dRise{from{opacity:0;transform:translateY(20px)}}
@keyframes dPop{from{opacity:0;transform:scale(.94) translateY(14px)}}
@keyframes dPulse{0%,100%{opacity:1}50%{opacity:.35}}

.brand{align-items:center;color:#fff;display:inline-flex;font-size:19px;font-weight:800;gap:9px;letter-spacing:-.04em;text-decoration:none;}
.brand-dark{color:var(--ink);}
.brand-mark{align-items:center;background:var(--coral);border-radius:8px 8px 8px 3px;color:#fff;display:inline-flex;font-size:15px;font-weight:900;height:28px;justify-content:center;transform:rotate(-6deg);width:28px;}

/* The app shell holds still and only the content area scrolls. The page
   used to scroll as one document, so on a tall view the buttons at the
   bottom of a panel walked off the screen and had to be chased. */
.topbar{display:none;}
.burger{display:none;}
.drawer-veil{display:none;}
.drawer-close{display:none;}
.shell{display:grid;flex:1;grid-template-columns:250px 1fr;min-height:0;overflow:hidden;}
.side{background:var(--navy);color:#fff;display:flex;flex-direction:column;height:100%;min-height:0;overflow-y:auto;padding:24px 16px;}
.side .brand{padding:4px 10px 22px;}
.admin-shell{grid-template-columns:270px 1fr;}
.side-admin{background:radial-gradient(circle at 30% 0,rgba(255,106,77,.18),transparent 28%),linear-gradient(180deg,#111d36 0%,#0a1326 100%);}
.side-admin .brand{border-bottom:1px solid rgba(255,255,255,.1);margin-bottom:14px;padding-bottom:22px;}
.nav{display:grid;gap:4px;margin-top:8px;}
.nav button,.side-bottom>button{align-items:center;background:none;border:0;border-radius:10px;color:#b8c3d8;display:flex;font-size:14px;font-weight:600;gap:11px;padding:11px 12px;text-align:left;transition:background .2s var(--ease),color .2s var(--ease);width:100%;}
.nav button:hover,.side-bottom>button:hover{background:rgba(255,255,255,.07);color:#fff;}
.nav button.on,.side-bottom>button.on{background:var(--coral);color:#fff;}
.side-admin .nav button.on{box-shadow:0 8px 24px rgba(255,106,77,.24);}
.admin-kicker{color:#7889a8;font-size:10px;font-weight:900;letter-spacing:.16em;padding:2px 12px 8px;}
.side-bottom{display:grid;gap:4px;margin-top:auto;}
.admin-link{color:#8fa1c0;}
.side-user{align-items:center;border-top:1px solid rgba(255,255,255,.12);display:flex;gap:10px;margin-top:12px;padding:14px 6px 2px;}
.side-user-meta{display:grid;line-height:1.25;min-width:0;}
.side-user-meta strong{font-size:13px;}
.side-user-meta span{color:#8fa1c0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.logout{background:none;border:0;color:#8fa1c0;margin-left:auto;padding:6px;transition:color .2s;}
.logout:hover{color:var(--coral);}
.avatar-img{border-radius:99px;height:34px;object-fit:cover;width:34px;}
.avatar-fallback{align-items:center;background:var(--coral);border-radius:99px;color:#fff;display:inline-flex;flex:none;font-size:12px;font-weight:800;height:34px;justify-content:center;width:34px;}

.main{min-height:0;min-width:0;overflow-y:auto;padding:36px 40px 60px;}
.admin-main{background:linear-gradient(135deg,rgba(255,255,255,.5),transparent 32%),var(--cream);}
.page{animation:dRise .45s var(--ease) both;margin:0 auto;max-width:920px;}
.page-head{align-items:center;display:flex;gap:16px;justify-content:space-between;margin-bottom:24px;}
.page-head h1{font-size:26px;letter-spacing:-.02em;margin:0 0 4px;}
.admin-head{border-bottom:1px solid var(--line);padding-bottom:20px;}
.admin-eyebrow{color:var(--coral-deep);display:block;font-size:10px;font-weight:900;letter-spacing:.18em;margin-bottom:5px;}
.admin-session{align-items:center;background:#e2f6ec;border:1px solid #c8ead9;border-radius:99px;color:#1d8a63;display:inline-flex;font-size:12px;font-weight:800;gap:7px;padding:8px 12px;white-space:nowrap;}
.admin-session i{background:var(--mint);border-radius:99px;height:7px;width:7px;}
.admin-error{background:#fdece8;border:1px solid #f7c9bf;border-radius:12px;color:var(--coral-deep);font-size:13px;font-weight:700;margin:-6px 0 18px;padding:12px 14px;}
.muted{color:var(--muted);font-size:14px;line-height:1.55;margin:0;}
.live{align-items:center;color:var(--mint);display:inline-flex;font-size:13px;font-weight:700;gap:7px;white-space:nowrap;}
.live i{animation:dPulse 1.6s ease-in-out infinite;background:var(--mint);border-radius:99px;display:inline-block;height:8px;width:8px;}

.tiles{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:18px;}
.tile{animation:dRise .5s var(--ease) both;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-soft);display:grid;gap:4px;padding:18px 20px;text-align:left;transition:transform .25s var(--ease),box-shadow .25s var(--ease),border-color .25s var(--ease);}
/* A tile that goes somewhere. It has to look like it does, or nobody taps it. */
.tile.tap{cursor:pointer;position:relative;}
.tile.tap::after{color:#c7ccd6;content:"›";font-size:19px;line-height:1;position:absolute;right:16px;top:16px;transition:color .2s var(--ease),transform .2s var(--ease);}
.tile.tap:hover{border-color:var(--coral);box-shadow:var(--shadow);transform:translateY(-3px);}
.tile.tap:hover::after{color:var(--coral);transform:translateX(3px);}
.tile.tap:active{transform:translateY(-1px);}
.tile:hover{box-shadow:var(--shadow);transform:translateY(-3px);}
.tile:nth-child(2){animation-delay:.05s}.tile:nth-child(3){animation-delay:.1s}.tile:nth-child(4){animation-delay:.15s}

/* The scan card. White like the rest of the row, and busy on purpose: it is
   the only thing on this page that proves the machine is running while a
   member has no leads to look at. */
.scan{align-content:space-between;gap:0;min-height:96px;}
.scan-top{align-items:center;display:flex;gap:9px;}
.scan-face{align-items:center;display:inline-flex;flex:none;height:16px;justify-content:center;width:16px;}
.scan.idle{justify-content:flex-start;}
.scan-still{background:#c9ced8;border-radius:99px;height:8px;width:8px;}
.scan-idle-label{color:var(--muted);font-size:12.5px;font-weight:700;}
.scan-idle-note{color:var(--muted);margin:10px 0 0;}
.scan-dot{background:var(--mint);border-radius:99px;height:8px;width:8px;animation:scanBreathe 2.4s var(--ease) infinite;}
.scan-spin{animation:scanSpin .8s linear infinite;border:2px solid var(--line);border-radius:99px;border-top-color:var(--coral);height:15px;width:15px;}
.scan-track{background:var(--line);border-radius:99px;height:6px;margin-top:14px;overflow:hidden;}
.scan-track i{border-radius:99px;display:block;height:100%;}
.scan-fill{animation:scanFill linear forwards;background:linear-gradient(90deg,var(--mint),#54c79c);width:0;}
.scan-full{animation:scanBusy 1s var(--ease) infinite;background:linear-gradient(90deg,var(--coral),#ffa46d);width:100%;}
@keyframes scanFill{from{width:0;}to{width:100%;}}
@keyframes scanSpin{to{transform:rotate(360deg);}}
@keyframes scanBreathe{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.4;transform:scale(.82);}}
@keyframes scanBusy{0%,100%{opacity:1;}50%{opacity:.55;}}

/* One line of text leaving downwards while the next rolls up behind it. */
.roll{display:block;flex:1;height:17px;line-height:17px;min-width:0;overflow:hidden;position:relative;}
.roll > span{color:var(--muted);display:block;font-size:12.5px;font-weight:600;left:0;line-height:17px;overflow:hidden;position:absolute;text-overflow:ellipsis;top:0;white-space:nowrap;width:100%;}
.roll-in{animation:rollIn .38s var(--ease) both;}
.roll-out{animation:rollOut .38s var(--ease) both;}
.scan.working .roll > span{color:var(--ink);}
@keyframes rollIn{from{opacity:0;transform:translateY(100%);}to{opacity:1;transform:none;}}
@keyframes rollOut{from{opacity:1;transform:none;}to{opacity:0;transform:translateY(-100%);}}

@media(prefers-reduced-motion:reduce){
  .scan-fill,.scan-full,.scan-spin,.scan-dot{animation:none;}
  .scan-fill{width:100%;}
  .roll-in,.roll-out{animation:none;}
  .roll-out{display:none;}
}
.tile-num{font-size:24px;font-weight:800;letter-spacing:-.02em;}
.tile-label{color:var(--muted);font-size:12.5px;font-weight:600;}
.tile-accent{background:var(--navy);border-color:var(--navy);color:#fff;}
.tile-accent .tile-label{color:#8fa1c0;}
.tile-success{background:#e2f6ec;border-color:#c8ead9;color:#14724f;}
.tile-success .tile-label{color:#1d8a63;}

.card{animation:dRise .5s .1s var(--ease) both;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-soft);margin-bottom:18px;padding:22px 24px;}
.card h3{font-size:15px;letter-spacing:.02em;margin:0 0 14px;}
.card h3.mt{margin-top:20px;}
.empty{padding:18px 0 10px;text-align:center;}
.empty p{margin:0 0 6px;}
.group-row{align-items:center;border-top:1px solid #f4efe7;display:flex;font-size:14.5px;justify-content:space-between;padding:12px 2px;}
.group-row:first-of-type{border-top:0;}
.group-name{font-weight:600;}
.group-stack{display:grid;gap:3px;min-width:0;}
.group-waiting{align-items:center;color:var(--muted);display:flex;font-size:11.5px;gap:6px;}
.spinner.tiny{border-width:2px;height:11px;width:11px;}
.chip-status{border-radius:99px;font-size:11.5px;font-weight:800;padding:5px 11px;white-space:nowrap;}
.chip-status.ok{background:#e2f6ec;color:#1d8a63;}
.chip-status.pending{background:#fff3d8;color:#8a5a00;}

.alert-item{align-items:center;border-top:1px solid #f4efe7;display:flex;gap:20px;padding:18px 2px;}
.alert-item:first-of-type{border-top:0;}
.alert-main{flex:1;min-width:0;}
.alert-top{align-items:baseline;display:flex;gap:10px;}
.alert-top strong{font-size:14px;letter-spacing:-.01em;}
.alert-text{color:#3c465e;font-size:14.5px;line-height:1.5;margin:6px 0 0;}
.alert-reason{align-items:center;color:var(--mint);display:flex;font-size:13px;font-weight:700;gap:6px;margin:8px 0 0;}
.alert-reason::before{content:"";background:var(--mint);border-radius:99px;flex:none;height:6px;width:6px;}
.btn-go{align-items:center;background:var(--mint);border-radius:99px;box-shadow:0 4px 0 #1f7d5f,0 10px 20px rgba(46,170,129,.28);color:#fff;display:inline-flex;flex:none;font-size:14px;font-weight:800;gap:8px;padding:11px 20px;text-decoration:none;transition:transform .18s var(--ease),box-shadow .18s var(--ease),background .18s var(--ease);}
.btn-go:hover{background:#279c76;box-shadow:0 6px 0 #1f7d5f,0 14px 24px rgba(46,170,129,.34);transform:translateY(-2px);}
.btn-go:active{box-shadow:0 1px 0 #1f7d5f,0 6px 12px rgba(46,170,129,.25);transform:translateY(2px);}
@media(max-width:640px){
  .alert-item{align-items:stretch;flex-direction:column;gap:12px;}
  .btn-go{justify-content:center;}
}

.kv{border-top:1px solid #f4efe7;display:flex;font-size:14px;gap:16px;justify-content:space-between;padding:11px 2px;}
.kv span{color:var(--muted);flex:none;}
.kv strong{text-align:right;}
.profile-row{align-items:center;display:flex;gap:14px;margin-bottom:14px;}
.profile-row .avatar-img,.profile-row .avatar-fallback{font-size:16px;height:52px;width:52px;}
.tiny{color:#98a0b3;font-size:12.5px;margin:12px 0 0;}
.tiny.block{display:block;margin:3px 0 0;}
.linkish{background:none;border:0;color:var(--coral);font-size:12.5px;font-weight:700;padding:0;}
.flash{color:var(--mint);font-size:13px;font-weight:700;}

.btn{align-items:center;border:0;border-radius:99px;display:inline-flex;font-size:14px;font-weight:700;gap:8px;justify-content:center;padding:11px 20px;transition:transform .2s var(--ease),background .2s;}
.btn:hover{transform:translateY(-1px);}
.btn:disabled{cursor:default;opacity:.5;transform:none;}
.btn.primary{background:var(--coral);box-shadow:0 10px 22px rgba(240,79,49,.3);color:#fff;}
.btn.primary:hover:not(:disabled){background:var(--coral-deep);}
.btn.ghost{background:#fff;border:1px solid var(--line);color:var(--ink);}
.btn.wide{margin-top:18px;width:100%;}
.mini{background:none;border:0;color:#98a0b3;font-size:12.5px;font-weight:700;}
.mini:hover{color:var(--coral);}

.login{align-items:center;display:flex;justify-content:center;min-height:100vh;padding:20px;}
.login-card{animation:dPop .5s var(--ease) both;background:#fff;border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);max-width:400px;padding:36px;width:100%;}
.login-card h1{font-size:26px;letter-spacing:-.02em;margin:22px 0 6px;}
.login-card label{display:block;font-size:12.5px;font-weight:700;margin:16px 0 6px;}
.dash input,.dash textarea{background:#faf7f2;border:1px solid var(--line);border-radius:10px;color:var(--ink);font-size:14.5px;margin-bottom:0;outline:none;padding:12px 14px;resize:vertical;transition:border-color .2s;width:100%;}
.dash input:focus,.dash textarea:focus{border-color:var(--coral);}
.dash select{background:#faf7f2;border:1px solid var(--line);border-radius:10px;color:var(--ink);font-family:inherit;font-size:14.5px;outline:none;padding:12px 14px;transition:border-color .2s;width:100%;}
.dash select:focus{border-color:var(--coral);}
.dash textarea{margin-top:10px;}

/* A fixed overlay does not scroll, so a modal taller than the window used
   to lose its own buttons off the bottom edge. The wizard hit this the
   moment somebody added their tenth group: Continue was still there and
   still enabled, just below the screen with no way to reach it.
   flex-start plus margin:auto keeps a short modal centred and keeps a
   tall one fully scrollable from its very top. */
.overlay{align-items:flex-start;overscroll-behavior:contain;animation:dRise .3s var(--ease) both;backdrop-filter:blur(4px);background:rgba(17,29,54,.55);display:flex;inset:0;justify-content:center;overflow-y:auto;padding:20px;position:fixed;z-index:50;}
.modal{animation:dPop .45s var(--ease) both;background:#fff;border-radius:20px;box-shadow:var(--shadow);display:flex;flex-direction:column;margin:auto;max-height:80vh;max-width:460px;padding:32px;width:100%;}
/* Everything between the heading and the buttons scrolls, so the buttons are
   always reachable and the page behind never grows. */
.modal .wiz-body{flex:1;margin:0 -32px;min-height:0;overflow-y:auto;padding:0 32px;}
.modal .row.spread{flex:none;padding-top:18px;}
.modal h2{font-size:22px;letter-spacing:-.02em;margin:0 0 6px;}
.modal .muted{margin-bottom:18px;}
.modal-small{max-width:380px;}
.steps-dots{display:flex;gap:7px;margin-bottom:20px;}
.dot{background:var(--line);border-radius:99px;height:7px;transition:all .3s var(--ease);width:7px;}
.dot.on{background:var(--coral);width:22px;}
.dot.done{background:var(--mint);}
.row{align-items:center;display:flex;}
.row.gap{gap:10px;}
.row.mt{margin-top:12px;}
.row.spread{justify-content:space-between;margin-top:22px;}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}
.chip{align-items:center;background:var(--mint-soft);border-radius:99px;color:#14724f;display:inline-flex;font-size:13px;font-weight:700;gap:7px;padding:6px 8px 6px 13px;}
.chip button{background:none;border:0;color:#14724f;font-size:15px;line-height:1;padding:0 4px;}
.error{color:var(--coral-deep);font-size:13px;font-weight:600;margin:10px 0 0;}
.modal .row.gap{justify-content:flex-end;margin-top:18px;}
.form-grid{display:grid;gap:10px;grid-template-columns:1fr 1fr;}

.lbl{display:block;font-size:12.5px;font-weight:700;margin:14px 0 6px;}
.card-head{align-items:center;display:flex;gap:12px;justify-content:space-between;}
.card-head h3{margin:0;}
/* The button is taller than the label text. Give the pair its own band and
   centre them, or the button drags the whole row up into the field above. */
.lbl-row{align-items:center;display:flex;gap:14px;justify-content:space-between;margin:22px 0 8px;min-height:36px;}
.lbl-row .lbl{margin:0;}
/* A label sits 6px above its input. Textareas were adding 10px more. */
.lbl+textarea,.lbl-row+textarea{margin-top:0;}

.save-state{align-items:center;animation:dRise .25s var(--ease) both;color:var(--muted);display:inline-flex;font-size:12.5px;font-weight:700;gap:5px;}
.save-state.ok{color:var(--mint);}

.ai-btn{align-items:center;background:linear-gradient(103deg,#6d5bf6 0%,#a24cf0 45%,#f0518f 100%);border:0;border-radius:99px;box-shadow:0 4px 14px rgba(122,79,240,.34);color:#fff;display:inline-flex;flex:none;font-size:12.5px;font-weight:800;justify-content:center;min-width:104px;overflow:hidden;padding:9px 16px;position:relative;transition:transform .18s var(--ease),box-shadow .18s var(--ease),filter .18s;}
.ai-btn:hover:not(:disabled){box-shadow:0 7px 20px rgba(122,79,240,.42);transform:translateY(-1px);}
.ai-btn:active:not(:disabled){transform:translateY(1px);}
.ai-btn:disabled{cursor:default;filter:saturate(.6);opacity:.75;}
.ai-btn::after{animation:aiShine 3.4s var(--ease) infinite;background:linear-gradient(103deg,transparent 25%,rgba(255,255,255,.6) 50%,transparent 75%);content:"";inset:0;pointer-events:none;position:absolute;}
.ai-face{align-items:center;display:inline-flex;gap:6px;position:relative;z-index:1;}
.ai-face svg{flex:none;}
@keyframes aiShine{0%{transform:translateX(-115%)}55%,100%{transform:translateX(115%)}}
@media(prefers-reduced-motion:reduce){.ai-btn::after{animation:none;opacity:0;}}
.card.danger{border-color:#f6d5cd;}
.btn.danger-btn{background:var(--coral-deep);color:#fff;}
.btn.mt{margin-top:14px;}
.tile-warn{background:#fff3d8;border-color:#f2ddaa;}
.tile-warn .tile-label{color:#8a5a00;}
.source-row{align-items:center;border-top:1px solid #f4efe7;display:flex;gap:14px;justify-content:space-between;padding:13px 2px;}
.source-row:first-of-type{border-top:0;}
.tiny.err{color:var(--coral-deep);}
.member-head{align-items:center;cursor:pointer;display:flex;gap:14px;justify-content:space-between;}
.plan-switch{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;}
.plan-pick{background:#faf7f2;border:1px solid var(--line);border-radius:99px;color:var(--muted);font-size:12px;font-weight:700;padding:6px 12px;transition:background .18s var(--ease),color .18s,border-color .18s;}
.plan-pick:hover:not(:disabled){border-color:var(--coral);color:var(--ink);}
.plan-pick.on{background:var(--coral);border-color:var(--coral);color:#fff;}
.plan-pick:disabled{cursor:default;opacity:.6;}
.member-body{animation:dRise .35s var(--ease) both;border-top:1px solid #f4efe7;margin-top:16px;padding-top:6px;}
.table-wrap{overflow-x:auto;}
.admin table{border-collapse:collapse;font-size:13.5px;width:100%;}
.admin th{border-bottom:1px solid var(--line);color:#8b93a7;font-size:11.5px;letter-spacing:.05em;padding:9px 10px;text-align:left;text-transform:uppercase;}
.admin td{border-bottom:1px solid #f6f1e9;padding:11px 10px;white-space:nowrap;}
.admin td a{color:var(--coral-deep);text-decoration:none;}

@media(max-width:860px){
  /* One narrow column has no room for a fixed shell, so the page scrolls as
     one again and the sidebar becomes a drawer. */
  .dash{display:block;height:auto;overflow:visible;}
  .shell{grid-template-columns:1fr;min-height:100vh;overflow:visible;}
  .main{overflow:visible;padding:18px 16px 64px;}

  .topbar{align-items:center;background:var(--navy);display:flex;justify-content:space-between;padding:12px 16px;position:sticky;top:0;z-index:45;}
  .topbar .brand{font-size:17px;padding:0;}

  .burger{background:none;border:0;display:grid;gap:4px;padding:8px 4px;}
  .burger i{background:#fff;border-radius:2px;display:block;height:2px;width:22px;}

  .drawer-veil{background:rgba(10,17,32,.5);display:block;inset:0;position:fixed;z-index:48;animation:dRise .2s var(--ease) both;}

  /* The sidebar slides in from the left rather than wrapping across the top. */
  .side{bottom:0;height:auto;left:0;max-width:82vw;overflow-y:auto;padding:18px 16px 24px;position:fixed;top:0;transform:translateX(-100%);transition:transform .28s var(--ease);width:290px;z-index:49;}
  .side.open{transform:none;}
  .side .brand{padding:4px 8px 20px;}
  .drawer-close{align-items:center;background:rgba(255,255,255,.1);border:0;border-radius:99px;color:#fff;display:inline-flex;height:34px;justify-content:center;position:absolute;right:14px;top:14px;width:34px;}
  .drawer-close svg{height:15px;width:15px;}

  .nav{display:grid;gap:4px;margin:0;}
  .nav button{font-size:15px;padding:13px 12px;}
  .side-bottom{display:grid;margin-top:24px;}
  .side-user{border-top:1px solid rgba(255,255,255,.12);margin-top:12px;padding:14px 6px 2px;}
  .side-user-meta{display:grid;}

  .tiles{grid-template-columns:repeat(2,1fr);}
  .form-grid{grid-template-columns:1fr;}
  .ov-split{grid-template-columns:1fr;}
  .chat-card{height:auto;}
  .thread-list{max-height:50vh;}

  /* Readable on a phone without shouting. */
  .tiny,.cost-label,.tile-label{font-size:12.5px;}
  .page-head h1{font-size:22px;}
  .modal,.modal-wide{padding:22px 18px;}
  .modal h2{font-size:20px;}
  .wiz-table td{padding:11px 8px;}
  .size-cell{display:none;}
  .act-cell .mini{padding:8px 10px;}

  /* Pictures sized for a phone, not a desktop hero. */
  .allset-roo,.needcard-roo{height:84px;width:84px;}
  .wiz-logo{height:30px;}
  img{max-width:100%;}
}
}

@media(max-width:640px){
  .admin-head{align-items:flex-start;}
  .admin-session{font-size:0;padding:9px;}
  .admin-session i{height:8px;width:8px;}
}

.subtabs{border-bottom:1px solid var(--line);display:flex;gap:4px;margin-bottom:22px;overflow-x:auto;}
.subtab{background:none;border:0;border-bottom:2px solid transparent;color:var(--muted);font-size:14px;font-weight:700;margin-bottom:-1px;padding:10px 14px;transition:color .2s var(--ease),border-color .2s var(--ease);white-space:nowrap;}
.subtab:hover{color:var(--ink);}
.subtab.on{border-bottom-color:var(--coral);color:var(--ink);}
.subpanel{animation:dRise .35s var(--ease) both;}
.subview{margin:0;}
.subhead{margin-bottom:16px;}
.subhead .muted{font-size:13.5px;}

.ghost-bar{align-items:center;background:#111d36;color:#fff;display:flex;flex:none;flex-wrap:wrap;font-size:13.5px;gap:12px;justify-content:center;padding:11px 18px;text-align:center;z-index:60;}
.ghost-bar strong{color:var(--coral);}
.ghost-bar button{background:#fff;border:0;border-radius:99px;color:#111d36;font-size:12.5px;font-weight:800;padding:7px 14px;}
.switch{background:#dfe3ea;border:0;border-radius:99px;flex:none;height:26px;padding:3px;transition:background .2s var(--ease);width:46px;}
.switch i{background:#fff;border-radius:99px;box-shadow:0 1px 3px rgba(0,0,0,.2);display:block;height:20px;transition:transform .2s var(--ease);width:20px;}
.switch.on{background:var(--mint);}
.switch.on i{transform:translateX(20px);}
.switch:disabled{cursor:default;opacity:.45;}

/* ---- users tab ---- */
.mb{margin-bottom:14px;}
.user-search{max-width:260px;}
.user-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));margin-top:16px;}
.user-card{background:#fff;border:1px solid var(--line);border-radius:14px;display:grid;gap:11px;padding:15px;text-align:left;transition:border-color .18s var(--ease),box-shadow .18s var(--ease),transform .18s var(--ease);}
.user-card:hover{border-color:var(--coral);box-shadow:var(--shadow-soft);transform:translateY(-2px);}
.user-card-top{align-items:center;display:flex;gap:11px;min-width:0;}
.user-card-who{display:grid;line-height:1.3;min-width:0;}
.user-card-who strong{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.user-card-who span{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.user-card-meta{display:flex;flex-wrap:wrap;gap:7px;}
.user-card.journey-left-at-stripe{border-left:4px solid #e0a80f;}
.user-card.journey-card-added{border-left:4px solid var(--mint);}
.user-card.journey-payment-issue,.user-card.journey-plan-stopped{border-left:4px solid var(--coral-deep);}
.user-card-money{border-radius:9px;font-size:12px;font-weight:800;padding:8px 10px;}
.user-card-money.ok{background:#e2f6ec;color:#14724f;}
.user-card-money.pending{background:#eef1f6;color:#4a5468;}
.user-card-money.warn{background:#fff3d8;color:#8a5a00;}
.user-card-money.bad{background:#fdece8;color:var(--coral-deep);}
.user-card-foot{color:var(--muted);display:flex;font-size:12px;gap:10px;justify-content:space-between;}
.plan-tag{border-radius:99px;font-size:11px;font-weight:800;padding:4px 10px;}
.plan-local{background:#eef1f6;color:#4a5468;}
.plan-growth{background:var(--mint-soft);color:#14724f;}
.plan-scale{background:#efe4ff;color:#5b3a9c;}
.chip-status.bad{background:#fdece8;color:var(--coral-deep);}
.chip-status.warn{background:#fff3d8;color:#8a5a00;}

.growth{margin:6px 0 0;}
.growth-plot{display:grid;grid-template-columns:auto 1fr auto;gap:10px;}
.growth-canvas{min-width:0;}
.growth-axis{display:flex;flex-direction:column;justify-content:space-between;padding-bottom:19px;}
.growth-axis span{color:var(--muted);font-size:10.5px;font-variant-numeric:tabular-nums;font-weight:700;line-height:1;}
.growth-axis.left span{color:var(--coral-deep);text-align:right;}
.growth-axis.right span{color:var(--mint);text-align:left;}
.growth-grid{stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke;}
.growth-x{display:flex;justify-content:space-between;padding-top:6px;}
.growth-x span{color:var(--muted);font-size:10.5px;font-variant-numeric:tabular-nums;font-weight:700;}
.growth-svg{display:block;height:170px;width:100%;}
.growth-fill{fill:rgba(255,106,77,.1);stroke:none;}
.growth-users{fill:none;stroke:var(--coral);stroke-width:2.5;vector-effect:non-scaling-stroke;}
.growth-mrr{fill:none;stroke:var(--mint);stroke-dasharray:5 4;stroke-width:2.5;vector-effect:non-scaling-stroke;}
.growth-key{align-items:center;color:var(--muted);display:flex;flex-wrap:wrap;font-size:12.5px;font-weight:700;gap:16px;margin-top:10px;}
.growth-key i{border-radius:2px;display:inline-block;height:3px;margin-right:6px;vertical-align:middle;width:16px;}
.key-users{background:var(--coral);}
.key-mrr{background:var(--mint);}

.plan-switch.left{justify-content:flex-start;margin-top:8px;}

.day-group{margin-bottom:22px;}
.day-group:last-of-type{margin-bottom:0;}
.day-head{align-items:center;background:#fff;display:flex;gap:12px;justify-content:space-between;padding:2px 0 11px;position:sticky;top:0;z-index:1;}
.day-name{color:var(--ink);font-size:13px;font-weight:800;letter-spacing:-.01em;}
.day-count{color:#98a0b3;flex:none;font-size:11.5px;font-weight:700;}
.day-head::after{background:var(--line);content:"";flex:1;height:1px;order:1;}
.day-count{order:2;}

/* Renaming happens where the name already is, not in a browser prompt. */
.name-edit{background:#fff;border:1px solid var(--coral);border-radius:9px;box-shadow:0 0 0 3px rgba(255,106,77,.14);flex:1;font-size:14.5px;font-weight:700;margin-right:12px;min-width:0;padding:8px 11px;}
.icon-btn{align-items:center;background:#f6f1e9;border:0;border-radius:8px;color:var(--muted);display:inline-flex;height:30px;justify-content:center;transition:background .18s,color .18s;width:30px;}
.icon-btn:hover:not(:disabled){background:#ece5da;color:var(--ink);}
.icon-btn.save{background:var(--mint-soft);color:#14724f;}
.icon-btn.save:hover:not(:disabled){background:var(--mint);color:#fff;}
.icon-btn:disabled{cursor:default;opacity:.45;}

.dots-wrap{display:inline-flex;position:relative;}
.dots{align-items:center;background:none;border:0;border-radius:8px;color:#a8b0c0;display:inline-flex;height:30px;justify-content:center;transition:background .18s,color .18s;width:30px;}
.dots:hover,.dots.on{background:#f2eee7;color:var(--ink);}
.dots-menu{animation:dPop .16s var(--ease) both;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 16px 36px rgba(23,32,56,.16);display:grid;min-width:212px;overflow:hidden;padding:5px;position:absolute;right:0;top:34px;z-index:20;}
.dots-item{align-items:center;background:none;border:0;border-radius:8px;color:var(--ink);display:flex;font-size:13.5px;font-weight:600;gap:9px;padding:9px 11px;text-align:left;text-decoration:none;transition:background .15s;white-space:nowrap;width:100%;}
.dots-item:hover{background:#faf7f2;}
.dots-item.danger{color:var(--coral-deep);}
.dots-item.danger:hover{background:#fdece8;}
.dots-item.off{color:#a8b0c0;cursor:default;font-weight:500;}
.dots-item svg{flex:none;opacity:.7;}

/* Matches the input beside it. A pill next to a rounded rectangle looks wrong. */
.lead-pill{align-items:center;border:1px solid transparent;border-radius:99px;display:inline-flex;font-size:11.5px;font-weight:800;gap:6px;padding:5px 10px;transition:filter .18s;white-space:nowrap;}
.lead-pill:hover{filter:brightness(.96);}
.lead-pill .caret{border-left:4px solid transparent;border-right:4px solid transparent;border-top:4px solid currentColor;display:inline-block;opacity:.6;}
.tone-grey{background:#eef1f6;color:#4a5468;}
.tone-amber{background:#fff3d8;color:#8a5a00;}
.tone-green{background:var(--mint-soft);color:#14724f;}
.tone-red{background:#fdece8;color:var(--coral-deep);}
.tone-dot{border-radius:99px;display:inline-block;flex:none;height:9px;width:9px;}
.tone-dot.tone-grey{background:#8b93a7;}
.tone-dot.tone-amber{background:#e0a80f;}
.tone-dot.tone-green{background:var(--mint);}
.tone-dot.tone-red{background:var(--coral-deep);}
.dots-item.on{background:#faf7f2;font-weight:800;}

.sub-plans{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin:16px 0 4px;}
.sub-plan{background:#faf7f2;border:1px solid var(--line);border-radius:12px;display:grid;gap:2px;padding:12px 14px;position:relative;}
.sub-plan strong{font-size:14px;}
.sub-plan span{color:var(--muted);font-size:12px;}
.sub-plan.on{background:#fff;border-color:var(--coral);box-shadow:var(--shadow-soft);}
.sub-plan em{color:var(--coral-deep);font-size:11px;font-style:normal;font-weight:800;margin-top:3px;}

.usage-chart{align-items:flex-end;display:flex;gap:6px;height:230px;margin-top:14px;overflow-x:auto;padding-bottom:4px;}
.ubar-col{align-items:center;display:flex;flex:1;flex-direction:column;gap:5px;height:100%;justify-content:flex-end;min-width:34px;}
.ubar-total{color:var(--muted);font-size:10.5px;font-weight:800;white-space:nowrap;}
.ubar-stack{background:#f4f1ec;border-radius:6px;display:flex;flex-direction:column-reverse;min-height:4px;overflow:hidden;transition:height .4s var(--ease);width:100%;}
.ubar-stack .seg{display:block;min-height:0;width:100%;}
.ubar-day{color:#a8b0c0;font-size:10.5px;font-weight:600;white-space:nowrap;}
.seg.scrape{background:var(--coral);}
.seg.read{background:#7a6ff0;}
.seg.text{background:var(--mint);}
.usage-key{color:var(--muted);display:flex;flex-wrap:wrap;font-size:12.5px;font-weight:600;gap:18px;margin-top:14px;}
.usage-key .seg{border-radius:3px;display:inline-block;height:9px;margin-right:7px;vertical-align:middle;width:14px;}
.spend-grid{display:grid;gap:2px;margin-top:6px;}
.spend-row{align-items:center;border-top:1px solid #f4efe7;display:flex;gap:16px;justify-content:space-between;padding:13px 2px;}
.spend-row:first-child{border-top:0;}
.spend-row strong{font-size:14px;}

.range{background:#f6f1e9;border-radius:99px;display:flex;gap:3px;padding:3px;}
.range-pick{background:none;border:0;border-radius:99px;color:var(--muted);font-size:12.5px;font-weight:700;padding:7px 13px;transition:background .18s var(--ease),color .18s;}
.range-pick:hover{color:var(--ink);}
.range-pick.on{background:#fff;box-shadow:0 2px 8px rgba(23,32,56,.1);color:var(--ink);}

.btn.square{border-radius:10px;}
/* The support tab is a workspace, not a reading column. Let it use the screen. */
.page.admin.wide{max-width:1440px;}
.wide .chat-log{max-height:none;}

.confetti{inset:0;overflow:hidden;pointer-events:none;position:fixed;z-index:90;}
.confetti i{animation:fall linear forwards;position:absolute;top:-24px;will-change:transform,opacity;}
@keyframes fall{
  0%{opacity:0;transform:translate3d(0,0,0) rotate(0deg);}
  8%{opacity:1;}
  85%{opacity:1;}
  100%{opacity:0;transform:translate3d(var(--drift),102vh,0) rotate(var(--spin));}
}
@media(prefers-reduced-motion:reduce){.confetti{display:none;}}

/* ---- support bubble ---- */
.rw-chat{bottom:22px;position:fixed;right:22px;z-index:80;}
.rw-launcher{align-items:center;background:var(--coral);border:0;border-radius:99px;box-shadow:0 10px 28px rgba(240,79,49,.42);color:#fff;display:flex;height:56px;justify-content:center;margin-left:auto;position:relative;transition:transform .22s var(--ease),box-shadow .22s var(--ease),background .2s;width:56px;}
.rw-launcher:hover{background:var(--coral-deep);box-shadow:0 14px 34px rgba(240,79,49,.5);transform:translateY(-2px) scale(1.04);}
.rw-launcher:active{transform:translateY(0) scale(.96);}
.rw-launcher.open{background:var(--navy);box-shadow:0 10px 28px rgba(17,29,54,.4);}
.rw-icon-swap{align-items:center;animation:rwSpin .28s var(--ease) both;display:flex;}
@keyframes rwSpin{from{opacity:0;transform:rotate(-90deg) scale(.6)}}
.rw-badge{align-items:center;animation:rwPing .4s var(--ease) both;background:#fff;border-radius:99px;box-shadow:0 2px 8px rgba(0,0,0,.2);color:var(--coral-deep);display:flex;font-size:11.5px;font-weight:900;height:21px;justify-content:center;min-width:21px;padding:0 5px;position:absolute;right:-2px;top:-2px;}
@keyframes rwPing{from{opacity:0;transform:scale(.3)}60%{transform:scale(1.15)}}

.rw-panel{animation:rwIn .26s var(--ease) both;background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:0 24px 60px rgba(23,32,56,.24);display:flex;flex-direction:column;height:min(74vh,540px);margin-bottom:14px;overflow:hidden;transform-origin:bottom right;width:min(92vw,372px);}
.rw-panel.out{animation:rwOut .18s var(--ease) both;}
@keyframes rwIn{from{opacity:0;transform:translateY(16px) scale(.9)}}
@keyframes rwOut{to{opacity:0;transform:translateY(12px) scale(.92)}}

.rw-panel-head{align-items:center;background:var(--navy);color:#fff;display:flex;gap:12px;justify-content:space-between;padding:15px 18px;}
.rw-panel-head strong{display:block;font-size:15px;}
.rw-panel-head span{color:#9fb0cc;font-size:12px;}
.rw-x{background:rgba(255,255,255,.12);border:0;border-radius:8px;color:#fff;display:flex;padding:6px;transition:background .18s;}
.rw-x:hover{background:rgba(255,255,255,.24);}

.rw-log{align-content:start;display:grid;gap:10px;flex:1;overflow-y:auto;padding:16px;}
.rw-log .bubble{max-width:84%;}
.rw-log .bubble p{overflow-wrap:anywhere;}
.rw-log .bubble p{font-size:14px;}
.rw-empty{align-items:center;color:var(--muted);display:flex;flex-direction:column;gap:6px;justify-content:center;height:100%;padding:20px;text-align:center;}
.rw-empty strong{color:var(--ink);font-size:15px;}
.rw-empty p{font-size:13.5px;line-height:1.55;margin:0;}
.bubble-row.pop .bubble{animation:rwPop .3s var(--ease) both;}
@keyframes rwPop{from{opacity:0;transform:translateY(8px) scale(.94)}}

.bubble.sending{align-items:center;display:flex;gap:5px;padding:14px 16px;}
.bubble.sending .dot{animation:rwDot 1.1s infinite ease-in-out;background:rgba(255,255,255,.85);border-radius:99px;height:6px;width:6px;}
.bubble.sending .dot:nth-child(2){animation-delay:.16s;}
.bubble.sending .dot:nth-child(3){animation-delay:.32s;}
@keyframes rwDot{0%,70%,100%{opacity:.35;transform:translateY(0)}35%{opacity:1;transform:translateY(-4px)}}

.rw-send{align-items:flex-end;border-top:1px solid var(--line);display:flex;gap:8px;padding:12px 14px;}
.rw-send textarea{background:#faf7f2;border-radius:12px;font-size:14px;margin:0;max-height:110px;min-height:42px;padding:11px 13px;}
.rw-send-btn{align-items:center;background:var(--coral);border:0;border-radius:12px;color:#fff;display:flex;flex:none;height:42px;justify-content:center;transition:background .18s,transform .18s var(--ease);width:42px;}
.rw-send-btn:hover:not(:disabled){background:var(--coral-deep);transform:scale(1.06);}
.rw-send-btn:active:not(:disabled){transform:scale(.92);}
.rw-send-btn:disabled{background:#f3c6bb;cursor:default;}
@media(max-width:520px){.rw-chat{bottom:16px;right:16px;}}
@media(prefers-reduced-motion:reduce){.rw-panel,.rw-panel.out,.rw-icon-swap,.rw-badge,.bubble-row.pop .bubble{animation:none;}}

/* ---- support chat ---- */
/* Sized to the window, so the reply box is always on screen and the
   messages scroll behind it. */
.chat-card{display:flex;flex-direction:column;height:calc(100vh - 400px);min-height:340px;padding:0;}
.chat-head{border-bottom:1px solid var(--line);display:grid;gap:2px;padding:16px 20px;}
.chat-log{align-content:start;display:grid;gap:12px;flex:1;min-height:0;overflow-y:auto;padding:20px;}
.wide .chat-log{max-height:none;}
.bubble-row{align-items:flex-start;display:flex;}
.bubble-row.me{justify-content:flex-end;}
.bubble{border-radius:14px;max-width:min(78%,460px);padding:10px 14px;width:fit-content;}
.bubble p{font-size:14.5px;line-height:1.5;margin:0;overflow-wrap:anywhere;white-space:pre-wrap;}
.bubble-time{display:block;font-size:11px;margin-top:6px;opacity:.65;}
.bubble-row.them .bubble{background:#f4f1ec;border:1px solid var(--line);color:var(--ink);}
.bubble-row.me .bubble{background:var(--coral);color:#fff;}
.chat-send{align-items:flex-end;border-top:1px solid var(--line);display:flex;gap:10px;padding:14px 20px;}
.chat-send textarea{margin:0;}
.chat-send .btn{flex:none;}

.chat-split{align-items:start;display:grid;gap:16px;grid-template-columns:300px 1fr;}
.thread-list{align-content:start;display:grid;gap:8px;max-height:calc(100vh - 400px);overflow-y:auto;}
.thread{background:#fff;border:1px solid var(--line);border-radius:12px;display:grid;gap:4px;padding:12px 14px;text-align:left;transition:border-color .18s var(--ease),box-shadow .18s var(--ease);}
.thread:hover{border-color:var(--coral);}
.thread.on{border-color:var(--coral);box-shadow:var(--shadow-soft);}
.thread-top{align-items:center;display:flex;gap:8px;justify-content:space-between;}
.thread-top strong{font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.unread{background:var(--coral);border-radius:99px;color:#fff;flex:none;font-size:11px;font-weight:800;min-width:19px;padding:2px 6px;text-align:center;}
.thread-preview{color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.thread-meta{color:#a8b0c0;font-size:11.5px;font-weight:600;}
@media(max-width:860px){.chat-split{grid-template-columns:1fr;}.thread-list{max-height:220px;}}

/* ---- posts we read ---- */
.read-list{display:grid;gap:12px;}
.read-row{background:#faf7f2;border:1px solid var(--line);border-left:3px solid var(--line);border-radius:12px;padding:14px 16px;transition:border-left-color .18s var(--ease),background .18s;}
.read-row:hover{background:#fff;border-left-color:var(--coral);}
.read-meta{align-items:center;display:flex;gap:10px;justify-content:space-between;margin-bottom:7px;}
.read-group{background:#fff;border:1px solid var(--line);border-radius:99px;color:#55607a;font-size:11.5px;font-weight:700;padding:3px 10px;}
.read-when{color:#98a0b3;flex:none;font-size:12px;font-weight:600;}
.read-text{color:#3c465e;font-size:14px;line-height:1.55;margin:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;}
.read-foot{align-items:center;display:flex;gap:12px;justify-content:space-between;margin-top:10px;}
.read-author{color:var(--muted);font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.read-link{border:1px solid var(--line);border-radius:99px;color:var(--ink);flex:none;font-size:12.5px;font-weight:700;padding:6px 13px;text-decoration:none;transition:background .18s,border-color .18s,color .18s;}
.read-link:hover{background:var(--ink);border-color:var(--ink);color:#fff;}

/* ---- one user, up close ---- */
.user-modal{display:flex;flex-direction:column;max-height:88vh;max-width:560px;overflow:hidden;padding:0;}
.um-head{align-items:center;background:#fff;border-bottom:1px solid var(--line);display:flex;gap:14px;justify-content:space-between;padding:20px 24px;position:sticky;top:0;z-index:2;}
.um-close{background:#f6f1e9;border:0;border-radius:99px;color:var(--muted);font-size:20px;height:32px;line-height:1;transition:background .18s,color .18s;width:32px;}
.um-close:hover{background:var(--coral);color:#fff;}
.um-body{overflow-y:auto;padding:0 24px 24px;}
.um-section{border-top:1px solid #f4efe7;padding:20px 0;}
.um-section:first-child{border-top:0;padding-top:18px;}
.um-label{color:#8b93a7;font-size:11px;font-weight:800;letter-spacing:.07em;margin:0 0 12px;text-transform:uppercase;}
.um-note{color:var(--muted);font-size:13px;line-height:1.5;margin:-6px 0 14px;}
.um-badges{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;}

.um-stats{display:grid;gap:10px;grid-template-columns:repeat(3,1fr);}
.um-stat{background:#faf7f2;border:1px solid var(--line);border-radius:12px;display:grid;gap:2px;padding:12px 14px;}
.um-stat strong{font-size:21px;letter-spacing:-.02em;}
.um-stat small{color:#98a0b3;font-size:12px;font-weight:600;}
.um-stat span{color:var(--muted);font-size:11.5px;font-weight:600;}
.um-bar{background:#ece5da;border-radius:99px;height:4px;margin-top:6px;overflow:hidden;}
.um-bar i{background:var(--mint);display:block;height:100%;}

.um-section .kv:first-of-type{border-top:0;}
.um-section .field{margin-bottom:14px;}
.um-actions{align-items:center;display:flex;flex-wrap:wrap;gap:12px;margin-top:4px;}
.um-danger{background:#fffaf9;border-radius:14px;margin-top:8px;padding:18px;}
.um-danger .um-label{color:var(--coral-deep);}
@media(max-width:560px){
  .um-stats{grid-template-columns:1fr;}
  .um-body{padding:0 18px 18px;}
  .um-head{padding:16px 18px;}
}

/* ---- setup wizard ---- */
.resume-setup{align-items:center;background:var(--navy);border:0;border-radius:14px;bottom:18px;box-shadow:var(--shadow);color:#fff;display:flex;gap:14px;justify-content:space-between;left:50%;max-width:520px;padding:14px 18px;position:fixed;transform:translateX(-50%);width:calc(100% - 32px);z-index:44;}
.resume-setup span{display:grid;gap:2px;text-align:left;}
.resume-setup strong{font-size:14.5px;}
.resume-setup em{color:#a9b8d4;font-size:12.5px;font-style:normal;}
.resume-setup i{color:var(--coral);font-size:20px;font-style:normal;}
.modal{position:relative;}
.modal-x{align-items:center;background:#f6f1e9;border:0;border-radius:99px;color:var(--muted);display:inline-flex;height:30px;justify-content:center;position:absolute;right:14px;top:14px;transition:background .2s,color .2s;width:30px;z-index:2;}
.modal-x:hover{background:var(--coral);color:#fff;}
.modal-x svg{height:13px;width:13px;}
.modal-wide{max-width:600px;position:relative;}

/* The overview: proof on the left, jobs on the right. */
.ov-split{align-items:start;display:grid;gap:16px;grid-template-columns:1fr 340px;}
.ov-side{display:grid;gap:16px;}

.feed{padding:0;}
.feed-head{align-items:flex-start;border-bottom:1px solid var(--line);display:flex;gap:12px;justify-content:space-between;padding:18px 20px 14px;}
.feed-head h3{margin:0 0 3px;}
.feed-head .tiny{margin:0;}
.feed-wait{align-items:center;color:var(--muted);display:flex;font-size:14px;gap:10px;justify-content:center;padding:44px 20px;}
.feed-rows{max-height:min(56vh,560px);overflow-y:auto;}
.feed-row{align-items:baseline;border-bottom:1px solid var(--line);color:inherit;display:flex;gap:14px;padding:12px 20px;text-decoration:none;transition:background .18s var(--ease);
  animation:feedIn .42s var(--ease) both;}
.feed-row:hover{background:#fffaf3;}
.feed-row:last-child{border-bottom:0;}
.feed-when{color:var(--muted);flex:none;font-size:11.5px;font-variant-numeric:tabular-nums;padding-top:2px;width:64px;}
.feed-body{display:grid;gap:2px;min-width:0;}
.feed-group{color:var(--coral-deep);font-size:11.5px;font-weight:800;letter-spacing:.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.feed-text{color:var(--ink);display:-webkit-box;font-size:13.5px;line-height:1.5;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;}
.feed-more{background:none;border:0;border-top:1px solid var(--line);color:var(--coral-deep);font-size:13px;font-weight:800;padding:13px;width:100%;}
.feed-more:hover{background:#fffaf3;}
@keyframes feedIn{from{opacity:0;transform:translateY(-9px);}to{opacity:1;transform:none;}}

.score-head{align-items:center;display:flex;justify-content:space-between;}
.score-head h3{margin:0;}
.score-count{color:var(--muted);font-size:12px;font-weight:800;}
.score.all-done .score-count{color:var(--mint);}
.score.all-done .score-head h3{color:var(--mint);}
.score-bar{background:var(--line);border-radius:99px;height:6px;margin:12px 0 14px;overflow:hidden;}
.score-bar i{background:var(--mint);border-radius:99px;display:block;height:100%;transition:width .5s var(--ease);}
.score-list{display:grid;gap:2px;}
.score-row{align-items:center;background:none;border:0;border-radius:9px;display:flex;gap:10px;padding:9px 8px;text-align:left;transition:background .18s var(--ease);width:100%;}
.score-row:hover{background:#fffaf3;}
.score-mark{align-items:center;background:var(--line);border-radius:99px;color:#fff;display:inline-flex;flex:none;height:18px;justify-content:center;width:18px;}
.score-row.done .score-mark{background:var(--mint);}
.score-row.done .score-label{color:var(--muted);}
.score-mark svg{height:11px;width:11px;}
.score-label{color:var(--ink);flex:1;font-size:13.5px;font-weight:600;}
.score-go{color:var(--coral-deep);flex:none;font-size:12px;font-weight:800;}

.usage-warn{align-items:center;background:#fff3d8;border:1px solid #f2ddaa;border-radius:14px;display:flex;gap:14px;justify-content:space-between;margin-bottom:16px;padding:14px 18px;text-align:left;width:100%;}
.usage-warn.stopped{background:#fdece8;border-color:#f6cfc4;}
.usage-warn span{display:grid;gap:2px;}
.usage-warn strong{color:#8a5a00;font-size:14.5px;}
.usage-warn.stopped strong{color:var(--coral-deep);}
.usage-warn em{color:#8a5a00;font-size:12.5px;font-style:normal;opacity:.85;}
.usage-warn.stopped em{color:var(--coral-deep);}
.usage-warn i{color:#8a5a00;flex:none;font-size:12.5px;font-style:normal;font-weight:800;white-space:nowrap;}
.usage-warn.stopped i{color:var(--coral-deep);}
.firstlead{background:linear-gradient(115deg,#111d36,#1b2c4f);border-radius:16px;box-shadow:var(--shadow-soft);color:#fff;margin-bottom:18px;overflow:hidden;padding:18px 20px 16px;position:relative;}
.firstlead:after{background:radial-gradient(circle,rgba(255,106,77,.35),transparent 70%);content:"";height:220px;position:absolute;right:-70px;top:-90px;width:220px;}
.fl-top{align-items:flex-start;display:flex;gap:14px;justify-content:space-between;position:relative;}
.fl-top strong{font-size:15.5px;letter-spacing:-.01em;}
.fl-top .tiny{color:#a9b8d4;margin:3px 0 0;}
.fl-count{background:rgba(255,255,255,.12);border-radius:99px;flex:none;font-size:11.5px;font-weight:800;padding:5px 11px;}
.fl-track{background:rgba(255,255,255,.14);border-radius:99px;height:7px;margin:16px 0 2px;overflow:hidden;position:relative;}
.fl-track i{background:linear-gradient(90deg,var(--coral),#ffa46d);border-radius:99px;display:block;height:100%;position:relative;transition:width .8s var(--ease);}
.fl-track i:after{animation:flPulse 2.2s var(--ease) infinite;background:rgba(255,255,255,.65);border-radius:99px;content:"";inset:0 0 0 auto;position:absolute;width:7px;}
@keyframes flPulse{0%,100%{opacity:.25;}50%{opacity:1;}}
@media(prefers-reduced-motion:reduce){.fl-track i:after{animation:none;}.feed-row{animation:none;}}

.empty.small{padding:18px 4px;}
@media(max-width:1100px){.ov-split{grid-template-columns:1fr;}}

.wiz-row{animation:wizIn .42s cubic-bezier(.22,1,.36,1) both;}
@keyframes wizIn{from{opacity:0;transform:translateY(-10px);}to{opacity:1;transform:none;}}
@media(prefers-reduced-motion:reduce){.wiz-row{animation:none;}}
.size-cell{text-align:right;white-space:nowrap;width:1%;}
.state-pill{animation:pillIn .3s var(--ease) both;background:#faf7f2;border:1px solid var(--line);border-radius:99px;color:var(--muted);display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:800;padding:4px 11px;}
.state-pill.done{background:var(--mint-soft);border-color:#a9e2c6;color:#1d8a63;}
.state-pill svg{height:11px;width:11px;}
@keyframes pillIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
.row-menu{position:relative;}
.dots{background:none;border:0;display:grid;gap:3px;padding:8px 6px;}
.dots i{background:#b9bfcb;border-radius:99px;display:block;height:3px;width:3px;}
.dots:hover i{background:var(--ink);}
.menu-veil{inset:0;position:fixed;z-index:3;}
.menu-pop{background:#fff;border:1px solid var(--line);border-radius:11px;box-shadow:var(--shadow);display:grid;overflow:hidden;position:absolute;right:0;top:100%;z-index:4;min-width:132px;}
.menu-pop button{background:none;border:0;font-size:13.5px;font-weight:600;padding:11px 14px;text-align:left;}
.menu-pop button:hover{background:#faf7f2;}
.menu-pop button.danger{color:var(--coral-deep);}
.act-cell{white-space:nowrap;}
.act-cell .mini + .mini{margin-left:8px;}
.size-pill{align-items:center;background:#faf7f2;border:1px solid var(--line);border-radius:99px;color:var(--muted);display:inline-flex;font-size:11.5px;font-weight:800;gap:6px;padding:3px 9px;}
.size-pill.quiet{opacity:.6;}
.spinner.tiny{border-width:2px;height:10px;width:10px;}
.row-edit{margin:0;padding:8px 10px;}
.empty.tight .spinner{margin:0 auto 10px;}
.sugg{margin-top:14px;}
.sugg-head{color:var(--muted);margin:0;}
.sugg-top{align-items:baseline;display:flex;gap:12px;justify-content:space-between;margin-bottom:9px;}
.sugg-all{background:var(--coral);border:0;border-radius:99px;color:#fff;flex:none;font-size:12px;font-weight:800;padding:6px 13px;}
.sugg-all:hover{background:var(--coral-deep);}
.sugg-chip.near{background:var(--mint-soft);border-color:#a9e2c6;}
.sugg-list{display:flex;flex-wrap:wrap;gap:7px;}
.sugg-chip{align-items:center;background:#faf7f2;border:1px solid var(--line);border-radius:99px;color:var(--ink);display:inline-flex;font-size:12.5px;font-weight:600;gap:7px;max-width:100%;padding:7px 12px;transition:border-color .18s var(--ease),background .18s var(--ease);}
.sugg-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.sugg-chip i{color:var(--coral-deep);font-size:14px;font-style:normal;font-weight:800;line-height:1;}
.sugg-chip:hover{background:#fff;border-color:var(--coral);}
.allset{max-width:430px;text-align:center;}
.needcard{max-width:430px;text-align:center;}
.needcard h2{margin-bottom:8px;}
.needcard .muted{margin:0 auto 18px;max-width:340px;}
.needcard-roo{display:block;height:96px;margin:0 auto 12px;object-fit:contain;width:96px;}
.needcard-plan{background:#faf7f2;border:1px solid var(--line);border-radius:14px;display:grid;gap:9px;margin-bottom:18px;padding:15px 16px;text-align:left;}
.needcard-row{align-items:baseline;display:flex;font-size:13.5px;gap:12px;justify-content:space-between;}
.needcard-row span{color:var(--muted);}
.needcard-row strong{font-size:14px;}
.needcard-row .free{color:var(--mint);font-size:16px;}
.needcard-row.muted-row span{font-size:12.5px;}
.needcard-out{background:none;border:0;color:var(--muted);font-size:12.5px;font-weight:600;margin-top:12px;text-decoration:underline;}
.needcard-out:hover{color:var(--ink);}
.allset h2{margin-bottom:10px;}
.allset .muted{margin:0 auto 22px;max-width:340px;}
.allset-roo{display:block;height:120px;margin:0 auto 14px;object-fit:contain;width:120px;animation:allsetWave 2.4s var(--ease) .25s infinite;transform-origin:60% 90%;}
@keyframes allsetWave{0%,60%,100%{transform:rotate(0deg);}70%{transform:rotate(-9deg);}80%{transform:rotate(7deg);}90%{transform:rotate(-4deg);}}
@media(prefers-reduced-motion:reduce){.allset-roo{animation:none;}}
.wiz-brand{align-items:center;animation:dPop .4s var(--ease) both;display:flex;gap:11px;margin-bottom:18px;}
.wiz-logo{background:#fff;border:1px solid var(--line);border-radius:10px;flex:none;height:38px;object-fit:contain;padding:3px;width:38px;}
.wiz-brand span{color:var(--muted);font-size:13.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wiz-top{align-items:center;display:flex;justify-content:space-between;margin-bottom:20px;}
.wiz-top .steps-dots{margin:0;}
.g-name{align-items:center;display:flex;gap:9px;}
.g-tick{align-items:center;background:var(--line);border-radius:99px;color:#fff;display:none;flex:none;height:19px;justify-content:center;transition:background .3s var(--ease),transform .3s var(--ease);width:19px;}
.g-tick.on{background:var(--mint);transform:scale(1);}
.g-tick svg{height:11px;width:11px;}
/* The Added pill lives in .size-cell, which is hidden below 860px. So the tick
   beside the name is the only thing saying a group is in on a phone, and above
   that width the pill says it and a second marker is just noise. Exactly one
   marker at every width. Declared after the base rule, or it would lose to it
   at equal specificity. */
@media(max-width:860px){.g-tick{display:inline-flex;}}
.manual-link{background:none;border:0;color:var(--muted);cursor:pointer;font-family:inherit;font-size:13px;font-weight:700;margin-top:14px;padding:6px 0;text-decoration:underline;text-underline-offset:3px;transition:color .2s;}
.manual-link:hover{color:var(--coral);}
.manual-open{animation:manualIn .34s cubic-bezier(.22,1,.36,1) both;margin-top:14px;overflow:hidden;}
@keyframes manualIn{from{max-height:0;opacity:0;transform:translateY(-6px);}to{max-height:260px;opacity:1;transform:none;}}
@media(prefers-reduced-motion:reduce){.manual-open{animation:none;}}
.help-dot{background:#f6f1e9;border:0;border-radius:99px;color:var(--muted);font-size:13px;font-weight:900;height:26px;transition:background .2s,color .2s;width:26px;}
.help-dot:hover{background:var(--coral);color:#fff;}
.req{color:var(--coral-deep);}
.warn-line{background:#fff3d8;border-radius:10px;color:#8a5a00;font-size:13px;font-weight:600;margin:0 0 14px;padding:10px 12px;}

.spinner{animation:spin .7s linear infinite;border:2.5px solid var(--line);border-radius:99px;border-top-color:var(--coral);display:inline-block;flex:none;height:18px;width:18px;}
.spinner.big{border-width:3px;height:34px;margin-bottom:16px;width:34px;}
@keyframes spin{to{transform:rotate(360deg)}}
.scan-veil{align-items:center;animation:dRise .3s var(--ease) both;background:rgba(255,255,255,.96);border-radius:20px;display:flex;flex-direction:column;inset:0;justify-content:center;padding:30px;position:absolute;text-align:center;z-index:5;}
.scan-veil strong{font-size:16px;}
.scan-veil .muted{margin:6px 0 0;max-width:34ch;}
.think{align-items:center;color:var(--muted);display:flex;font-size:14px;font-weight:600;gap:11px;padding:26px 0;}

.count-row{align-items:baseline;display:flex;gap:12px;justify-content:space-between;}
.counter{color:#98a0b3;flex:none;font-size:12px;font-weight:700;}
.counter.over{color:var(--coral-deep);}
.ai-btn.small{font-size:12px;margin-top:12px;min-width:0;padding:8px 14px;}

.picker{position:relative;}
.picker-list{animation:dRise .2s var(--ease) both;background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-soft);display:grid;margin-top:6px;overflow:hidden;}
.picker-opt{background:none;border:0;color:var(--ink);font-size:14px;padding:10px 14px;text-align:left;transition:background .15s;}
.picker-opt:hover{background:var(--mint-soft);}
.chip.pop{animation:dPop .3s var(--ease) both;}

.adder{margin-top:4px;}
.adder-row{align-items:center;display:flex;gap:9px;}
.adder-input{flex:1;min-width:0;position:relative;}
.adder-input input{padding-right:38px;}
.adder-input.good input{border-color:var(--mint);}
.adder-input.bad input{border-color:var(--coral-deep);}
.mark{position:absolute;right:13px;top:50%;transform:translateY(-50%);}
.mark.ok{color:var(--mint);display:flex;}
.mark.no{color:var(--coral-deep);font-size:19px;font-weight:800;line-height:1;}

.wiz-table{border-collapse:collapse;font-size:13.5px;margin-top:16px;width:100%;}
.wiz-table th{border-bottom:1px solid var(--line);color:#8b93a7;font-size:11px;letter-spacing:.05em;padding:8px 10px;text-align:left;text-transform:uppercase;}
.wiz-table td{border-bottom:1px solid #f6f1e9;padding:11px 10px;vertical-align:middle;}
.wiz-table .link-cell{color:var(--muted);max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wiz-table .act-cell{text-align:right;white-space:nowrap;}
.mini.danger:hover{color:var(--coral-deep);}
.empty.tight{padding:22px 0;text-align:center;}

.review{margin:4px 0 6px;}
.review-brief{background:#faf7f2;border:1px solid var(--line);border-radius:11px;color:#3c465e;font-size:14px;line-height:1.55;margin:0;padding:13px 15px;white-space:pre-wrap;}

.toast{align-items:center;animation:dPop .3s var(--ease) both;background:var(--navy);border-radius:99px;bottom:-56px;box-shadow:0 12px 26px rgba(17,29,54,.3);color:#fff;display:flex;font-size:13px;font-weight:700;gap:7px;left:50%;padding:11px 20px;position:absolute;transform:translateX(-50%);white-space:nowrap;}
.toast svg{color:var(--mint);}

.overlay.inner{z-index:60;}
.help-modal{max-height:88vh;max-width:520px;overflow-y:auto;}
.help-head{align-items:center;display:flex;gap:14px;justify-content:space-between;margin-bottom:6px;}
.help-head h2{margin:0;}
.help-steps{counter-reset:h;display:grid;gap:20px;list-style:none;margin:20px 0;padding:0;}
.help-steps li{padding-left:38px;position:relative;}
.help-steps li::before{align-items:center;background:var(--coral);border-radius:99px;color:#fff;content:counter(h);counter-increment:h;display:flex;font-size:12px;font-weight:900;height:24px;justify-content:center;left:0;position:absolute;top:-1px;width:24px;}
.help-steps strong{display:block;font-size:14.5px;}
.help-steps .muted{margin:4px 0 0;}
.mock{align-items:center;background:#faf7f2;border:1px solid var(--line);border-radius:9px;display:flex;font-size:12.5px;gap:9px;margin-top:10px;padding:9px 12px;}
.mock.search{border-radius:99px;color:var(--muted);}
.mock-ico,.mock-lock{color:#a8b0c0;display:flex;flex:none;}
.mock-ico svg,.mock-lock svg{height:14px;width:14px;}
.mock-url{color:var(--muted);font-family:var(--font-geist-mono),monospace;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mock-url b{color:var(--ink);}
.help-warn{background:#fdece8;border-radius:12px;display:grid;gap:8px;padding:14px 16px;}
.help-warn p{align-items:flex-start;display:flex;font-size:13px;font-weight:600;gap:8px;line-height:1.45;margin:0;}
.no-mark{color:var(--coral-deep);flex:none;font-size:16px;font-weight:900;line-height:1.1;}
.yes-mark{color:var(--mint);display:flex;flex:none;padding-top:2px;}

@media(max-width:640px){
  /* A phone keyboard does not shrink vh, so an 80vh modal kept its Continue
     button underneath the keyboard. dvh does shrink. The padding comes down
     too: 32px a side plus the overlay's 20px left 271px of usable width on a
     375px phone. */
  .overlay{padding:10px;}
  .modal{max-height:88vh;max-height:88dvh;padding:24px 18px 18px;}
  .modal .wiz-body{margin:0 -18px;padding:0 18px;}
  .modal h2{font-size:19px;}
  .modal-x{right:10px;top:10px;}
  .wiz-top{margin-bottom:14px;}
  .modal-wide{padding:24px 18px;}
  /* Under 16px, iOS zooms the whole page the moment a field is focused, and
     the Continue button lands off screen with no way back to it. */
  .dash input,.dash select,.dash textarea{font-size:16px;}
  .row.spread .btn{min-height:44px;}
  .adder-row{flex-wrap:wrap;}
  .adder-input{flex:1 1 100%;}
  .adder-row .btn{flex:1;}
  .toast{bottom:auto;top:-52px;}
}

.funnel-chart{display:grid;gap:14px;padding:4px 0;}
.fbar-row{align-items:center;display:grid;gap:12px;grid-template-columns:150px 1fr auto;}
.fbar-label{color:var(--ink);font-size:13.5px;font-weight:600;}
.fbar-track{align-items:center;display:flex;gap:10px;}
.fbar-fill{align-items:center;animation:fbarGrow .6s var(--ease) both;background:var(--coral);border-radius:6px;box-shadow:0 4px 12px rgba(240,79,49,.25);color:#fff;display:flex;height:34px;justify-content:flex-end;min-width:34px;padding:0 12px;}
.fbar-count{font-size:14px;font-weight:800;}
.fbar-rate{color:var(--muted);font-size:12.5px;font-weight:700;white-space:nowrap;}
.fbar-drop{background:#fdece8;border-radius:99px;color:var(--coral-deep);font-size:11.5px;font-weight:800;padding:4px 9px;white-space:nowrap;}
@keyframes fbarGrow{from{transform:scaleX(.4);opacity:0;transform-origin:left;}}
@media(max-width:640px){
  .fbar-row{grid-template-columns:1fr;gap:5px;}
  .fbar-label{font-size:13px;}
  .fbar-drop{justify-self:start;}
}
`;
