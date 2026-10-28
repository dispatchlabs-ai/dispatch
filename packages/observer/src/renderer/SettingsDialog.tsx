import { useState, type ReactNode } from "react";
import { Database, MoreHorizontal, Plus, Settings2 } from "lucide-react";
import type { Preferences, SavedConnection } from "../shared/contracts";
import { UI } from "./controls";
import { Badge } from "./Details";

export function SettingsDialog({
  preferences,
  loadError,
  connectionId,
  status,
  onClose,
  onAdd,
  onEdit,
  onOpen,
  onReconnect,
  onRemove,
  onTheme,
  children,
}: {
  preferences?: Preferences;
  loadError?: string;
  connectionId?: string;
  status: "idle" | "connecting" | "connected" | "disconnected";
  onClose(): void;
  onAdd(): void;
  onEdit(connection: SavedConnection): void;
  onOpen(id: string): void;
  onReconnect(id: string): void;
  onRemove(id: string): Promise<void>;
  onTheme(theme: Preferences["theme"]): Promise<void>;
  children: ReactNode;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = async (action: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || status === "connecting";
  return (
    <UI.Dialog
      open
      title="Settings"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="observer-settings">
        {preferences ? (
          <>
            <section aria-labelledby="settings-connections-heading">
              <header className="settings-section-heading">
                <div>
                  <h2 id="settings-connections-heading">Connections</h2>
                  <p>Saved sources for local and remote work.</p>
                </div>
                <UI.Button size="sm" disabled={disabled} onClick={onAdd}>
                  <Plus size={15} />
                  Add connection
                </UI.Button>
              </header>
              <ul className="settings-connections">
                {preferences.connections.map((item) => (
                  <li key={item.id} className="settings-connection">
                    <Database size={19} />
                    <div className="settings-connection-copy">
                      <strong>{item.name}</strong>
                      <small>
                        {item.kind === "postgres" ? "Postgres" : "SQLite"}
                        {" · "}
                        {item.transport.kind === "direct"
                          ? item.kind === "sqlite"
                            ? "This machine"
                            : "Direct"
                          : item.transport.kind.toUpperCase()}
                      </small>
                      <p>
                        {item.kind === "sqlite"
                          ? item.path
                          : `${item.postgres.host} · ${item.postgres.database} · ${item.postgres.storeId}`}
                      </p>
                    </div>
                    {connectionId === item.id && <Badge value={status} />}
                    <UI.Button
                      variant="outline"
                      size="sm"
                      disabled={disabled}
                      aria-label={`Open ${item.name}`}
                      onClick={() => onOpen(item.id)}
                    >
                      Open
                    </UI.Button>
                    <UI.Menu>
                      <UI.MenuTrigger
                        render={
                          <UI.Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={disabled}
                            aria-label={`Manage ${item.name}`}
                          />
                        }
                      >
                        <MoreHorizontal />
                      </UI.MenuTrigger>
                      <UI.MenuContent>
                        <UI.MenuItem onClick={() => onEdit(item)}>
                          Edit connection
                        </UI.MenuItem>
                        <UI.MenuItem onClick={() => onReconnect(item.id)}>
                          Reconnect
                        </UI.MenuItem>
                        <UI.MenuItem
                          destructive
                          onClick={() => void update(() => onRemove(item.id))}
                        >
                          Remove saved connection
                        </UI.MenuItem>
                      </UI.MenuContent>
                    </UI.Menu>
                  </li>
                ))}
              </ul>
              {!preferences.connections.length && (
                <div className="settings-empty">
                  <Settings2 size={24} />
                  <strong>No saved connections</strong>
                  <p>
                    Local agents appear on This machine. Add a source to inspect
                    other saved work.
                  </p>
                </div>
              )}
              <p className="settings-note">
                Removing a connection does not delete agent data.
              </p>
            </section>
            <section
              className="settings-appearance"
              aria-labelledby="settings-appearance-heading"
            >
              <h2 id="settings-appearance-heading">Appearance</h2>
              <UI.Field label="Color theme">
                {(props) => (
                  <select
                    {...props}
                    value={preferences.theme}
                    disabled={busy}
                    onChange={(event) =>
                      void update(() =>
                        onTheme(event.target.value as Preferences["theme"]),
                      )
                    }
                  >
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                )}
              </UI.Field>
            </section>
          </>
        ) : !loadError ? (
          <UI.Spinner label="Loading settings" />
        ) : null}
        {(error || loadError) && (
          <p className="error-message" role="alert">
            {error || loadError}
          </p>
        )}
        <div className="settings-actions">
          <UI.Button variant="outline" onClick={onClose}>
            Done
          </UI.Button>
        </div>
      </div>
      {children}
    </UI.Dialog>
  );
}
