"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { OTHER_TRADE, STATES, TRADES } from "../../db/trades";

const PIXEL_ID = "4105570149577363";

type Pixel = ((...args: unknown[]) => void) & {
  queue?: unknown[];
  callMethod?: (...args: unknown[]) => void;
  loaded?: boolean;
  version?: string;
};

function pixel() {
  return (window as unknown as { fbq?: Pixel }).fbq;
}

/** The standard Meta snippet, written once when the page opens. */
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
  fbq("track", "PageView");
}

export default function SignupApp({ start }: { start: "signup" | "login" }) {
  const [mode, setMode] = useState<"signup" | "login">(start);
  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [trade, setTrade] = useState("");
  const [tradeOther, setTradeOther] = useState("");
  const [state, setState] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [linkSent, setLinkSent] = useState(false);

  useEffect(() => {
    startPixel();
    // Our own count, so the Marketing tab can show the signup funnel.
    fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "view_signup", path: "/signup" }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  const emailOk = /.+@.+\..+/.test(email.trim());
  const phoneOk = phone.replace(/[^\d]/g, "").length >= 9;
  const chosenTrade = trade === OTHER_TRADE ? tradeOther.trim() : trade;
  const signupOk =
    name.trim().length > 1 &&
    businessName.trim().length > 1 &&
    emailOk &&
    phoneOk &&
    password.length >= 8 &&
    chosenTrade.length > 1 &&
    state.length > 1;
  const loginOk = emailOk && password.length > 0;

  function swap(next: "signup" | "login") {
    setMode(next);
    setError("");
    setLinkSent(false);
  }

  async function submit() {
    if (busy) return;
    if (mode === "signup" ? !signupOk : !loginOk) return;
    setBusy(true);
    setError("");
    try {
      const path = mode === "signup" ? "/api/auth/signup" : "/api/auth/login";
      const payload =
        mode === "signup"
          ? {
              name: name.trim(),
              businessName: businessName.trim(),
              email: email.trim(),
              phone: phone.trim(),
              password,
              trade: chosenTrade,
              state,
            }
          : { email: email.trim(), password };

      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        setError(messageFor(data.error, data.message));
        return;
      }

      if (mode === "signup") {
        pixel()?.("track", "CompleteRegistration", { content_name: "RooWatch account" });
      }
      window.location.href = "/dashboard";
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function sendLink() {
    if (!emailOk || busy) return;
    setBusy(true);
    setError("");
    try {
      await fetch("/api/auth/request-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      setLinkSent(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <style>{CSS}</style>
      <div className="auth-grid">
        <aside className="auth-brand">
          <Link className="brand" href="/">
            <span className="brand-mark">R</span>
            <span>RooWatch</span>
          </Link>

          <div className="brand-body">
            <h2>More local jobs, sent to your phone.</h2>
            <ul className="proof">
              <li>We watch your local Facebook groups all day and all night.</li>
              <li>You get an alert in about 5 minutes.</li>
              <li>You reply first, so you win the job.</li>
            </ul>
          </div>

          {/* Static brand art. Next's optimiser adds no value at one fixed size. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-roo" src="/roowatch-mascot-3d-binos.png" alt="" />
          <p className="brand-foot">Proudly Australian. ABN 288 114 939 09</p>
        </aside>

        <main className="auth-main">
          <div className="auth-card">
            <div className="tabs" role="tablist">
              <button
                role="tab"
                aria-selected={mode === "signup"}
                className={mode === "signup" ? "on" : ""}
                onClick={() => swap("signup")}
              >
                Sign up
              </button>
              <button
                role="tab"
                aria-selected={mode === "login"}
                className={mode === "login" ? "on" : ""}
                onClick={() => swap("login")}
              >
                Log in
              </button>
            </div>

            {mode === "signup" ? (
              <>
                <h1>Start getting leads</h1>
                <p className="sub">It takes one minute. No card needed today.</p>

                <div className="pair">
                  <Field label="Your name">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Dave Smith"
                      autoComplete="name"
                    />
                  </Field>
                  <Field label="Business name">
                    <input
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      placeholder="Smith Plumbing"
                      autoComplete="organization"
                    />
                  </Field>
                </div>

                <div className="pair">
                  <Field label="Email">
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@business.com.au"
                      autoComplete="email"
                    />
                  </Field>
                  <Field label="Mobile">
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="0400 000 000"
                      autoComplete="tel"
                    />
                  </Field>
                </div>

                <Field label="Password" hint="8 letters or more.">
                  <div className="pass">
                    <input
                      type={showPass ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Make one up"
                      autoComplete="new-password"
                      onKeyDown={(e) => e.key === "Enter" && submit()}
                    />
                    <button type="button" className="peek" onClick={() => setShowPass(!showPass)}>
                      {showPass ? "Hide" : "Show"}
                    </button>
                  </div>
                </Field>

                <div className="pair">
                  <Field label="What do you do?">
                    <select value={trade} onChange={(e) => setTrade(e.target.value)}>
                      <option value="">Pick your trade</option>
                      {TRADES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                      <option value={OTHER_TRADE}>{OTHER_TRADE}</option>
                    </select>
                  </Field>
                  <Field label="Which state?">
                    <select value={state} onChange={(e) => setState(e.target.value)}>
                      <option value="">Pick your state</option>
                      {STATES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                {trade === OTHER_TRADE && (
                  <Field label="Tell us your trade">
                    <input
                      value={tradeOther}
                      onChange={(e) => setTradeOther(e.target.value)}
                      placeholder="Blind and curtain fitting"
                      autoFocus
                    />
                  </Field>
                )}

                {error && <p className="err">{error}</p>}

                <button className="cta" disabled={!signupOk || busy} onClick={submit}>
                  {busy ? "Creating your account" : "Create my account"}
                </button>

                <p className="foot">
                  Already with us?{" "}
                  <button className="linky" onClick={() => swap("login")}>
                    Log in
                  </button>
                </p>
              </>
            ) : linkSent ? (
              <>
                <h1>Check your email</h1>
                <p className="sub">
                  We sent a login link to {email.trim()}. It lasts 30 minutes. Open it and you are
                  in.
                </p>
                <button className="cta ghost" onClick={() => setLinkSent(false)}>
                  Back to log in
                </button>
              </>
            ) : (
              <>
                <h1>Welcome back</h1>
                <p className="sub">Log in to see your leads.</p>

                <Field label="Email">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@business.com.au"
                    autoComplete="email"
                    autoFocus
                  />
                </Field>

                <Field label="Password">
                  <div className="pass">
                    <input
                      type={showPass ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Your password"
                      autoComplete="current-password"
                      onKeyDown={(e) => e.key === "Enter" && submit()}
                    />
                    <button type="button" className="peek" onClick={() => setShowPass(!showPass)}>
                      {showPass ? "Hide" : "Show"}
                    </button>
                  </div>
                </Field>

                {error && <p className="err">{error}</p>}

                <button className="cta" disabled={!loginOk || busy} onClick={submit}>
                  {busy ? "Logging you in" : "Log in"}
                </button>

                <p className="foot">
                  <button className="linky" disabled={!emailOk || busy} onClick={sendLink}>
                    Forgot your password? Email me a link
                  </button>
                </p>
                <p className="foot">
                  New here?{" "}
                  <button className="linky" onClick={() => swap("signup")}>
                    Create an account
                  </button>
                </p>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

function messageFor(code?: string, message?: string) {
  switch (code) {
    case "email_taken":
      return "That email already has an account. Try logging in instead.";
    case "weak_password":
      return message || "Your password needs 8 letters or more.";
    case "bad_email":
      return "That email does not look right.";
    case "bad_phone":
      return "That mobile number does not look right. Use the format 0400 000 000.";
    case "bad_name":
      return "Please tell us your name.";
    case "bad_business":
      return "Please tell us your business name.";
    case "bad_trade":
      return "Please tell us what you do.";
    case "bad_state":
      return "Please pick your state.";
    case "no_password":
      return "This account has no password yet. Use the email link below, then set one in Settings.";
    case "bad_login":
      return "Wrong email or password.";
    default:
      return "Something went wrong. Please try again.";
  }
}

const ARROW =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5 6 6.5l5-5' stroke='%236b7385' stroke-width='2' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

const CSS = `
.auth{--cream:#fff9f1;--ink:#172038;--muted:#6b7385;--line:#ece5da;--navy:#111d36;--coral:#ff6a4d;--coral-deep:#f04f31;--mint:#2eaa81;--ease:cubic-bezier(.22,1,.36,1);
  background:var(--cream);color:var(--ink);font-family:var(--font-inter-tight),"Inter Tight",Arial,sans-serif;min-height:100vh;}
.auth *{box-sizing:border-box;font-family:inherit;}
.auth button{cursor:pointer;}
@keyframes aRise{from{opacity:0;transform:translateY(18px)}}
@keyframes aPop{from{opacity:0;transform:scale(.96) translateY(12px)}}

.auth-grid{display:grid;grid-template-columns:minmax(0,440px) 1fr;min-height:100vh;}

.auth-brand{background:radial-gradient(120% 90% at 8% 0%,#1d2f52 0%,var(--navy) 55%);color:#fff;display:flex;flex-direction:column;overflow:hidden;padding:34px 40px 0;position:relative;}
.auth-brand::after{background:radial-gradient(closest-side,rgba(255,106,77,.5),transparent 70%);content:"";height:420px;left:-140px;position:absolute;top:38%;width:420px;}
.auth-brand>*{position:relative;z-index:1;}
.brand{align-items:center;color:#fff;display:inline-flex;font-size:20px;font-weight:800;gap:9px;letter-spacing:-.04em;text-decoration:none;width:fit-content;}
.brand-mark{align-items:center;background:var(--coral);border-radius:8px 8px 8px 3px;color:#fff;display:inline-flex;font-size:15px;font-weight:900;height:28px;justify-content:center;transform:rotate(-6deg);width:28px;}
.brand-body{animation:aRise .6s var(--ease) both;margin-top:auto;padding-top:44px;}
.brand-body h2{font-size:34px;font-weight:800;letter-spacing:-.03em;line-height:1.15;margin:0 0 22px;max-width:15ch;}
.proof{display:grid;gap:14px;list-style:none;margin:0;padding:0;}
.proof li{color:#c8d3e6;font-size:15px;line-height:1.5;padding-left:30px;position:relative;}
.proof li::before{align-items:center;background:rgba(46,170,129,.18);border-radius:99px;color:var(--mint);content:"\\2713";display:flex;font-size:11px;font-weight:900;height:20px;justify-content:center;left:0;position:absolute;top:1px;width:20px;}
.brand-roo{animation:aRise .8s var(--ease) both;display:block;margin:26px auto -6px;max-width:270px;width:76%;}
.brand-foot{border-top:1px solid rgba(255,255,255,.1);color:#8fa1c0;font-size:12.5px;margin:0;padding:16px 0;text-align:center;}

.auth-main{align-items:center;display:flex;justify-content:center;padding:40px 24px;}
.auth-card{animation:aPop .5s var(--ease) both;background:#fff;border:1px solid var(--line);border-radius:22px;box-shadow:0 30px 70px rgba(23,32,56,.1);max-width:520px;padding:34px;width:100%;}
.auth-card h1{font-size:27px;font-weight:800;letter-spacing:-.03em;margin:0 0 6px;}
.sub{color:var(--muted);font-size:14.5px;line-height:1.5;margin:0 0 22px;}

.tabs{background:#f6f1e9;border-radius:99px;display:grid;gap:3px;grid-template-columns:1fr 1fr;margin-bottom:24px;padding:4px;}
.tabs button{background:none;border:0;border-radius:99px;color:var(--muted);font-size:14px;font-weight:700;padding:10px 8px;transition:background .22s var(--ease),color .22s var(--ease),box-shadow .22s var(--ease);}
.tabs button.on{background:#fff;box-shadow:0 3px 10px rgba(23,32,56,.09);color:var(--ink);}

.pair{display:grid;gap:0 14px;grid-template-columns:1fr 1fr;}
.field{display:block;margin-bottom:16px;}
.field-label{display:block;font-size:12.5px;font-weight:700;margin-bottom:6px;}
.field-hint{color:#98a0b3;display:block;font-size:12px;margin-top:6px;}
.auth input,.auth select{background:#faf7f2;border:1px solid var(--line);border-radius:11px;color:var(--ink);font-size:15px;outline:none;padding:13px 14px;transition:border-color .2s,box-shadow .2s;width:100%;}
.auth input:focus,.auth select:focus{border-color:var(--coral);box-shadow:0 0 0 3px rgba(255,106,77,.14);}
.auth input::placeholder{color:#b3b9c6;}
.auth select{appearance:none;background-image:url("${ARROW}");background-position:right 14px center;background-repeat:no-repeat;cursor:pointer;padding-right:36px;}

.pass{position:relative;}
.pass input{padding-right:62px;}
.peek{background:none;border:0;color:var(--muted);font-size:12.5px;font-weight:700;padding:6px;position:absolute;right:9px;top:50%;transform:translateY(-50%);}
.peek:hover{color:var(--coral-deep);}

.err{background:#fdece8;border-radius:10px;color:var(--coral-deep);font-size:13.5px;font-weight:600;line-height:1.45;margin:0 0 14px;padding:11px 13px;}

.cta{background:var(--coral);border:0;border-radius:99px;box-shadow:0 5px 0 #c93d22,0 14px 26px rgba(240,79,49,.28);color:#fff;font-size:15.5px;font-weight:800;margin-top:6px;padding:15px 22px;transition:transform .18s var(--ease),box-shadow .18s var(--ease),background .18s;width:100%;}
.cta:hover:not(:disabled){background:var(--coral-deep);box-shadow:0 7px 0 #c93d22,0 18px 30px rgba(240,79,49,.32);transform:translateY(-2px);}
.cta:active:not(:disabled){box-shadow:0 1px 0 #c93d22,0 8px 16px rgba(240,79,49,.24);transform:translateY(3px);}
.cta:disabled{background:#f3c6bb;box-shadow:none;cursor:default;}
.cta.ghost{background:#fff;border:1px solid var(--line);box-shadow:none;color:var(--ink);}
.cta.ghost:hover{background:#faf7f2;transform:none;}

.foot{color:var(--muted);font-size:13.5px;margin:16px 0 0;text-align:center;}
.linky{background:none;border:0;color:var(--coral-deep);font-size:13.5px;font-weight:700;padding:0;text-decoration:underline;text-underline-offset:3px;}
.linky:disabled{color:#c7ccd6;cursor:default;text-decoration:none;}

@media(max-width:980px){
  .auth-grid{grid-template-columns:1fr;}
  .auth-brand{padding:22px 22px 0;}
  .auth-brand::after{display:none;}
  .brand-body{margin:0;padding-top:22px;}
  .brand-body h2{font-size:25px;margin-bottom:16px;max-width:none;}
  .proof{gap:9px;}
  .proof li{font-size:14px;}
  .brand-roo{display:none;}
  .brand-foot{border:0;padding:20px 0 16px;}
  .auth-main{padding:26px 18px 46px;}
  .auth-card{padding:26px 22px;}
}
@media(max-width:520px){
  .pair{grid-template-columns:1fr;}
}
`;
