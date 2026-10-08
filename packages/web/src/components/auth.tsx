import { downloadBlob } from "../lib/download";
import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  ArrowLeft,
  ArrowRight,
  Download,
  Fingerprint,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  AuthenticatedState,
  EnrollmentState,
  TotpEnrollment,
} from "../shared/auth-contracts";
import { errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { AuthLayout } from "./auth-layout";
import { Brand } from "./brand";
import { Button, Field, Input, Notice, Spinner } from "./ui";

function useAuthAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { state, setState, startupError, reload } = useSession();
  const [recovery, setRecovery] = useState(false);
  if (!state) {
    if (startupError) {
      return (
        <AuthLayout
          title="We couldn’t open your workspace"
          description="Please try again. If an invitation has expired, request a new link from the person who invited you."
        >
          <Notice>{startupError}</Notice>
          <div className="button-row">
            <Button onClick={reload}>Try again</Button>
            <Button
              variant="secondary"
              onClick={() => setState({ state: "signed_out" })}
            >
              Go to sign in
            </Button>
          </div>
        </AuthLayout>
      );
    }
    return (
      <main className="page-loading" aria-busy="true">
        <Brand />
        <p>
          <Spinner /> Opening your workspace…
        </p>
      </main>
    );
  }
  if (state.state === "authenticated") {
    return (
      <>
        <div
          key={`${state.user.companyId}:${state.user.id}`}
          hidden={!!state.recoveryCodes?.length}
        >
          {children}
        </div>
        {state.recoveryCodes?.length ? (
          <RecoveryCodes
            state={state}
            onDone={() => setState({ ...state, recoveryCodes: undefined })}
          />
        ) : null}
      </>
    );
  }
  if (state.state === "totp_required")
    return <TotpChallenge email={state.email} />;
  if (state.state === "enrollment") return <Enrollment state={state} />;
  if (recovery) return <Recovery onBack={() => setRecovery(false)} />;
  return <SignIn onRecover={() => setRecovery(true)} />;
}

function SignIn({ onRecover }: { onRecover: () => void }) {
  const { auth, setState } = useSession();
  const { busy, error, run } = useAuthAction();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const next = await auth("/api/auth/password", { email, password });
      setPassword("");
      setState(next);
    });
  }

  return (
    <AuthLayout
      title="Welcome back"
      description="Sign in to your Dispatch workspace."
      footer={
        <>
          <p>
            Access is by invitation. Contact your team if you need an account.
          </p>
          <Button
            variant="ghost"
            className="recovery-link"
            disabled={busy}
            onClick={onRecover}
          >
            Having trouble signing in?
          </Button>
        </>
      }
    >
      {error ? <Notice>{error}</Notice> : null}
      <Button
        className="auth-passkey"
        variant="secondary"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const { options } = await auth(
              "/api/auth/passkey/login/options",
              {},
            );
            const response = await startAuthentication({
              optionsJSON: options,
            });
            setState(
              await auth("/api/auth/passkey/login/verify", { response }),
            );
          })
        }
      >
        <Fingerprint /> Continue with a passkey
      </Button>
      <div className="auth-divider">or use a password</div>
      <form onSubmit={submit} aria-busy={busy}>
        <Field label="Email address">
          {(props) => (
            <Input
              {...props}
              type="email"
              name="username"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoCapitalize="none"
              spellCheck={false}
            />
          )}
        </Field>
        <Field label="Password">
          {(props) => (
            <Input
              {...props}
              type="password"
              maxLength={128}
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          )}
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? (
            <Spinner label="Signing in" />
          ) : (
            <>
              Continue <ArrowRight />
            </>
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}

