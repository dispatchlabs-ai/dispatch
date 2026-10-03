import { startRegistration } from "@simplewebauthn/browser";
import { Fingerprint, KeyRound, LogOut, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SecurityState, TotpEnrollment } from "../shared/auth-contracts";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { TotpForm } from "./auth";
import { Button, Field, Input, Modal, Notice, Spinner } from "./ui";

export function SecurityPage() {
  const { state, auth, setState } = useSession();
  const [security, setSecurity] = useState<SecurityState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [passkeyName, setPasskeyName] = useState("");
  const [removingPasskey, setRemovingPasskey] = useState<SecurityState["passkeys"][number] | null>(null);
  const [settingTotp, setSettingTotp] = useState(false);
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState<TotpEnrollment | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setSecurity(await auth("/api/auth/security")); } catch (error) { setError(errorMessage(error)); }
  }, [auth]);
  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<void>) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try { await action(); } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && error.code === "REAUTHENTICATION_REQUIRED") setSecurity(current => current ? { ...current, canManage: false } : current);
    } finally { setBusy(false); }
  }

  if (state?.state !== "authenticated") return null;
  return <section className="settings-page" aria-label="Account and security">
    <header className="page-heading"><div><span className="eyebrow">Your account</span><h1>Account & security</h1><p>Manage how you sign in and where you’re signed in.</p></div></header>
    {error ? <Notice>{error}</Notice> : null}
    {notice ? <Notice tone="success">{notice}</Notice> : null}
    <div className="account-identity"><div className="user-avatar">{state.user.name.slice(0, 1).toUpperCase()}</div><div><strong>{state.user.name}</strong><p>{state.user.email}</p></div></div>
    {!security ? <div className="page-state">{error ? <Button variant="secondary" onClick={() => void load()}>Try again</Button> : <Spinner label="Loading security settings" />}</div> : <>
      {!security.canManage ? <Notice tone="info">For your security, sign out and sign in again before changing a sign-in method. <Button variant="secondary" onClick={() => void run(async () => setState(await auth("/api/auth/logout", {})))} disabled={busy}>Sign out to continue</Button></Notice> : null}
      <section className="settings-section">
        <header><div className="section-icon"><Fingerprint /></div><div><h2>Passkeys</h2><p>Use your fingerprint, face, or device PIN. Keep a second passkey for recovery.</p></div></header>
        {security.passkeys.length ? <ul className="settings-list">{security.passkeys.map(passkey => <li key={passkey.id}><div><strong>{passkey.name}</strong><small>Added {new Date(passkey.createdAt).toLocaleDateString()}</small></div><Button variant="ghost" disabled={busy || !security.canManage} onClick={() => setRemovingPasskey(passkey)} aria-label={`Remove ${passkey.name}`}><Trash2 /> Remove</Button></li>)}</ul> : <p className="section-empty">No passkeys yet.</p>}
        {addingPasskey ? <form className="inline-form" onSubmit={event => {
          event.preventDefault();
          void run(async () => {
            const { options } = await auth("/api/auth/security/passkey/options", { name: passkeyName });
            const response = await startRegistration({ optionsJSON: options });
            setSecurity(await auth("/api/auth/security/passkey/verify", { response, name: passkeyName }));
            setAddingPasskey(false);
            setPasskeyName("");
            setNotice("Your passkey is ready to use.");
          });
        }}><Field label="Passkey name" hint="Use a name you’ll recognize, such as your device or password manager.">{props => <Input {...props} value={passkeyName} onChange={event => setPasskeyName(event.target.value)} placeholder="My password manager" required maxLength={100} autoFocus />}</Field><div className="button-row"><Button type="submit" disabled={busy}>{busy ? <Spinner /> : <Fingerprint />} Create passkey</Button><Button variant="ghost" onClick={() => setAddingPasskey(false)} disabled={busy}>Cancel</Button></div></form> : <Button variant="secondary" disabled={busy || !security.canManage} onClick={() => setAddingPasskey(true)}><Plus /> Add a passkey</Button>}
      </section>

      <section className="settings-section">
        <header><div className="section-icon"><KeyRound /></div><div><h2>Password & authenticator</h2><p>{security.totpEnabled ? "Your authenticator is connected. Password sign-in always requires its six-digit code." : "Add a password and authenticator as another way to sign in."}</p></div></header>
        {security.totpEnabled ? <p className="factor-status"><ShieldCheck size={16} /> Connected · {security.recoveryCodesRemaining} recovery codes remaining</p> : null}
        {settingTotp ? <div className="inline-form">
          <Notice tone="info">Verifying a new authenticator replaces your previous password and authenticator, generates new recovery codes, and signs out your other sessions.</Notice>
          {totp ? <TotpForm enrollment={totp} busy={busy} onVerify={code => run(async () => setState(await auth("/api/auth/security/totp/verify", { code })))} /> : <form className="stack" onSubmit={event => {
            event.preventDefault();
            void run(async () => { setTotp(await auth("/api/auth/security/totp/start", { password })); setPassword(""); });
          }}><Field label="New password" hint="Use at least 12 characters.">{props => <Input {...props} type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={12} autoComplete="new-password" required />}</Field><Button type="submit" disabled={busy}>{busy ? <Spinner /> : <KeyRound />} Set up authenticator</Button></form>}
          <Button variant="ghost" disabled={busy} onClick={() => { setSettingTotp(false); setTotp(null); setPassword(""); }}>Cancel</Button>
        </div> : <Button variant="secondary" disabled={busy || !security.canManage} onClick={() => setSettingTotp(true)}>{security.totpEnabled ? "Replace password & authenticator" : "Add password & authenticator"}</Button>}
      </section>

      <section className="settings-section">
        <header><div className="section-icon"><ShieldCheck /></div><div><h2>Active sessions</h2><p>Sign out sessions you no longer use.</p></div></header>
        <ul className="settings-list">{security.sessions.map(session => <li key={session.id}><div><strong>{session.current ? "This session" : "Other session"}</strong><small>Signed in {new Date(session.createdAt).toLocaleString()}</small></div><Button variant="ghost" disabled={busy} onClick={() => void run(async () => {
          const result = await auth("/api/auth/security/sessions/revoke", { id: session.id });
          if ("state" in result) setState(result); else { setSecurity(result); setNotice("Session signed out."); }
        })}><LogOut /> Sign out</Button></li>)}</ul>
      </section>
    </>}

    <Modal title="Remove this passkey?" description={`You won’t be able to sign in with ${removingPasskey?.name || "this passkey"} after removing it.`} open={!!removingPasskey} onOpenChange={open => { if (!open && !busy) setRemovingPasskey(null); }}>
      {error ? <Notice>{error}</Notice> : null}
      <div className="button-row"><Button variant="secondary" disabled={busy} onClick={() => setRemovingPasskey(null)}>Keep passkey</Button><Button variant="danger" disabled={busy} onClick={() => void run(async () => {
        if (!removingPasskey) return;
        setSecurity(await auth("/api/auth/security/passkey/remove", { id: removingPasskey.id }));
        setRemovingPasskey(null);
        setNotice("Passkey removed.");
      })}>{busy ? <Spinner /> : <Trash2 />} Remove passkey</Button></div>
    </Modal>
  </section>;
}
