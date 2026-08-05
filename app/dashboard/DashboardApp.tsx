"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type User = { id: string; email: string; name: string };
type Profile = {
  website: string;
  services: string;
  location: string;
  onboardedAt: string | null;
} | null;
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
  out: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
};

export default function DashboardApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState("overview");
  const [adminTab, setAdminTab] = useState<null | "members" | "stripe">(null);
  const [adminPass, setAdminPass] = useState("");
  const [adminPrompt, setAdminPrompt] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [stripeRows, setStripeRows] = useState<StripeRow[]>([]);
  const [stripeOn, setStripeOn] = useState(true);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/me");
    setMe(await res.json());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setAdminTab(null);
    setMembers([]);
    refresh();
  }

  async function unlockAdmin(target: "members" | "stripe") {
    setAdminBusy(true);
    setAdminError("");
    try {
      const [mRes, sRes] = await Promise.all([
        fetch("/api/admin/members", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: adminPass }),
        }),
        fetch("/api/admin/stripe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: adminPass }),
        }),
      ]);
      if (mRes.status === 401) {
        setAdminError("Wrong password.");
        return;
      }
      if (!mRes.ok) {
        setAdminError("Server is not set up yet.");
        return;
      }
      const m = await mRes.json();
      setMembers(m.members ?? []);
      if (sRes.ok) {
        const s = await sRes.json();
        setStripeRows(s.rows ?? []);
        setStripeOn(Boolean(s.stripe));
      }
      setAdminTab(target);
      setAdminPrompt(false);
    } catch {
      setAdminError("Could not reach the server.");
    } finally {
      setAdminBusy(false);
    }
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
        <Login onDone={refresh} />
      </div>
    );
  }

  const needsOnboarding = !me.onboarded;

  return (
    <div className="dash">
      <style>{CSS}</style>
      <div className="shell">
        <aside className="side">
          <a className="brand" href="/dashboard">
            <span className="brand-mark">R</span>
            <span>RooWatch</span>
          </a>
          <nav className="nav">
            <button className={tab === "overview" && !adminTab ? "on" : ""} onClick={() => { setTab("overview"); setAdminTab(null); }}>{I.grid} Overview</button>
            <button className={tab === "groups" && !adminTab ? "on" : ""} onClick={() => { setTab("groups"); setAdminTab(null); }}>{I.eye} Groups watching</button>
            <button className={tab === "alerts" && !adminTab ? "on" : ""} onClick={() => { setTab("alerts"); setAdminTab(null); }}>{I.bell} Notifications sent</button>
          </nav>
          <div className="side-bottom">
            {me.isAdmin && (
              <>
                <button className={adminTab === "members" ? "on" : "admin-link"} onClick={() => (members.length || adminTab ? setAdminTab("members") : setAdminPrompt(true))}>{I.shield} Members</button>
                <button className={adminTab === "stripe" ? "on" : "admin-link"} onClick={() => (members.length || adminTab ? setAdminTab("stripe") : setAdminPrompt(true))}>{I.card} Payments</button>
              </>
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
          {adminTab === "members" && <MembersView members={members} onAction={adminCall} />}
          {adminTab === "stripe" && <PaymentsView rows={stripeRows} stripe={stripeOn} onRefresh={() => unlockAdmin("stripe")} busy={adminBusy} />}
          {!adminTab && <MemberView me={me} tab={tab} onLogout={logout} onRefresh={refresh} />}
        </main>

        {needsOnboarding && <Onboarding email={me.user.email} onDone={refresh} />}

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
  if (avatar) return <img className="avatar-img" src={avatar} alt="" />;
  const initials = name.replace(/@.*/, "").split(/[ .]/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return <span className="avatar-fallback">{initials || "R"}</span>;
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = /.+@.+\..+/.test(email);

  async function submit() {
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch("/api/auth/request-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      setSent(true);
      if (data.link) setDevLink(data.link);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <a className="brand brand-dark" href="/">
          <span className="brand-mark">R</span>
          <span>RooWatch</span>
        </a>
        {sent ? (
          <>
            <h1>Check your email</h1>
            <p className="muted">We sent a login link to {email}. It lasts 30 minutes.</p>
            {devLink && (
              <p className="tiny">Email is not set up here. <a href={devLink}>Use this link</a>.</p>
            )}
            <button className="btn ghost wide" onClick={() => { setSent(false); setDevLink(null); }}>Use a different email</button>
            <p className="tiny">Already clicked it? <button className="linkish" onClick={onDone}>Refresh</button></p>
          </>
        ) : (
          <>
            <h1>Log in</h1>
            <p className="muted">We send you a link. No password to remember.</p>
            <label>Your email</label>
            <input type="email" placeholder="you@business.com.au" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} autoFocus />
            <button className="btn primary wide" disabled={!ok || busy} onClick={submit}>{busy ? "Sending" : "Send my login link"}</button>
            <p className="tiny">Trouble logging in? Email ross@roowatch.com.au</p>
          </>
        )}
      </div>
    </div>
  );
}

function Onboarding({ email, onDone }: { email: string; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [services, setServices] = useState("");
  const [location, setLocation] = useState("");
  const [groupInput, setGroupInput] = useState("");
  const [groupList, setGroupList] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const steps = [
    { title: "What is your business called?", sub: "So we know who we are talking to.", valid: name.trim().length > 1 },
    { title: "Your website", sub: "Where can we see your business?", valid: website.trim().length > 3 },
    { title: "What do you do?", sub: "Tell us your services in plain English.", valid: services.trim().length > 5 },
    { title: "Where do you work?", sub: "Your city and the suburbs you serve.", valid: location.trim().length > 2 },
    { title: "Groups to watch", sub: "Know any good local groups? Add them. We find the rest.", valid: true },
  ];

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
        body: JSON.stringify({ name, website, services, location, groups: groupList }),
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
          {steps.map((_, i) => (
            <span key={i} className={i === step ? "dot on" : i < step ? "dot done" : "dot"} />
          ))}
        </div>
        <h2>{steps[step].title}</h2>
        <p className="muted">{steps[step].sub}</p>

        {step === 0 && <input placeholder="Brightside Solar" value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        {step === 1 && <input placeholder="www.yourbusiness.com.au" value={website} onChange={(e) => setWebsite(e.target.value)} autoFocus />}
        {step === 2 && <textarea rows={4} placeholder="We install solar panels for homes. We also do battery upgrades and repairs." value={services} onChange={(e) => setServices(e.target.value)} autoFocus />}
        {step === 3 && <input placeholder="Sydney. Northern Beaches, Manly, Dee Why." value={location} onChange={(e) => setLocation(e.target.value)} autoFocus />}
        {step === 4 && (
          <div>
            <div className="row gap">
              <input placeholder="Home Advice Sydney" value={groupInput} onChange={(e) => setGroupInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addGroup()} autoFocus />
              <button className="btn ghost" onClick={addGroup}>Add</button>
            </div>
            {groupList.length > 0 && (
              <div className="chips">
                {groupList.map((g) => (
                  <span key={g} className="chip">{g}<button onClick={() => setGroupList(groupList.filter((x) => x !== g))}>&times;</button></span>
                ))}
              </div>
            )}
            <p className="tiny">This step is optional. Skip it if you are not sure.</p>
          </div>
        )}

        <div className="row spread">
          {step > 0 ? <button className="btn ghost" onClick={() => setStep(step - 1)}>Back</button> : <span className="tiny">{email}</span>}
          {step < steps.length - 1 ? (
            <button className="btn primary" disabled={!steps[step].valid} onClick={() => setStep(step + 1)}>Next</button>
          ) : (
            <button className="btn primary" disabled={busy} onClick={finish}>{busy ? "Saving" : "Finish setup"}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function MemberView({ me, tab, onLogout, onRefresh }: { me: Me; tab: string; onLogout: () => void; onRefresh: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
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
            <h1>G'day{firstName ? `, ${firstName}` : ""}</h1>
            <p className="muted">Your leads land here and on your phone.</p>
          </div>
          <span className="live"><i /> Watching live</span>
        </header>
        <div className="tiles">
          <div className="tile"><span className="tile-num">{groups.filter((g) => g.status === "watching").length}</span><span className="tile-label">Groups watching</span></div>
          <div className="tile"><span className="tile-num">{alerts.length}</span><span className="tile-label">Leads sent to you</span></div>
          <div className="tile"><span className="tile-num">{alerts.filter((a) => Date.now() - new Date(a.sentAt + "Z").getTime() < 7 * 864e5).length}</span><span className="tile-label">Leads this week</span></div>
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
    return (
      <div className="page">
        <header className="page-head"><div><h1>Groups watching</h1><p className="muted">The groups we read for you, day and night.</p></div></header>
        <div className="card">
          {groups.length === 0 ? (
            <div className="empty"><p><strong>We are picking your groups now.</strong></p><p className="muted">We find the best local groups for your services and add them here.</p></div>
          ) : (
            groups.map((g) => (
              <div className="group-row" key={g.id}>
                <span className="group-name">{g.name}</span>
                <span className={g.status === "watching" ? "chip-status ok" : "chip-status pending"}>{g.status === "watching" ? "Watching" : "Setting up"}</span>
              </div>
            ))
          )}
        </div>
        <p className="tiny">Want a group added or swapped? Email ross@roowatch.com.au and we do it same day.</p>
      </div>
    );
  }

  if (tab === "alerts") {
    return (
      <div className="page">
        <header className="page-head"><div><h1>Notifications sent</h1><p className="muted">Every lead we have sent you, newest first.</p></div></header>
        <div className="card">
          {alerts.length === 0 ? (
            <div className="empty"><p><strong>Nothing here yet.</strong></p><p className="muted">When a post matches your services, it shows here and goes to your email.</p></div>
          ) : (
            alerts.map((a) => <AlertRow key={a.id} alert={a} />)
          )}
        </div>
        <div className="card">
          <h3>Your channels</h3>
          <div className="group-row"><span className="group-name">Email ({user.email})</span><span className="chip-status ok">On</span></div>
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
        <div className="kv"><span>Business</span><strong>{user.name || "Not set"}</strong></div>
        <div className="kv"><span>Email</span><strong>{user.email}</strong></div>
        <div className="kv"><span>Website</span><strong>{me.profile?.website || "Not set"}</strong></div>
        <div className="kv"><span>Area</span><strong>{me.profile?.location || "Not set"}</strong></div>
        <div className="kv"><span>Services</span><strong>{me.profile?.services || "Not set"}</strong></div>
      </div>
      <div className="card">
        <h3>Your plan</h3>
        <div className="kv"><span>Plan</span><strong>Monthly. 10 groups watched.</strong></div>
        <div className="kv"><span>Guarantee</span><strong>1 job in 30 days or we refund you</strong></div>
        <p className="tiny">Need to change anything? Email ross@roowatch.com.au and we sort it same day.</p>
      </div>
      <div className="card">
        <h3>Session</h3>
        <button className="btn ghost" onClick={onLogout}>Log out</button>
      </div>
    </div>
  );
}

function AlertRow({ alert }: { alert: Alert }) {
  const when = new Date(alert.sentAt + "Z").toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="alert-item">
      <div className="alert-top">
        <strong>{alert.groupName}</strong>
        <span className="tiny">{when}</span>
      </div>
      <p className="alert-text">{alert.postText}</p>
      {alert.reason && <p className="alert-reason">{alert.reason}</p>}
      {alert.postUrl && <a className="alert-link" href={alert.postUrl} target="_blank" rel="noreferrer">Open the post</a>}
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

  const member = members.find((m) => m.id === open) ?? null;

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
    <div className="page admin">
      <header className="page-head">
        <div><h1>Members</h1><p className="muted">Everyone who has signed up. Only you see this.</p></div>
      </header>
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

              <h3 className="mt">Their groups</h3>
              {m.groups.map((g) => (
                <div className="group-row" key={g.id}>
                  <span className="group-name">{g.name}</span>
                  <span className="row gap">
                    <span className={g.status === "watching" ? "chip-status ok" : "chip-status pending"}>{g.status}</span>
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
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PaymentsView({ rows, stripe, onRefresh, busy }: { rows: StripeRow[]; stripe: boolean; onRefresh: () => void; busy: boolean }) {
  const paid = rows.filter((r) => r.status === "paid");
  const revenue = paid.reduce((s, r) => s + (r.amount ?? 0), 0) / 100;
  const fmt = (ts: number) => new Date(ts * 1000).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="page admin">
      <header className="page-head">
        <div><h1>Payments</h1><p className="muted">Live from Stripe.</p></div>
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

.alert-item{border-top:1px solid #f4efe7;padding:14px 2px;}
.alert-item:first-of-type{border-top:0;}
.alert-top{align-items:center;display:flex;gap:10px;justify-content:space-between;}
.alert-text{color:#3c465e;font-size:14.5px;line-height:1.5;margin:8px 0 0;}
.alert-reason{color:var(--mint);font-size:13px;font-weight:700;margin:8px 0 0;}
.alert-link{color:var(--coral-deep);font-size:13.5px;font-weight:700;display:inline-block;margin-top:8px;text-decoration:none;}
.alert-link:hover{text-decoration:underline;}

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
`;
