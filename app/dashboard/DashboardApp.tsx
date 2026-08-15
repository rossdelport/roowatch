"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type User = { id: string; email: string; name: string };
type Profile = {
  businessName: string;
  trade: string;
  state: string;
  website: string;
  services: string;
  location: string;
  brief: string;
  onboardedAt: string | null;
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
type Group = { id: number; name: string; status: string };
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
  hasPassword?: boolean;
};
type Member = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  onboarded: boolean;
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

const I = {
  grid: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="18" height="18"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>,
  eye: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  bell: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>,
  gear: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33 1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82 1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  card: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="18" height="18"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>,
  flow: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M4 4v6a2 2 0 0 0 2 2h12a2 2 0 0 1 2 2v6"/><circle cx="4" cy="3" r="1.6"/><circle cx="20" cy="21" r="1.6"/></svg>,
  out: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  tick: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" width="13" height="13"><polyline points="20 6 9 17 4 12"/></svg>,
  spark: <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2.5l1.9 5.3 5.3 1.9-5.3 1.9L12 16.9l-1.9-5.3L4.8 9.7l5.3-1.9z"/><path d="M18.5 15l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/></svg>,
};

export default function DashboardApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState("overview");
  const [adminTab, setAdminTab] = useState<null | "members" | "stripe" | "pipeline" | "funnel">(null);
  const [adminPass, setAdminPass] = useState("");
  const [adminPrompt, setAdminPrompt] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [stripeRows, setStripeRows] = useState<StripeRow[]>([]);
  const [stripeOn, setStripeOn] = useState(true);
  const [sources, setSources] = useState<Source[]>([]);
  const [uncovered, setUncovered] = useState<string[]>([]);
  const [keys, setKeys] = useState<{ apify: boolean; anthropic: boolean }>({ apify: false, anthropic: false });
  const [funnel, setFunnel] = useState<{ label: string; count: number; rate: number }[]>([]);
  const [signupFunnel, setSignupFunnel] = useState<{ label: string; count: number; rate: number }[]>([]);
  const [signups, setSignups] = useState<{ email: string; name: string; phone: string; trade: string; createdAt: string }[]>([]);
  const [tradeStats, setTradeStats] = useState<{ slug: string; views: number; signups: number; rate: number }[]>([]);

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

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAdminTab(null);
    setMembers([]);
    refresh();
  }

  async function unlockAdmin(target: "members" | "stripe" | "pipeline" | "funnel") {
    setAdminBusy(true);
    setAdminError("");
    try {
      const post = (path: string) =>
        fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: adminPass }),
        });
      const [mRes, sRes, pRes, fRes] = await Promise.all([
        post("/api/admin/members"),
        post("/api/admin/stripe"),
        post("/api/admin/sources"),
        post("/api/admin/funnel"),
      ]);
      if (mRes.status === 401) {
        setAdminError("Wrong password.");
        return;
      }
      if (!mRes.ok) {
        setAdminError("Server is not set up yet.");
        return;
      }
      const m = (await mRes.json()) as { members?: Member[] };
      setMembers(m.members ?? []);
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
          signups?: { email: string; name: string; phone: string; trade: string; createdAt: string }[];
          trades?: { slug: string; views: number; signups: number; rate: number }[];
        };
        setFunnel(f.funnel ?? []);
        setSignupFunnel(f.signupFunnel ?? []);
        setSignups(f.signups ?? []);
        setTradeStats(f.trades ?? []);
      }
      setAdminTab(target);
      setAdminPrompt(false);
    } catch {
      setAdminError("Could not reach the server.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function scanSource(sourceId: number) {
    const res = await fetch("/api/admin/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId, password: adminPass }),
    });
    const data = (await res.json().catch(() => ({}))) as { matches?: number; posts?: number; error?: string };
    await unlockAdmin("pipeline");
    return { ok: res.ok, ...data } as { ok: boolean; matches?: number; posts?: number; error?: string };
  }

  async function adminCall(path: string, payload: Record<string, unknown>) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, password: adminPass }),
    });
    await unlockAdmin(adminTab ?? "members");
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

  const needsOnboarding = !me.onboarded;

  return (
    <div className="dash">
      <style>{CSS}</style>
      <div className="shell">
        <aside className="side">
          <Link className="brand" href="/dashboard">
            <span className="brand-mark">R</span>
            <span>RooWatch</span>
          </Link>
          <nav className="nav">
            <button className={tab === "overview" && !adminTab ? "on" : ""} onClick={() => { setTab("overview"); setAdminTab(null); }}>{I.grid} Overview</button>
            <button className={tab === "groups" && !adminTab ? "on" : ""} onClick={() => { setTab("groups"); setAdminTab(null); }}>{I.eye} Groups watching</button>
            <button className={tab === "alerts" && !adminTab ? "on" : ""} onClick={() => { setTab("alerts"); setAdminTab(null); }}>{I.bell} Leads</button>
          </nav>
          <div className="side-bottom">
            {me.isAdmin && (
              <button className={adminTab ? "on" : "admin-link"} onClick={() => (members.length || adminTab ? setAdminTab("funnel") : setAdminPrompt(true))}>{I.flow} Marketing</button>
            )}
            <button className={tab === "settings" && !adminTab ? "on" : ""} onClick={() => { setTab("settings"); setAdminTab(null); }}>{I.gear} Settings</button>
            <div className="side-user">
              <Avatar avatar={me.avatar} name={me.user.name || me.user.email} />
              <div className="side-user-meta">
                <strong>{me.user.name || "Member"}</strong>
                <span>{me.user.email}</span>
              </div>
              <button className="logout" title="Log out" onClick={logout}>{I.out}</button>
            </div>
          </div>
        </aside>

        <main className="main">
          {adminTab ? (
            <MarketingView
              active={adminTab} setActive={setAdminTab}
              funnel={funnel} signupFunnel={signupFunnel} signups={signups} tradeStats={tradeStats}
              members={members} adminCall={adminCall}
              sources={sources} uncovered={uncovered} keys={keys} onScan={scanSource}
              stripeRows={stripeRows} stripeOn={stripeOn} onRefreshStripe={() => unlockAdmin("stripe")} adminBusy={adminBusy}
            />
          ) : (
            <MemberView me={me} tab={tab} onLogout={logout} onRefresh={refresh} />
          )}
        </main>

        {needsOnboarding && <Onboarding me={me} onDone={refresh} />}

        {adminPrompt && (
          <div className="overlay">
            <div className="modal modal-small">
              <h2>Master access</h2>
              <p className="muted">Enter the master password.</p>
              <input type="password" placeholder="Master password" value={adminPass} onChange={(e) => setAdminPass(e.target.value)} onKeyDown={(e) => e.key === "Enter" && unlockAdmin("members")} autoFocus />
              {adminError && <p className="error">{adminError}</p>}
              <div className="row gap">
                <button className="btn ghost" onClick={() => { setAdminPrompt(false); setAdminError(""); }}>Cancel</button>
                <button className="btn primary" onClick={() => unlockAdmin("members")} disabled={adminBusy}>{adminBusy ? "Checking" : "Unlock"}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
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

function Onboarding({ me, onDone }: { me: Me; onDone: () => void }) {
  const email = me.user!.email;
  // Signup already asked for the business name, the trade and the state. Never
  // ask the same question twice: reuse those answers as the starting point.
  const known = me.profile;
  const [step, setStep] = useState(0);
  const [name, setName] = useState(known?.businessName ?? "");
  const [website, setWebsite] = useState(known?.website ?? "");
  const [services, setServices] = useState(known?.services ?? "");
  const [location, setLocation] = useState(known?.location ?? "");
  const [brief, setBrief] = useState(known?.brief ?? "");
  const [groupInput, setGroupInput] = useState("");
  const [groupList, setGroupList] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const trade = (known?.trade ?? "").trim();
  const steps = [
    ...((known?.businessName ?? "").trim()
      ? []
      : [{ key: "name", title: "What is your business called?", sub: "So we know who we are talking to.", valid: name.trim().length > 1 }]),
    { key: "website", title: "Your website", sub: "Where can we see your business?", valid: website.trim().length > 3 },
    { key: "services", title: "What do you do?", sub: trade ? `You told us you are ${aOrAn(trade)}. Now tell us your jobs in plain English.` : "Tell us your services in plain English.", valid: services.trim().length > 5 },
    { key: "location", title: "Where do you work?", sub: "Your city and the suburbs you serve.", valid: location.trim().length > 2 },
    { key: "brief", title: "What a good lead sounds like", sub: "Describe the posts you want, in your own words. This is what we look for.", valid: brief.trim().length > 10 },
    { key: "groups", title: "Groups to watch", sub: "Paste the Facebook link for each group. We start watching the moment you finish.", valid: true },
  ];
  const current = steps[step];

  function addGroup() {
    const g = groupInput.trim();
    if (g && !groupList.includes(g)) setGroupList([...groupList, g]);
    setGroupInput("");
  }

  async function finish() {
    setBusy(true);
    try {
      await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessName: name, website, services, location, brief, groups: groupList }),
      });
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay">
      <div className="modal">
        <div className="steps-dots">
          {steps.map((s, i) => (
            <span key={s.key} className={i === step ? "dot on" : i < step ? "dot done" : "dot"} />
          ))}
        </div>
        <h2>{current.title}</h2>
        <p className="muted">{current.sub}</p>

        {current.key === "name" && <input placeholder="Brightside Solar" value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        {current.key === "website" && <input placeholder="www.yourbusiness.com.au" value={website} onChange={(e) => setWebsite(e.target.value)} autoFocus />}
        {current.key === "services" && <textarea rows={4} placeholder="We install solar panels for homes. We also do battery upgrades and repairs." value={services} onChange={(e) => setServices(e.target.value)} autoFocus />}
        {current.key === "location" && (
          <div>
            <input placeholder="Sydney. Northern Beaches, Manly, Dee Why." value={location} onChange={(e) => setLocation(e.target.value)} autoFocus />
            <p className="tiny">Add your city and suburbs, not just the state.</p>
          </div>
        )}
        {current.key === "brief" && (
          <div>
            <textarea rows={4} placeholder="Someone in Perth asking who cleans solar panels, or saying their panels are dirty or their solar output has dropped." value={brief} onChange={(e) => setBrief(e.target.value)} autoFocus />
            <p className="tiny">Tell us what to skip too. For example: people selling panels, or businesses advertising their own service.</p>
          </div>
        )}
        {current.key === "groups" && (
          <div>
            <div className="row gap">
              <input placeholder="facebook.com/groups/... or the group name" value={groupInput} onChange={(e) => setGroupInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addGroup()} autoFocus />
              <button className="btn ghost" onClick={addGroup}>Add</button>
            </div>
            {groupList.length > 0 && (
              <div className="chips">
                {groupList.map((g) => (
                  <span key={g} className="chip">{g}<button onClick={() => setGroupList(groupList.filter((x) => x !== g))}>&times;</button></span>
                ))}
              </div>
            )}
            <p className="tiny">Open the group on Facebook and copy the address. Links start watching straight away. A name alone means we set it up for you on your welcome call.</p>
          </div>
        )}

        <div className="row spread">
          {step > 0 ? <button className="btn ghost" onClick={() => setStep(step - 1)}>Back</button> : <span className="tiny">{email}</span>}
          {step < steps.length - 1 ? (
            <button className="btn primary" disabled={!current.valid} onClick={() => setStep(step + 1)}>Next</button>
          ) : (
            <button className="btn primary" disabled={busy} onClick={finish}>{busy ? "Saving" : "Finish setup"}</button>
          )}
        </div>
      </div>
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

function MemberView({ me, tab, onLogout, onRefresh }: { me: Me; tab: string; onLogout: () => void; onRefresh: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [now] = useState(() => Date.now());
  const groups = me.groups ?? [];
  const alerts = me.alerts ?? [];
  const user = me.user!;

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
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>G&apos;day{firstName ? `, ${firstName}` : ""}</h1>
            <p className="muted">Your leads land here and on your phone.</p>
          </div>
          <span className="live"><i /> Watching live</span>
        </header>
        <div className="tiles">
          <div className="tile"><span className="tile-num">{groups.filter((g) => g.status === "watching").length}</span><span className="tile-label">Groups watching</span></div>
          <div className="tile"><span className="tile-num">{alerts.length}</span><span className="tile-label">Leads sent to you</span></div>
          <div className="tile"><span className="tile-num">{alerts.filter((a) => now - new Date(a.sentAt + "Z").getTime() < 7 * 864e5).length}</span><span className="tile-label">Leads this week</span></div>
          <div className="tile tile-accent"><span className="tile-num">&lt;5 min</span><span className="tile-label">Alert speed</span></div>
        </div>
        <div className="card">
          <h3>Latest leads</h3>
          {alerts.length === 0 ? (
            <div className="empty">
              <p><strong>No leads yet.</strong> That is normal on day one.</p>
              <p className="muted">We are setting up your watchlist. Your first lead usually lands within 48 hours.</p>
            </div>
          ) : (
            alerts.slice(0, 5).map((a) => <AlertRow key={a.id} alert={a} />)
          )}
        </div>
      </div>
    );
  }

  if (tab === "groups") {
    return <GroupsTab groups={groups} onRefresh={onRefresh} />;
  }

  if (tab === "alerts") {
    return (
      <div className="page">
        <header className="page-head">
          <div><h1>Leads</h1><p className="muted">Every lead we have sent you, newest first.</p></div>
          {alerts.length > 0 && <span className="live"><i /> {alerts.length} so far</span>}
        </header>
        <div className="card">
          {alerts.length === 0 ? (
            <div className="empty"><p><strong>No leads yet.</strong></p><p className="muted">When someone posts a job that matches your brief, it lands here and in your inbox.</p></div>
          ) : (
            alerts.map((a) => <AlertRow key={a.id} alert={a} />)
          )}
        </div>
      </div>
    );
  }

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
      <div className="card">
        <h3>Where your leads go</h3>
        <div className="group-row"><span className="group-name">Email ({user.email})</span><span className="chip-status ok">On</span></div>
        <div className="group-row"><span className="group-name">Text message</span><span className="chip-status pending">Coming soon</span></div>
        <p className="tiny">Want leads sent somewhere else? Email ross@roowatch.com.au and we will set it up.</p>
      </div>
      <div className="card">
        <h3>Your plan</h3>
        <div className="kv"><span>Plan</span><strong>Monthly. 10 groups watched.</strong></div>
        <div className="kv"><span>Posts checked this month</span><strong>{(me.postsUsed ?? 0).toLocaleString()} of 10,000</strong></div>
        <div className="kv"><span>Guarantee</span><strong>1 job in 30 days or we refund you</strong></div>
        <p className="tiny">Need to change anything? Email ross@roowatch.com.au and we sort it same day.</p>
      </div>
      <div className="card">
        <h3>Session</h3>
        <button className="btn ghost" onClick={onLogout}>Log out</button>
      </div>
      <DangerZone />
    </div>
  );
}

function GroupsTab({ groups, onRefresh }: { groups: Group[]; onRefresh: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const LIMIT = 10;

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
          d.error === "plan_limit"
            ? `Your plan covers ${LIMIT} groups. Remove one first.`
            : d.error === "duplicate"
            ? "That group is already on your list."
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

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Groups watching</h1><p className="muted">The groups we read for you, day and night.</p></div>
        <span className="tiny">{groups.length} of {LIMIT}</span>
      </header>
      <div className="card">
        {groups.length === 0 ? (
          <div className="empty"><p><strong>No groups yet.</strong></p><p className="muted">Add the local groups your customers use. We take it from there.</p></div>
        ) : (
          groups.map((g) => (
            <div className="group-row" key={g.id}>
              <span className="group-name">{g.name}</span>
              <span className="row gap">
                    <span className={g.status === "watching" ? "chip-status ok" : "chip-status pending"}>{g.status === "watching" ? "Watching" : g.status === "paused" ? "Paused" : "Setting up"}</span>
                <button className="mini" disabled={busy} onClick={() => call({ action: "remove", groupId: g.id })}>Remove</button>
              </span>
            </div>
          ))
        )}
        <div className="row gap mt">
          <input placeholder="Add a group name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && call({ action: "add", name })} />
          <button className="btn ghost" disabled={busy || !name.trim()} onClick={() => call({ action: "add", name })}>Add</button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
      <p className="tiny">New groups show as Setting up while we connect them. That usually takes a few hours.</p>
    </div>
  );
}

function ProfileForm({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  const [name, setName] = useState(me.user?.name ?? "");
  const [businessName, setBusinessName] = useState(me.profile?.businessName ?? "");
  const [website, setWebsite] = useState(me.profile?.website ?? "");
  const [services, setServices] = useState(me.profile?.services ?? "");
  const [location, setLocation] = useState(me.profile?.location ?? "");
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
          body: JSON.stringify({ name, businessName, website, services, location, brief }),
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
  }, [name, businessName, website, services, location, brief]);

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

function DangerZone() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    await fetch("/api/member/account", { method: "DELETE" });
    window.location.href = "/";
  }

  return (
    <div className="card danger">
      <h3>Delete account</h3>
      <p className="muted">This removes your account, your groups, and your leads. It cannot be undone.</p>
      {confirming ? (
        <div className="row gap mt">
          <button className="btn ghost" onClick={() => setConfirming(false)}>Keep my account</button>
          <button className="btn danger-btn" disabled={busy} onClick={remove}>{busy ? "Deleting" : "Yes, delete everything"}</button>
        </div>
      ) : (
        <button className="btn ghost mt" onClick={() => setConfirming(true)}>Delete my account</button>
      )}
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
              <span className="tiny block">{m.email} · {m.groups.length} groups · {m.alertCount} leads sent</span>
            </div>
            <span className={m.onboarded ? "chip-status ok" : "chip-status pending"}>{m.onboarded ? "Onboarded" : "Not finished"}</span>
          </div>

          {open === m.id && (
            <div className="member-body">
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

function MarketingView(props: {
  active: "members" | "stripe" | "pipeline" | "funnel";
  setActive: (t: "members" | "stripe" | "pipeline" | "funnel") => void;
  funnel: { label: string; count: number; rate: number }[];
  signupFunnel: { label: string; count: number; rate: number }[];
  signups: { email: string; name: string; phone: string; trade: string; createdAt: string }[];
  tradeStats: { slug: string; views: number; signups: number; rate: number }[];
  members: Member[];
  adminCall: (path: string, payload: Record<string, unknown>) => Promise<boolean>;
  sources: Source[]; uncovered: string[]; keys: { apify: boolean; anthropic: boolean };
  onScan: (id: number) => Promise<{ ok: boolean; matches?: number; posts?: number; error?: string }>;
  stripeRows: StripeRow[]; stripeOn: boolean; onRefreshStripe: () => void; adminBusy: boolean;
}) {
  const tabs: { key: "funnel" | "members" | "pipeline" | "stripe"; label: string }[] = [
    { key: "funnel", label: "Ad funnel" },
    { key: "members", label: "Members" },
    { key: "pipeline", label: "Pipeline" },
    { key: "stripe", label: "Payments" },
  ];
  return (
    <div className="page admin">
      <header className="page-head">
        <div>
          <h1>Marketing</h1>
          <p className="muted">Your funnel, members, pipeline and payments in one place.</p>
        </div>
      </header>
      <div className="subtabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={props.active === t.key} className={props.active === t.key ? "subtab on" : "subtab"} onClick={() => props.setActive(t.key)}>{t.label}</button>
        ))}
      </div>
      <div className="subpanel">
        {props.active === "funnel" && <FunnelView rows={props.funnel} signupRows={props.signupFunnel} signups={props.signups} trades={props.tradeStats} />}
        {props.active === "members" && <MembersView members={props.members} onAction={props.adminCall} />}
        {props.active === "pipeline" && <PipelineView sources={props.sources} uncovered={props.uncovered} keys={props.keys} onAction={props.adminCall} onScan={props.onScan} />}
        {props.active === "stripe" && <PaymentsView rows={props.stripeRows} stripe={props.stripeOn} onRefresh={props.onRefreshStripe} busy={props.adminBusy} />}
      </div>
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

function FunnelView({ rows, signupRows, signups, trades }: {
  rows: { label: string; count: number; rate: number }[];
  signupRows: { label: string; count: number; rate: number }[];
  signups: { email: string; name: string; phone: string; trade: string; createdAt: string }[];
  trades: { slug: string; views: number; signups: number; rate: number }[];
}) {
  const activeTrades = trades.filter((t) => t.views > 0 || t.signups > 0);
  const when = (t: string) =>
    new Date(t.replace(" ", "T") + "Z").toLocaleString("en-AU", {
      timeZone: "Australia/Perth", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  return (
    <div className="subview">
      <header className="subhead">
        <div><p className="muted">Last 7 days. Where visitors drop out.</p></div>
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
                    <td><span className={w.phone ? "chip-status ok" : "chip-status pending"}>{w.phone ? "Ready to call" : "Email only"}</span></td>
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
  background:var(--cream); color:var(--ink); font-family:var(--font-inter-tight),"Inter Tight",Arial,sans-serif; min-height:100vh; }
.dash *{box-sizing:border-box;font-family:inherit;}
.dash button{cursor:pointer;}
.boot{align-items:center;color:var(--muted);display:flex;justify-content:center;min-height:100vh;}
@keyframes dRise{from{opacity:0;transform:translateY(20px)}}
@keyframes dPop{from{opacity:0;transform:scale(.94) translateY(14px)}}
@keyframes dPulse{0%,100%{opacity:1}50%{opacity:.35}}

.brand{align-items:center;color:#fff;display:inline-flex;font-size:19px;font-weight:800;gap:9px;letter-spacing:-.04em;text-decoration:none;}
.brand-dark{color:var(--ink);}
.brand-mark{align-items:center;background:var(--coral);border-radius:8px 8px 8px 3px;color:#fff;display:inline-flex;font-size:15px;font-weight:900;height:28px;justify-content:center;transform:rotate(-6deg);width:28px;}

.shell{display:grid;grid-template-columns:250px 1fr;min-height:100vh;}
.side{background:var(--navy);color:#fff;display:flex;flex-direction:column;height:100vh;padding:24px 16px;position:sticky;top:0;}
.side .brand{padding:4px 10px 22px;}
.nav{display:grid;gap:4px;margin-top:8px;}
.nav button,.side-bottom>button{align-items:center;background:none;border:0;border-radius:10px;color:#b8c3d8;display:flex;font-size:14px;font-weight:600;gap:11px;padding:11px 12px;text-align:left;transition:background .2s var(--ease),color .2s var(--ease);width:100%;}
.nav button:hover,.side-bottom>button:hover{background:rgba(255,255,255,.07);color:#fff;}
.nav button.on,.side-bottom>button.on{background:var(--coral);color:#fff;}
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

.main{min-width:0;padding:36px 40px 60px;}
.page{animation:dRise .45s var(--ease) both;margin:0 auto;max-width:920px;}
.page-head{align-items:center;display:flex;gap:16px;justify-content:space-between;margin-bottom:24px;}
.page-head h1{font-size:26px;letter-spacing:-.02em;margin:0 0 4px;}
.muted{color:var(--muted);font-size:14px;line-height:1.55;margin:0;}
.live{align-items:center;color:var(--mint);display:inline-flex;font-size:13px;font-weight:700;gap:7px;white-space:nowrap;}
.live i{animation:dPulse 1.6s ease-in-out infinite;background:var(--mint);border-radius:99px;display:inline-block;height:8px;width:8px;}

.tiles{display:grid;gap:14px;grid-template-columns:repeat(4,1fr);margin-bottom:18px;}
.tile{animation:dRise .5s var(--ease) both;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-soft);display:grid;gap:4px;padding:18px 20px;transition:transform .25s var(--ease),box-shadow .25s var(--ease);}
.tile:hover{box-shadow:var(--shadow);transform:translateY(-3px);}
.tile:nth-child(2){animation-delay:.05s}.tile:nth-child(3){animation-delay:.1s}.tile:nth-child(4){animation-delay:.15s}
.tile-num{font-size:24px;font-weight:800;letter-spacing:-.02em;}
.tile-label{color:var(--muted);font-size:12.5px;font-weight:600;}
.tile-accent{background:var(--navy);border-color:var(--navy);color:#fff;}
.tile-accent .tile-label{color:#8fa1c0;}

.card{animation:dRise .5s .1s var(--ease) both;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow-soft);margin-bottom:18px;padding:22px 24px;}
.card h3{font-size:15px;letter-spacing:.02em;margin:0 0 14px;}
.card h3.mt{margin-top:20px;}
.empty{padding:18px 0 10px;text-align:center;}
.empty p{margin:0 0 6px;}
.group-row{align-items:center;border-top:1px solid #f4efe7;display:flex;font-size:14.5px;justify-content:space-between;padding:12px 2px;}
.group-row:first-of-type{border-top:0;}
.group-name{font-weight:600;}
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
.dash textarea{margin-top:10px;}

.overlay{align-items:center;animation:dRise .3s var(--ease) both;backdrop-filter:blur(4px);background:rgba(17,29,54,.55);display:flex;inset:0;justify-content:center;padding:20px;position:fixed;z-index:50;}
.modal{animation:dPop .45s var(--ease) both;background:#fff;border-radius:20px;box-shadow:var(--shadow);max-width:460px;padding:32px;width:100%;}
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
.lbl-row{align-items:flex-end;display:flex;gap:12px;justify-content:space-between;}
.lbl-row .lbl{margin-bottom:6px;}

.save-state{align-items:center;animation:dRise .25s var(--ease) both;color:var(--muted);display:inline-flex;font-size:12.5px;font-weight:700;gap:5px;}
.save-state.ok{color:var(--mint);}

.ai-btn{align-items:center;background:linear-gradient(103deg,#6d5bf6 0%,#a24cf0 45%,#f0518f 100%);border:0;border-radius:99px;box-shadow:0 4px 14px rgba(122,79,240,.34);color:#fff;display:inline-flex;flex:none;font-size:12.5px;font-weight:800;justify-content:center;margin-bottom:6px;overflow:hidden;padding:8px 15px;position:relative;transition:transform .18s var(--ease),box-shadow .18s var(--ease),filter .18s;}
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
.member-body{animation:dRise .35s var(--ease) both;border-top:1px solid #f4efe7;margin-top:16px;padding-top:6px;}
.table-wrap{overflow-x:auto;}
.admin table{border-collapse:collapse;font-size:13.5px;width:100%;}
.admin th{border-bottom:1px solid var(--line);color:#8b93a7;font-size:11.5px;letter-spacing:.05em;padding:9px 10px;text-align:left;text-transform:uppercase;}
.admin td{border-bottom:1px solid #f6f1e9;padding:11px 10px;white-space:nowrap;}
.admin td a{color:var(--coral-deep);text-decoration:none;}

@media(max-width:860px){
  .shell{grid-template-columns:1fr;}
  .side{align-items:center;flex-direction:row;flex-wrap:wrap;gap:6px;height:auto;position:static;}
  .side .brand{padding:4px 8px;}
  .nav{display:flex;gap:4px;margin:0 auto;}
  .nav button{padding:9px 10px;}
  .side-bottom{display:flex;margin:0;}
  .side-user{border:0;margin:0;padding:0 4px;}
  .side-user-meta{display:none;}
  .main{padding:22px 16px 50px;}
  .tiles{grid-template-columns:repeat(2,1fr);}
  .form-grid{grid-template-columns:1fr;}
}

.subtabs{border-bottom:1px solid var(--line);display:flex;gap:4px;margin-bottom:22px;overflow-x:auto;}
.subtab{background:none;border:0;border-bottom:2px solid transparent;color:var(--muted);font-size:14px;font-weight:700;margin-bottom:-1px;padding:10px 14px;transition:color .2s var(--ease),border-color .2s var(--ease);white-space:nowrap;}
.subtab:hover{color:var(--ink);}
.subtab.on{border-bottom-color:var(--coral);color:var(--ink);}
.subpanel{animation:dRise .35s var(--ease) both;}
.subview{margin:0;}
.subhead{margin-bottom:16px;}
.subhead .muted{font-size:13.5px;}

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
