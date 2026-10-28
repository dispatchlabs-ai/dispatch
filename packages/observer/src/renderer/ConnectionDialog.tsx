import { useRef, useState } from "react";
import {
  Database,
  FolderOpen,
  Globe,
  KeyRound,
  Laptop,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { UI } from "./controls";
import {
  connectionSchema,
  type Connection,
  type Preferences,
  type SavedConnection,
} from "../shared/contracts";

function fresh(): Connection {
  return {
    id: crypto.randomUUID(),
    name: "",
    kind: "sqlite",
    path: "",
    transport: { kind: "direct" },
    postgres: {
      host: "localhost",
      port: 5432,
      database: "postgres",
      user: "observer",
      storeId: "",
      tls: "verify",
      caFile: "",
    },
  };
}
export function ConnectionDialog({
  existing,
  preferences,
  onClose,
  onSaved,
}: {
  existing?: SavedConnection;
  preferences: Preferences;
  onClose(): void;
  onSaved(id: string): Promise<void>;
}) {
  const [value, setValue] = useState<Connection>(existing ?? fresh);
  const [password, setPassword] = useState<string | undefined>();
  const [remember, setRemember] = useState(
    existing?.secretSaved ?? preferences.secureStorage,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<{ stores: string[]; message: string }>();
  const feedback = useRef<HTMLDivElement>(null);
  const revealFeedback = () =>
    requestAnimationFrame(() =>
      feedback.current?.scrollIntoView({ block: "nearest" }),
    );
  const update = (patch: Partial<Connection>) => {
    setValue((previous) => ({ ...previous, ...patch }));
    setProbe(undefined);
    setError("");
  };
  const pg = (patch: Partial<Connection["postgres"]>) =>
    update({ postgres: { ...value.postgres, ...patch } });
  const transport = (kind: Connection["transport"]["kind"]) =>
    update({
      transport:
        kind === "direct"
          ? { kind }
          : kind === "ssh"
            ? {
                kind,
                host: "",
                user: "",
                identityFile: "",
                node: "node",
              }
            : {
                kind,
                instance: "",
                region: "us-east-1",
                profile: "",
                node: "node",
              },
    });
  const field = (
    label: string,
    input: string | number,
    change: (value: string) => void,
    options: { type?: string; hint?: string; placeholder?: string } = {},
  ) => (
    <UI.Field label={label} hint={options.hint}>
      {(props) => (
        <UI.Input
          {...props}
          type={options.type ?? "text"}
          value={input}
          placeholder={options.placeholder}
          autoComplete="off"
          onChange={(event) => change(event.target.value)}
        />
      )}
    </UI.Field>
  );
  const pick = async (
    kind: "sqlite" | "identity" | "certificate",
    apply: (path: string) => void,
  ) => {
    try {
      const path = await window.observer.chooseFile(kind);
      if (path) apply(path);
    } catch (error) {
      setError(String(error));
      revealFeedback();
    }
  };
  const run = async (save: boolean) => {
    setError("");
    const parsed = connectionSchema.safeParse(value);
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((issue) => `${issue.path.join(" · ")}: ${issue.message}`)
          .join(". "),
      );
      revealFeedback();
      return;
    }
    setBusy(true);
    try {
      const result = await window.observer.probe({
        connection: parsed.data,
        password,
        rememberSecret: remember,
      });
      setProbe(result);
      const storeId = value.postgres.storeId || result.stores[0] || "";
      const connection = {
        ...parsed.data,
        postgres: { ...parsed.data.postgres, storeId },
      };
      setValue(connection);
      if (save) {
        if (connection.kind === "postgres" && !storeId)
          throw new Error(
            "This identity cannot see any logical stores. Check its read permissions.",
          );
        const saved = await window.observer.save({
          connection,
          password,
          rememberSecret: remember,
        });
        await onSaved(saved.id);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      revealFeedback();
    }
  };
  return (
    <UI.Dialog
      open
      title={existing ? "Edit connection" : "Add a connection"}
      description="Settings → Connections"
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <form
        className="connection-form observer-connection-form"
        data-transport={value.transport.kind}
        onSubmit={(event) => {
          event.preventDefault();
          void run(true);
        }}
      >
        <div className="connection-form-body">
          <div className="segmented" aria-label="Database type">
            <UI.Button
              variant={value.kind === "sqlite" ? "secondary" : "ghost"}
              onClick={() => update({ kind: "sqlite" })}
            >
              <Laptop />
              SQLite
            </UI.Button>
            <UI.Button
              variant={value.kind === "postgres" ? "secondary" : "ghost"}
              onClick={() => update({ kind: "postgres" })}
            >
              <Database />
              Postgres
            </UI.Button>
          </div>
          {field("Connection name", value.name, (name) => update({ name }), {
            placeholder: "Workspace",
          })}
          <UI.Field label="Connect through">
            {(props) => (
              <select
                {...props}
                value={value.transport.kind}
                onChange={(event) =>
                  transport(
                    event.target.value as Connection["transport"]["kind"],
                  )
                }
              >
                <option value="direct">
                  {value.kind === "sqlite"
                    ? "This computer"
                    : "Direct connection"}
                </option>
                <option value="ssh">SSH</option>
                <option value="ssm">AWS Session Manager</option>
              </select>
            )}
          </UI.Field>
          {value.transport.kind === "ssh" && (
            <fieldset className="form-group">
              <legend>
                <Terminal /> SSH connection
              </legend>
              {field(
                "SSH host or config alias",
                value.transport.host,
                (host) =>
                  value.transport.kind === "ssh" &&
                  update({ transport: { ...value.transport, host } }),
                { placeholder: "agent.example.com" },
              )}
              <div className="form-row">
                {field(
                  "SSH user (optional)",
                  value.transport.user,
                  (user) =>
                    value.transport.kind === "ssh" &&
                    update({ transport: { ...value.transport, user } }),
                )}
                {field(
                  "SSH port (optional)",
                  value.transport.port ?? "",
                  (port) =>
                    value.transport.kind === "ssh" &&
                    update({
                      transport: {
                        ...value.transport,
                        port: port ? Number(port) : undefined,
                      },
                    }),
                  { type: "number", placeholder: "From SSH config" },
                )}
              </div>
              <div className="file-field">
                {field(
                  "Identity file (optional)",
                  value.transport.identityFile,
                  (identityFile) =>
                    value.transport.kind === "ssh" &&
                    update({
                      transport: { ...value.transport, identityFile },
                    }),
                )}
                <UI.Button
                  variant="outline"
                  aria-label="Choose SSH identity file"
                  onClick={() =>
                    void pick(
                      "identity",
                      (identityFile) =>
                        value.transport.kind === "ssh" &&
                        update({
                          transport: { ...value.transport, identityFile },
                        }),
                    )
                  }
                >
                  <FolderOpen />
                </UI.Button>
              </div>
              <p className="hint">
                Uses your SSH agent and configuration. The host must already
                be trusted in known_hosts.
              </p>
            </fieldset>
          )}
          {value.transport.kind === "ssm" && (
            <fieldset className="form-group">
              <legend>
                <Globe /> AWS Session Manager
              </legend>
              {field(
                "Instance ID",
                value.transport.instance,
                (instance) =>
                  value.transport.kind === "ssm" &&
                  update({ transport: { ...value.transport, instance } }),
                { placeholder: "i-0123456789abcdef0" },
              )}
              <div className="form-row">
                {field(
                  "Region",
                  value.transport.region,
                  (region) =>
                    value.transport.kind === "ssm" &&
                    update({ transport: { ...value.transport, region } }),
                )}
                {field(
                  "AWS profile (optional)",
                  value.transport.profile,
                  (profile) =>
                    value.transport.kind === "ssm" &&
                    update({ transport: { ...value.transport, profile } }),
                )}
              </div>
              <p className="hint">
                Requires AWS CLI and the Session Manager plugin, using your
                existing AWS sign-in.
              </p>
            </fieldset>
          )}
          {value.kind === "sqlite" ? (
            <fieldset className="form-group connection-database">
              <legend>
                <Database /> SQLite database
              </legend>
              <div className="file-field">
                {field(
                  value.transport.kind === "direct"
                    ? "Database file"
                    : "Database path on remote host",
                  value.path,
                  (path) => update({ path }),
                  {
                    placeholder:
                      value.transport.kind === "direct"
                        ? "Choose an existing .sqlite file"
                        : "/var/lib/agent/session.sqlite",
                  },
                )}
                {value.transport.kind === "direct" && (
                  <UI.Button
                    variant="outline"
                    aria-label="Choose SQLite database"
                    onClick={() =>
                      void pick("sqlite", (path) =>
                        update({
                          path,
                          ...(!value.name
                            ? {
                                name:
                                  path.split(/[\\/]/).slice(-2, -1)[0] ||
                                  "Local agent",
                              }
                            : {}),
                        }),
                      )
                    }
                  >
                    <FolderOpen />
                  </UI.Button>
                )}
              </div>
              {value.transport.kind !== "direct" && (
                <>
                  {field(
                    "Remote Node executable",
                    value.transport.node,
                    (node) =>
                      value.transport.kind !== "direct" &&
                      update({ transport: { ...value.transport, node } }),
                    {
                      hint: "Node.js 22.13+ must already be installed on the remote host.",
                    },
                  )}
                  <p className="notice">
                    <ShieldCheck />
                    Connecting starts a temporary read-only reader beside this
                    database. It closes with the connection; an SSM reader
                    also expires after two idle minutes.
                  </p>
                </>
              )}
            </fieldset>
          ) : (
            <fieldset className="form-group connection-database">
              <legend>
                <Database /> Database
              </legend>
              <div className="form-row wide-first">
                {field("Database host", value.postgres.host, (host) =>
                  pg({ host }),
                )}
                {field(
                  "Port",
                  value.postgres.port,
                  (port) => pg({ port: Number(port) }),
                  { type: "number" },
                )}
              </div>
              {field("Database name", value.postgres.database, (database) =>
                pg({ database }),
              )}
              {field(
                "Database user",
                value.postgres.user,
                (user) => pg({ user }),
                {
                  hint: "A read-only identity scoped to the intended stores is recommended.",
                },
              )}
              {field("Password", password ?? "", setPassword, {
                type: "password",
                placeholder: existing?.hasSecret
                  ? "Saved password · leave blank to keep"
                  : "Database password",
              })}
              <label className="check-label">
                <UI.Checkbox
                  checked={remember}
                  onCheckedChange={setRemember}
                  disabled={!preferences.secureStorage}
                />
                <KeyRound size={14} />
                Save password in protected OS storage
              </label>
              {!preferences.secureStorage && (
                <p className="notice">
                  Protected storage is unavailable. A password is kept only
                  until this app exits.
                </p>
              )}
              <UI.Field label="Transport encryption">
                {(props) => (
                  <select
                    {...props}
                    value={value.postgres.tls}
                    onChange={(event) =>
                      pg({ tls: event.target.value as "verify" | "disable" })
                    }
                  >
                    <option value="verify">
                      TLS · verify server identity
                    </option>
                    <option value="disable">No database TLS</option>
                  </select>
                )}
              </UI.Field>
              {value.postgres.tls === "verify" ? (
                <div className="file-field">
                  {field(
                    "CA certificate (optional)",
                    value.postgres.caFile,
                    (caFile) => pg({ caFile }),
                  )}
                  <UI.Button
                    variant="outline"
                    aria-label="Choose CA certificate"
                    onClick={() =>
                      void pick("certificate", (caFile) => pg({ caFile }))
                    }
                  >
                    <FolderOpen />
                  </UI.Button>
                </div>
              ) : (
                <p className="notice">
                  Database traffic uses no TLS. Use this only for a trusted
                  local database or an appropriately secured tunnel.
                </p>
              )}
              {probe?.stores.length ? (
                <UI.Field label="Logical store">
                  {(props) => (
                    <select
                      {...props}
                      value={value.postgres.storeId}
                      onChange={(event) =>
                        setValue((previous) => ({
                          ...previous,
                          postgres: {
                            ...previous.postgres,
                            storeId: event.target.value,
                          },
                        }))
                      }
                    >
                      {probe.stores.map((store) => (
                        <option key={store}>{store}</option>
                      ))}
                    </select>
                  )}
                </UI.Field>
              ) : (
                field(
                  "Logical store",
                  value.postgres.storeId,
                  (storeId) => pg({ storeId }),
                  {
                    hint: "Test the connection to discover accessible stores.",
                  },
                )
              )}
            </fieldset>
          )}
          <div className="connection-feedback" ref={feedback}>
            <p className="hint">
              <ShieldCheck size={14} />
              Existing records only. No agent is started or resumed.
            </p>
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            {probe && (
              <p className="success-message" role="status">
                {probe.message}
              </p>
            )}
          </div>
        </div>
        <div className="dialog-actions">
          <UI.Button
            type="button"
            variant="ghost"
            className="connection-cancel"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </UI.Button>
          <UI.Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void run(false)}
          >
            {busy ? <UI.Spinner /> : null}Test connection
          </UI.Button>
          <UI.Button type="submit" disabled={busy}>
            {busy ? "Connecting…" : "Save & connect"}
          </UI.Button>
        </div>
      </form>
    </UI.Dialog>
  );
}
