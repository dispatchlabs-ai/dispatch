import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  session,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { draftSchema, readRequestSchema } from "../shared/contracts";
import { PreferenceStore } from "./preferences";
import { redact } from "./projection";

app.setName("Dispatch Observer");
app.setPath(
  "userData",
  process.env.DISPATCH_OBSERVER_DATA_DIR
    ? resolve(process.env.DISPATCH_OBSERVER_DATA_DIR)
    : join(app.getPath("appData"), "Dispatch Observer"),
);
let window: BrowserWindow | undefined;
let worker: UtilityProcess | undefined;
let nextId = 0;
const pending = new Map<
  number,
  {
    resolve(value: any): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function service(operation: string, payload: object = {}): Promise<any> {
  if (!worker) {
    worker = utilityProcess.fork(join(__dirname, "service.cjs"), [], {
      serviceName: "Dispatch Observer reader",
      stdio: "ignore",
    });
    worker.on("message", (message) => {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      message.error
        ? item.reject(new Error(message.error))
        : item.resolve(message.result);
    });
    worker.on("exit", () => {
      worker = undefined;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(
          new Error(
            "The reader process stopped. Reconnect to start a fresh read-only connection.",
          ),
        );
      }
      pending.clear();
    });
  }
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          "The reader operation timed out. Reconnect after checking the source.",
        ),
      );
      worker?.kill();
    }, 120_000);
    pending.set(id, { resolve, reject, timer });
    worker!.postMessage({ id, operation, ...payload });
  });
}
const index = pathToFileURL(join(__dirname, "renderer/index.html")).href;
function handle(name: string, operation: (...args: any[]) => unknown) {
  ipcMain.handle(`observer:${name}`, async (event, ...args) => {
    try {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== index
      )
        throw new Error("Untrusted viewer request");
      return { result: await operation(...args) };
    } catch (error) {
      return {
        error: redact(
          error instanceof Error
            ? error.message
            : "Observer could not complete this request",
        ),
      };
    }
  });
}
function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    title: "Dispatch Observer",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#151d1b" : "#f4f6f3",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 20 },
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = undefined;
    void service("disconnect").catch(() => {});
  });
  void window.loadURL(index);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.restore();
    window?.focus();
  });
  void app.whenReady().then(async () => {
    const preferences = new PreferenceStore();
    try {
      await preferences.load();
    } catch (error) {
      dialog.showErrorBox(
        "Connection preferences need attention",
        String(redact(error instanceof Error ? error.message : error)),
      );
      app.quit();
      return;
    }
    nativeTheme.themeSource = (await preferences.get()).theme;
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    handle("preferences", () => preferences.get());
    handle("local-work", () => service("local-work"));
    handle("choose-file", async (kind) => {
      z.enum(["sqlite", "identity", "certificate"]).parse(kind);
      const result = await dialog.showOpenDialog(window!, {
        title:
          kind === "sqlite"
            ? "Open an existing Pi Durable database"
            : kind === "identity"
              ? "Choose SSH identity file"
              : "Choose trusted CA certificate",
        properties: ["openFile"],
        ...(kind === "sqlite"
          ? {
              filters: [
                {
                  name: "SQLite databases",
                  extensions: ["sqlite", "db", "sqlite3"],
                },
                { name: "All files", extensions: ["*"] },
              ],
            }
          : {}),
      });
      return result.canceled ? null : result.filePaths[0];
    });
    handle("probe", async (input) => {
      const draft = draftSchema.parse(input);
      return service("probe", {
        connection: draft.connection,
        password:
          draft.password ?? (await preferences.password(draft.connection.id)),
      });
    });
    handle("save", (input) => preferences.save(draftSchema.parse(input)));
    handle("remove", async (input) => {
      const id = z.string().uuid().parse(input);
      if ((await preferences.get()).lastConnection === id)
        await service("disconnect");
      await preferences.remove(id);
    });
    handle("connect", async (input) => {
      const id = z.string().uuid().parse(input);
      const result = await service("connect", {
        connection: preferences.find(id),
        password: await preferences.password(id),
      });
      await preferences.select(id);
      return result;
    });
    handle("disconnect", () => service("disconnect"));
    handle("read", (request) =>
      service("read", { request: readRequestSchema.parse(request) }),
    );
    handle("theme", async (value) => {
      const theme = z.enum(["system", "light", "dark"]).parse(value);
      await preferences.theme(theme);
      nativeTheme.themeSource = theme;
    });
    handle("external", async (value) => {
      const url = new URL(z.string().max(8192).parse(value));
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Only ordinary HTTP(S) links can be opened externally");
      const choice = await dialog.showMessageBox(window!, {
        type: "question",
        title: "Open recorded link?",
        message: "Open this link in your default browser?",
        detail: url.href,
        buttons: ["Cancel", "Open link"],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice.response === 1) await shell.openExternal(url.href);
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === "darwin"
          ? [{ role: "appMenu" as const }]
          : []),
        { role: "fileMenu" },
        { role: "editMenu" },
        {
          label: "View",
          submenu: [
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
            ...(!app.isPackaged ? [{ role: "toggleDevTools" as const }] : []),
          ],
        },
        { role: "windowMenu" },
      ]),
    );
    createWindow();
    app.on("activate", () => {
      if (!window) createWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting || !worker) return;
    event.preventDefault();
    quitting = true;
    const timer = setTimeout(() => {
      worker?.kill();
      app.quit();
    }, 5000);
    void service("disconnect").finally(() => {
      clearTimeout(timer);
      worker?.kill();
      app.quit();
    });
  });
}