function TotpChallenge({ email }: { email: string }) {
  const { auth, setState } = useSession();
  const { busy, error, run } = useAuthAction();
  const [code, setCode] = useState("");
  return (
    <AuthLayout
      title="One more step"
      description={`Enter the six-digit code from your authenticator app for ${email}.`}
      footer={
        <Button
          variant="ghost"
          onClick={() =>
            void run(async () => setState(await auth("/api/auth/logout", {})))
          }
          disabled={busy}
        >
          <ArrowLeft /> Back to sign in
        </Button>
      }
    >
      {error ? <Notice>{error}</Notice> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () =>
            setState(await auth("/api/auth/totp", { code })),
          );
        }}
        aria-busy={busy}
      >
        <CodeField code={code} onChange={setCode} />
        <Button type="submit" disabled={busy}>
          {busy ? (
            <Spinner label="Verifying code" />
          ) : (
            <>
              Verify and sign in <ArrowRight />
            </>
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}

function Enrollment({ state }: { state: EnrollmentState }) {
  const { auth, setState } = useSession();
  const { busy, error, run } = useAuthAction();
  const [name, setName] = useState(state.name);
  const [method, setMethod] = useState<"passkey" | "totp">("passkey");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState<TotpEnrollment | null>(null);

  const title =
    state.reason === "recovery"
      ? "Secure your account again"
      : "Welcome to Dispatch";
  const description =
    state.reason === "recovery"
      ? "Set up a new sign-in method before returning to your workspace."
      : `Set up secure access for ${state.email}.`;

  return (
    <AuthLayout
      title={totp ? "Connect your authenticator" : title}
      description={
        totp
          ? "Scan the code, then enter the six-digit code from your authenticator app."
          : description
      }
      footer={
        <p>
          {method === "passkey"
            ? "Your browser or password manager will guide you through creating and saving a passkey. Add a second passkey or an authenticator in account settings after signing in."
            : "You’ll use your password and a code from your authenticator app to sign in."}
        </p>
      }
    >
      {error ? <Notice>{error}</Notice> : null}
      {totp ? (
        <TotpForm
          enrollment={totp}
          busy={busy}
          onVerify={(code) =>
            run(async () =>
              setState(
                await auth("/api/auth/enrollment/totp/verify", { code }),
              ),
            )
          }
        />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              if (method === "passkey") {
                const { options } = await auth(
                  "/api/auth/enrollment/passkey/options",
                  { name },
                );
                const response = await startRegistration({
                  optionsJSON: options,
                });
                setState(
                  await auth("/api/auth/enrollment/passkey/verify", {
                    response,
                  }),
                );
              } else {
                setTotp(
                  await auth("/api/auth/enrollment/totp/start", {
                    name,
                    password,
                  }),
                );
                setPassword("");
              }
            });
          }}
          aria-busy={busy}
        >
          <Field label="Your name">
            {(props) => (
              <Input
                {...props}
                name="name"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={100}
              />
            )}
          </Field>
          <fieldset className="auth-methods">
            <legend>How would you like to sign in?</legend>
            <label>
              <input
                type="radio"
                name="method"
                value="passkey"
                checked={method === "passkey"}
                onChange={() => setMethod("passkey")}
              />
              <Fingerprint size={20} />
              <span>
                <strong>Use a passkey</strong>
                <small>Face, fingerprint, or device PIN</small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="method"
                value="totp"
                checked={method === "totp"}
                onChange={() => setMethod("totp")}
              />
              <KeyRound size={20} />
              <span>
                <strong>Password and authenticator</strong>
                <small>Password plus a six-digit code</small>
              </span>
            </label>
          </fieldset>
          {method === "totp" ? (
            <Field
              label="Choose a password"
              hint="Use at least 12 characters. A password manager can create and save a strong password."
            >
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  maxLength={128}
                  name="new-password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  minLength={12}
                  required
                />
              )}
            </Field>
          ) : null}
          <Button type="submit" disabled={busy}>
            {busy ? (
              <Spinner label="Setting up your account" />
            ) : (
              <>
                {method === "passkey"
                  ? "Create your passkey"
                  : "Connect authenticator"}{" "}
                <ArrowRight />
              </>
            )}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function CodeField({
  code,
  onChange,
}: {
  code: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label="Authentication code">
      {(props) => (
        <Input
          {...props}
          className="auth-code"
          name="one-time-code"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(event) =>
            onChange(event.target.value.replace(/\D/g, "").slice(0, 6))
          }
          required
          autoFocus
        />
      )}
    </Field>
  );
}

