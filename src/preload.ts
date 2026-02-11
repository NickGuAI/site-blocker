import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("siteBlocker", {
  getDomains: (): Promise<string[]> => ipcRenderer.invoke("get-domains"),
  addDomain: (domain: string): Promise<string[]> =>
    ipcRenderer.invoke("add-domain", domain),
  removeDomain: (domain: string): Promise<string[]> =>
    ipcRenderer.invoke("remove-domain", domain),
  getStatus: (): Promise<boolean> => ipcRenderer.invoke("get-status"),
  enableBlocking: (): Promise<void> => ipcRenderer.invoke("enable-blocking"),
  disableBlocking: (): Promise<void> =>
    ipcRenderer.invoke("disable-blocking"),
  getAccessLog: (days?: number): Promise<{ domain: string; ts: string }[]> =>
    ipcRenderer.invoke("get-access-log", days),
});
