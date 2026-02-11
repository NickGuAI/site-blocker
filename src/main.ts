import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import {
  loadConfig,
  addDomains,
  removeDomains,
  isActive,
  writeHostsWithPrivilege,
} from "./site-blocker";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 720,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#FAF8F5",
    resizable: true,
    minWidth: 400,
    minHeight: 500,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "assets", "index.html"));

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// --- IPC Handlers ---

ipcMain.handle("get-domains", () => {
  return loadConfig().domains;
});

ipcMain.handle("add-domain", (_event, domain: string) => {
  const added = addDomains([domain]);

  // Auto-sync hosts if blocking is active
  if (added.length > 0) {
    try {
      if (isActive()) {
        writeHostsWithPrivilege(loadConfig().domains);
      }
    } catch {
      // User cancelled auth dialog — domain still saved to config
    }
  }

  return added;
});

ipcMain.handle("remove-domain", (_event, domain: string) => {
  const removed = removeDomains([domain]);

  // Auto-sync hosts if blocking is active
  if (removed.length > 0) {
    try {
      if (isActive()) {
        writeHostsWithPrivilege(loadConfig().domains);
      }
    } catch {
      // User cancelled auth dialog — domain still removed from config
    }
  }

  return removed;
});

ipcMain.handle("get-status", () => {
  try {
    return isActive();
  } catch {
    return false;
  }
});

ipcMain.handle("enable-blocking", () => {
  const config = loadConfig();
  if (config.domains.length === 0) {
    throw new Error("No domains to block. Add some first.");
  }
  writeHostsWithPrivilege(config.domains);
});

ipcMain.handle("disable-blocking", () => {
  writeHostsWithPrivilege([]);
});

// --- App lifecycle ---

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