export function TotpForm({
  enrollment,
  busy,
  onVerify,
}: {
  enrollment: TotpEnrollment;
  busy: boolean;
  onVerify: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(enrollment.uri, { width: 240, margin: 2 })
      .then((value) => {
        if (active) setQr(value);
      })
      .catch(() => {
        if (active) setQr(null);
      });
    return () => {
      active = false;
    };
  }, [enrollment.uri]);
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void onVerify(code);
      }}
      aria-busy={busy}
    >
      <div className="setup-secret">
        {qr ? <img src={qr} alt="Authenticator setup QR code" /> : null}
        <p>Scan with your authenticator, or enter this setup key manually:</p>
        <code>{enrollment.secret}</code>
      </div>
      <CodeField code={code} onChange={setCode} />
      <Button type="submit" disabled={busy}>
        {busy ? (
          <Spinner label="Verifying authenticator" />
        ) : (
          <>
            <ShieldCheck /> Verify authenticator
          </>
        )}
      </Button>
    </form>
  );
}

function Recovery({ onBack }: { onBack: () => void }) {
  const { auth, setState } = useSession();
  const { busy, error, run } = useAuthAction();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  return (
    <AuthLayout
      title="Recover your access"
      description="Use your password and an unused recovery code. You’ll then set up a new sign-in method."
      footer={
        <p>
          If you use only passkeys, try a second passkey. If you cannot use a
          saved sign-in method, contact the person who manages your workspace
          for an account reset.
        </p>
      }
    >
      <Button
        className="auth-back"
        variant="ghost"
        onClick={onBack}
        disabled={busy}
      >
        <ArrowLeft /> Back to sign in
      </Button>
      {error ? <Notice>{error}</Notice> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const next = await auth("/api/auth/recovery/start", {
              email,
              password,
              code,
            });
            setPassword("");
            setCode("");
            setState(next);
          });
        }}
        aria-busy={busy}
      >
        <Field label="Email address">
          {(props) => (
            <Input
              {...props}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          )}
        </Field>
        <Field label="Password">
          {(props) => (
            <Input
              {...props}
              type="password"
              maxLength={128}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          )}
        </Field>
        <Field label="Recovery code">
          {(props) => (
            <Input
              {...props}
              autoComplete="off"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              spellCheck={false}
            />
          )}
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? (
            <Spinner label="Verifying recovery code" />
          ) : (
            "Continue to account recovery"
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}

function RecoveryCodes({
  state,
  onDone,
}: {
  state: AuthenticatedState;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  function download() {
    const text = `Dispatch recovery codes for ${state.user.email}\n\nKeep these codes somewhere private. Each code can be used once with your password.\n\n${state.recoveryCodes?.join("\n")}\n`;
    downloadBlob(new Blob([text], { type: "text/plain" }), "dispatch-recovery-codes.txt");
  }
  return (
    <AuthLayout
      title="Save your recovery codes"
      description="Keep these somewhere safe, such as your password manager. You’ll need your password and one unused code if you lose your authenticator."
      footer={
        <p>
          These codes are shown once. Replacing your authenticator generates new
          codes and invalidates the old ones.
        </p>
      }
    >
      <div className="stack">
        <ul className="recovery-codes" aria-label="One-time recovery codes">
          {state.recoveryCodes?.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <Button variant="secondary" onClick={download}>
          <Download /> Download recovery codes
        </Button>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
          />{" "}
          I have saved my recovery codes.
        </label>
        <Button disabled={!saved} onClick={onDone}>
          Continue to workspace <ArrowRight />
        </Button>
      </div>
    </AuthLayout>
  );
}
