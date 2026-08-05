"use client";

import { useEffect, useRef, useState } from "react";

type Session = { email: string; name: string };
type Onboarding = {
  website: string;
  services: string;
  location: string;
  groups: string[];
};
type StripeRow = {
  id: string;
  created: number;
  status: string;
  amount: number | null;
  currency: string | null;
  email: string | null;
  phone: string | null;
  name: string | null;
};

const LS_SESSION = "roowatch_session";
const LS_ONBOARD = "roowatch_onboarding";
const LS_AVATAR = "roowatch_avatar";

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const BellIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
);
const EyeIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
);
const GridIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" width="18" height="18"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
);
const GearIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
);
const ShieldIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
);

export default function DashboardApp() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [tab, setTab] = useState("overview");

  const [adminOpen, setAdminOpen] = useState(false);
  const [adminData, setAdminData] = useState<StripeRow[] | null>(null);
  const [adminStripe, setAdminStripe] = useState(true);
  const [adminPass, setAdminPass] = useState("");
  const [adminError, setAdminError] = useState("");
  const [adminPrompt, setAdminPrompt] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);

  useEffect(() => {
    setSession(load<Session>(LS_SESSION));
    setOnboarding(load<Onboarding>(LS_ONBOARD));
    setAvatar(load<string>(LS_AVATAR));
    setReady(true);
  }, []);

  if (!ready) return null;

  const isRoss = session?.email.toLowerCase() === "ross@roowatch.com.au";

  function logIn(email: string, name: string) {
    const s = { email, name };
    save(LS_SESSION, s);
    setSession(s);
  }
  function logOut() {
    localStorage.removeItem(LS_SESSION);
    setSession(null);
    setAdminOpen(false);
    setAdminData(null);
  }
  function completeOnboarding(data: Onboarding) {
    save(LS_ONBOARD, data);
    setOnboarding(data);
  }

  async function unlockAdmin() {
    setAdminLoading(true);
    setAdminError("");
    try {
      const res = await fetch("/api/admin/stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPass }),
      });
      if (res.status === 401) {
        setAdminError("Wrong password.");
        return;
      }
      if (!res.ok) {
        setAdminError("Server is not set up yet.");
        return;
      }
      const data = await res.json();
      setAdminData(data.rows ?? []);
      setAdminStripe(Boolean(data.stripe));
      setAdminOpen(true);
      setAdminPrompt(false);
    } catch {
      setAdminError("Could not reach the server.");
    } finally {
      setAdminLoading(false);
    }
  }

  return (
    <div className="dash">
      <style>{CSS}</style>

      {!session && <Login onLogin={logIn} />}

      {session && (
        <div className="shell">
          <aside className="side">
            <a className="brand" href="/dashboard">
              <span className="brand-mark">R</span>
              <span>RooWatch</span>
            </a>
            <nav className="nav">
              <button className={tab === "overview" && !adminOpen ? "on" : ""} onClick={() => { setTab("overview"); setAdminOpen(false); }}>{GridIcon} Overview</button>
              <button className={tab === "groups" && !adminOpen ? "on" : ""} onClick={() => { setTab("groups"); setAdminOpen(false); }}>{EyeIcon} Groups watching</button>
              <button className={tab === "alerts" && !adminOpen ? "on" : ""} onClick={() => { setTab("alerts"); setAdminOpen(false); }}>{BellIcon} Notifications sent</button>
            </nav>
            <div className="side-bottom">
              {isRoss && (
                <button className={"admin-link" + (adminOpen ? " on" : "")} onClick={() => (adminOpen ? setAdminOpen(false) : setAdminPrompt(true))}>
                  {ShieldIcon} Master dashboard
                </button>
              )}
              <button className={tab === "settings" && !adminOpen ? "on" : ""} onClick={() => { setTab("settings"); setAdminOpen(false); }}>{GearIcon} Settings</button>
              <div className="side-user">
                <Avatar avatar={avatar} name={session.name} />
                <div className="side-user-meta">
                  <strong>{session.name || "Member"}</strong>
                  <span>{session.email}</span>
                </div>
                <button className="logout" title="Log out" onClick={logOut}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                </button>
              </div>
            </div>
          </aside>

          <main className="main">
            {adminOpen && isRoss ? (
              <AdminView rows={adminData ?? []} stripe={adminStripe} onRefresh={unlockAdmin} loading={adminLoading} />
            ) : (
              <MemberView tab={tab} onboarding={onboarding} session={session} avatar={avatar} setAvatar={(a) => { if (a) save(LS_AVATAR, a); else localStorage.removeItem(LS_AVATAR); setAvatar(a); }} onLogout={logOut} />
            )}
          </main>

          {!onboarding && <OnboardingModal onDone={completeOnboarding} />}

          {adminPrompt && (
            <div className="overlay">
              <div className="modal modal-small">
                <h2>Master dashboard</h2>
                <p className="muted">Enter the master password to open the admin view.</p>
                <input type="password" placeholder="Master password" value={adminPass} onChange={(e) => setAdminPass(e.target.value)} onKeyDown={(e) => e.key === "Enter" && unlockAdmin()} autoFocus />
                {adminError && <p className="error">{adminError}</p>}
                <div className="row gap">
                  <button className="btn ghost" onClick={() => { setAdminPrompt(false); setAdminError(""); }}>Cancel</button>
                  <button className="btn primary" onClick={unlockAdmin} disabled={adminLoading}>{adminLoading ? "Checking..." : "Unlock"}</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Avatar({ avatar, name }: { avatar: string | null; name: string }) {
  if (avatar) return <img className="avatar-img" src={avatar} alt="" />;
  const initials = (name || "M").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return <span className="avatar-fallback">{initials}</span>;
}

function Login({ onLogin }: { onLogin: (email: string, name: string) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const ok = /.+@.+\..+/.test(email);
  return (
    <div className="login">
      <div className="login-card">
        <a className="brand brand-dark" href="/">
          <span className="brand-mark">R</span>
          <span>RooWatch</span>
        </a>
        <h1>Welcome back</h1>
        <p className="muted">Log in to see your leads.</p>
        <label>Your name</label>
        <input placeholder="Ross Delport" value={name} onChange={(e) => setName(e.target.value)} />
        <label>Email</label>
        <input type="email" placeholder="you@business.com.au" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ok && onLogin(email, name)} />
        <button className="btn primary wide" disabled={!ok} onClick={() => onLogin(email, name)}>Log in</button>
        <p className="tiny">Trouble logging in? Email ross@roowatch.com.au</p>
      </div>
    </div>
  );
}

function OnboardingModal({ onDone }: { onDone: (d: Onboarding) => void }) {
  const [step, setStep] = useState(0);
  const [website, setWebsite] = useState("");
  const [services, setServices] = useState("");
  const [location, setLocation] = useState("");
  const [groupInput, setGroupInput] = useState("");
  const [groups, setGroups] = useState<string[]>([]);

  const steps = [
    { title: "Your website", sub: "Where can we see your business?", valid: website.trim().length > 3 },
    { title: "What do you do?", sub: "Tell us your services in plain English.", valid: services.trim().length > 5 },
    { title: "Where do you work?", sub: "Your city and the suburbs you serve.", valid: location.trim().length > 2 },
    { title: "Groups to watch", sub: "Know any good local groups? Add them. We find the rest.", valid: true },
  ];

  function addGroup() {
    const g = groupInput.trim();
    if (g && !groups.includes(g)) setGroups([...groups, g]);
    setGroupInput("");
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

        {step === 0 && (
          <input placeholder="www.yourbusiness.com.au" value={website} onChange={(e) => setWebsite(e.target.value)} autoFocus />
        )}
        {step === 1 && (
          <textarea rows={4} placeholder="We install solar panels for homes in Sydney. We also do battery upgrades and repairs." value={services} onChange={(e) => setServices(e.target.value)} autoFocus />
        )}
        {step === 2 && (
          <input placeholder="Sydney. Northern Beaches, Manly, Dee Why." value={location} onChange={(e) => setLocation(e.target.value)} autoFocus />
        )}
        {step === 3 && (
          <div>
            <div className="row gap">
              <input placeholder="Home Advice Sydney" value={groupInput} onChange={(e) => setGroupInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addGroup()} autoFocus />
              <button className="btn ghost" onClick={addGroup}>Add</button>
            </div>
            {groups.length > 0 && (
              <div className="chips">
                {groups.map((g) => (
                  <span key={g} className="chip">
                    {g}
                    <button onClick={() => setGroups(groups.filter((x) => x !== g))}>&times;</button>
                  </span>
                ))}
              </div>
            )}
            <p className="tiny">This step is optional. Skip it if you are not sure.</p>
          </div>
        )}

        <div className="row spread">
          {step > 0 ? (
            <button className="btn ghost" onClick={() => setStep(step - 1)}>Back</button>
          ) : <span />}
          {step < steps.length - 1 ? (
            <button className="btn primary" disabled={!steps[step].valid} onClick={() => setStep(step + 1)}>Next</button>
          ) : (
            <button className="btn primary" onClick={() => onDone({ website, services, location, groups })}>Finish setup</button>
          )}
        </div>
      </div>
    </div>
  );
}

function MemberView({ tab, onboarding, session, avatar, setAvatar, onLogout }: {
  tab: string;
  onboarding: Onboarding | null;
  session: Session;
  avatar: string | null;
  setAvatar: (a: string | null) => void;
  onLogout: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const groups = onboarding?.groups?.length ? onboarding.groups : [];
  const watching = [...groups, "Finding more groups near you"];

  function pickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setAvatar(String(reader.result));
    reader.readAsDataURL(f);
  }

  if (tab === "overview") {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <h1>G'day{session.name ? `, ${session.name.split(" ")[0]}` : ""}</h1>
            <p className="muted">Your watchlist is warming up. Alerts land here and on your phone.</p>
          </div>
          <span className="live"><i /> Watching live</span>
        </header>
        <div className="tiles">
          <div className="tile"><span className="tile-num">{watching.length - 1 || "..."}</span><span className="tile-label">Groups watching</span></div>
          <div className="tile"><span className="tile-num">0</span><span className="tile-label">Alerts sent</span></div>
          <div className="tile"><span className="tile-num">0</span><span className="tile-label">Leads this week</span></div>
          <div className="tile tile-accent"><span className="tile-num">&lt;5 min</span><span className="tile-label">Alert speed</span></div>
        </div>
        <div className="card">
          <h3>Latest alerts</h3>
          <div className="empty">
            <p><strong>No alerts yet.</strong> That is normal on day one.</p>
            <p className="muted">We are setting up your watchlist. The first alert usually lands within 48 hours.</p>
          </div>
        </div>
      </div>
    );
  }

  if (tab === "groups") {
    return (
      <div className="page">
        <header className="page-head"><div><h1>Groups watching</h1><p className="muted">The groups we read for you, day and night.</p></div></header>
        <div className="card">
          {watching.map((g, i) => (
            <div className="group-row" key={g}>
              <span className="group-name">{g}</span>
              <span className={i === watching.length - 1 ? "chip-status pending" : "chip-status ok"}>{i === watching.length - 1 ? "Searching" : "Watching"}</span>
            </div>
          ))}
          {groups.length === 0 && (
            <p className="muted pad">You did not add any groups yet. We are finding the best ones for your area.</p>
          )}
        </div>
      </div>
    );
  }

  if (tab === "alerts") {
    return (
      <div className="page">
        <header className="page-head"><div><h1>Notifications sent</h1><p className="muted">Every alert we have sent you, newest first.</p></div></header>
        <div className="card">
          <div className="empty">
            <p><strong>Nothing here yet.</strong></p>
            <p className="muted">When a post matches your services, the alert shows here and goes to your email and phone.</p>
          </div>
        </div>
        <div className="card">
          <h3>Your channels</h3>
          <div className="group-row"><span className="group-name">Email ({session.email})</span><span className="chip-status ok">On</span></div>
          <div className="group-row"><span className="group-name">Text message</span><span className="chip-status ok">On</span></div>
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
          <Avatar avatar={avatar} name={session.name} />
          <div className="row gap">
            <button className="btn ghost" onClick={() => fileRef.current?.click()}>Change photo</button>
            {avatar && <button className="btn ghost" onClick={() => setAvatar(null)}>Remove</button>}
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickAvatar} />
        </div>
        <div className="kv"><span>Name</span><strong>{session.name || "Not set"}</strong></div>
        <div className="kv"><span>Email</span><strong>{session.email}</strong></div>
      </div>
      <div className="card">
        <h3>Your plan</h3>
        <div className="kv"><span>Plan</span><strong>Monthly. 10 groups watched.</strong></div>
        <div className="kv"><span>Price</span><strong>$49 first month, then $197 a month</strong></div>
        <div className="kv"><span>Guarantee</span><strong>1 job in 30 days or we refund you</strong></div>
        <p className="tiny">Want to change or cancel your plan? Email ross@roowatch.com.au and we sort it same day.</p>
      </div>
      <div className="card">
        <h3>Session</h3>
        <button className="btn ghost" onClick={onLogout}>Log out</button>
      </div>
    </div>
  );
}

function AdminView({ rows, stripe, onRefresh, loading }: { rows: StripeRow[]; stripe: boolean; onRefresh: () => void; loading: boolean }) {
  const paid = rows.filter((r) => r.status === "paid");
  const revenue = paid.reduce((sum, r) => sum + (r.amount ?? 0), 0) / 100;
  const fmt = (ts: number) => new Date(ts * 1000).toLocaleString("en-AU", { timeZone: "Australia/Perth", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="page admin">
      <header className="page-head">
        <div><h1>Master dashboard</h1><p className="muted">Live from Stripe. Only you can see this.</p></div>
        <button className="btn ghost" onClick={onRefresh} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
      </header>

      {!stripe ? (
        <div className="card">
          <h3>Stripe is not connected yet</h3>
          <p className="muted">Add a read-only Stripe key as the STRIPE_SECRET_KEY secret on the worker and this page fills itself with your reservations.</p>
        </div>
      ) : (
        <>
          <div className="tiles">
            <div className="tile"><span className="tile-num">{paid.length}</span><span className="tile-label">Paid reservations</span></div>
            <div className="tile"><span className="tile-num">${revenue.toFixed(0)}</span><span className="tile-label">Revenue</span></div>
            <div className="tile"><span className="tile-num">{rows.length - paid.length}</span><span className="tile-label">Started, not paid</span></div>
            <div className="tile tile-accent"><span className="tile-num">{paid.length > 0 ? fmt(paid[0].created) : "None yet"}</span><span className="tile-label">Latest reservation</span></div>
          </div>
          <div className="card">
            <h3>Reservations</h3>
            {rows.length === 0 ? (
              <div className="empty"><p><strong>No checkouts yet.</strong></p><p className="muted">The moment someone starts the $1 checkout, they show here.</p></div>
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

const CSS = `
.dash { --cream:#fff9f1; --ink:#172038; --muted:#6b7385; --line:#ece5da; --navy:#111d36; --coral:#ff6a4d; --coral-deep:#f04f31; --mint:#2eaa81; --mint-soft:#c9efdb; --gold-soft:#ffe3a3; --shadow:0 30px 70px rgba(23,32,56,.13); --shadow-soft:0 12px 30px rgba(23,32,56,.08); --ease:cubic-bezier(.22,1,.36,1);
  background:var(--cream); color:var(--ink); font-family:var(--font-inter-tight),"Inter Tight",Arial,sans-serif; min-height:100vh; }
.dash *{box-sizing:border-box; font-family:inherit;}
.dash button{cursor:pointer;}
@keyframes dRise{from{opacity:0;transform:translateY(20px)}}
@keyframes dPop{from{opacity:0;transform:scale(.94) translateY(14px)}}
@keyframes dPulse{0%,100%{opacity:1}50%{opacity:.35}}

.brand{align-items:center;color:#fff;display:inline-flex;font-size:19px;font-weight:800;gap:9px;letter-spacing:-.04em;text-decoration:none;}
.brand-dark{color:var(--ink);}
.brand-mark{align-items:center;background:var(--coral);border-radius:8px 8px 8px 3px;color:#fff;display:inline-flex;font-size:15px;font-weight:900;height:28px;justify-content:center;transform:rotate(-6deg);width:28px;}

.shell{display:grid;grid-template-columns:250px 1fr;min-height:100vh;}
.side{background:var(--navy);color:#fff;display:flex;flex-direction:column;padding:24px 16px;position:sticky;top:0;height:100vh;}
.side .brand{padding:4px 10px 22px;}
.nav{display:grid;gap:4px;margin-top:8px;}
.nav button,.side-bottom>button{align-items:center;background:none;border:0;border-radius:10px;color:#b8c3d8;display:flex;font-size:14px;font-weight:600;gap:11px;padding:11px 12px;text-align:left;transition:background .2s var(--ease),color .2s var(--ease);width:100%;}
.nav button:hover,.side-bottom>button:hover{background:rgba(255,255,255,.07);color:#fff;}
.nav button.on,.side-bottom>button.on{background:var(--coral);color:#fff;}
.side-bottom{display:grid;gap:4px;margin-top:auto;}
.admin-link{color:#8fa1c0;}
.admin-link.on{background:var(--coral);color:#fff;}
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
.empty{padding:18px 0 10px;text-align:center;}
.empty p{margin:0 0 6px;}
.group-row{align-items:center;border-top:1px solid #f4efe7;display:flex;font-size:14.5px;justify-content:space-between;padding:12px 2px;}
.group-row:first-of-type{border-top:0;}
.group-name{font-weight:600;}
.chip-status{border-radius:99px;font-size:11.5px;font-weight:800;padding:5px 11px;}
.chip-status.ok{background:#e2f6ec;color:#1d8a63;}
.chip-status.pending{background:#fff3d8;color:#8a5a00;}
.pad{padding:10px 2px;}

.kv{border-top:1px solid #f4efe7;display:flex;font-size:14px;gap:16px;justify-content:space-between;padding:11px 2px;}
.kv span{color:var(--muted);}
.profile-row{align-items:center;display:flex;gap:14px;margin-bottom:14px;}
.profile-row .avatar-img,.profile-row .avatar-fallback{height:52px;width:52px;font-size:16px;}
.tiny{color:#98a0b3;font-size:12.5px;margin:12px 0 0;}

.btn{align-items:center;border:0;border-radius:99px;display:inline-flex;font-size:14px;font-weight:700;gap:8px;justify-content:center;padding:11px 20px;transition:transform .2s var(--ease),background .2s,box-shadow .2s;}
.btn:hover{transform:translateY(-1px);}
.btn:disabled{cursor:default;opacity:.5;transform:none;}
.btn.primary{background:var(--coral);box-shadow:0 10px 22px rgba(240,79,49,.3);color:#fff;}
.btn.primary:hover:not(:disabled){background:var(--coral-deep);}
.btn.ghost{background:#fff;border:1px solid var(--line);color:var(--ink);}
.btn.wide{margin-top:18px;width:100%;}

.login{align-items:center;display:flex;justify-content:center;min-height:100vh;padding:20px;}
.login-card{animation:dPop .5s var(--ease) both;background:#fff;border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);max-width:400px;padding:36px;width:100%;}
.login-card h1{font-size:26px;letter-spacing:-.02em;margin:22px 0 6px;}
.login-card label{display:block;font-size:12.5px;font-weight:700;margin:16px 0 6px;}
.dash input,.dash textarea{background:#faf7f2;border:1px solid var(--line);border-radius:10px;color:var(--ink);font-size:14.5px;outline:none;padding:12px 14px;transition:border-color .2s;width:100%;resize:vertical;}
.dash input:focus,.dash textarea:focus{border-color:var(--coral);}

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
.row.spread{justify-content:space-between;margin-top:22px;}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}
.chip{align-items:center;background:var(--mint-soft);border-radius:99px;color:#14724f;display:inline-flex;font-size:13px;font-weight:700;gap:7px;padding:6px 8px 6px 13px;}
.chip button{background:none;border:0;color:#14724f;font-size:15px;line-height:1;padding:0 4px;}
.error{color:var(--coral-deep);font-size:13px;font-weight:600;margin:10px 0 0;}
.modal .row.gap{justify-content:flex-end;margin-top:18px;}

.table-wrap{overflow-x:auto;}
.admin table{border-collapse:collapse;font-size:13.5px;width:100%;}
.admin th{border-bottom:1px solid var(--line);color:#8b93a7;font-size:11.5px;letter-spacing:.05em;padding:9px 10px;text-align:left;text-transform:uppercase;}
.admin td{border-bottom:1px solid #f6f1e9;padding:11px 10px;white-space:nowrap;}
.admin td a{color:var(--coral-deep);text-decoration:none;}
.admin td a:hover{text-decoration:underline;}

@media(max-width:860px){
  .shell{grid-template-columns:1fr;}
  .side{flex-direction:row;flex-wrap:wrap;height:auto;position:static;align-items:center;gap:6px;}
  .side .brand{padding:4px 8px;}
  .nav{display:flex;gap:4px;margin:0 auto;}
  .nav button{padding:9px 10px;}
  .side-bottom{display:flex;margin:0;}
  .side-user{border:0;margin:0;padding:0 4px;}
  .side-user-meta{display:none;}
  .main{padding:22px 16px 50px;}
  .tiles{grid-template-columns:repeat(2,1fr);}
}
`;
