import { contextBridge, ipcRenderer } from "electron";
import type { ObserverApi } from "../shared/contracts";

const invoke = async (operation: string, ...args: unknown[]) => {
  const reply = await ipcRenderer.invoke(`observer:${operation}`, ...args);
  if (reply.error) throw new Error(reply.error);
  return reply.result;
};
const api: ObserverApi = {
  localWork: () => invoke("local-work"),
  preferences: () => invoke("preferences"),
  chooseFile: (kind) => invoke("choose-file", kind),
  probe: (draft) => invoke("probe", draft),
  save: (draft) => invoke("save", draft),
  remove: (id) => invoke("remove", id),
  connect: (id) => invoke("connect", id),
  disconnect: () => invoke("disconnect"),
  read: (request) => invoke("read", request),
  theme: (value) => invoke("theme", value),
  external: (url) => invoke("external", url),
};
contextBridge.exposeInMainWorld("observer", Object.freeze(api));
