import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import {
  loadConfig,
  addDomains,
  removeDomains,
  isActive,
  writeHostsWithPrivilege,
  readAccessLog,
  isLoggerRunning,
  ensureLoggerRunning,
} from "./site-blocker";

const log = (...args: unknown[]) =>
  console.log("[site-blocker]", ...args);

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
  const domains = loadConfig().domains;
  log("get-domains:", domains);
  return domains;
});

ipcMain.handle("add-domain", (_event, domain: string) => {
  log("add-domain:", domain);
  const added = addDomains([domain]);
  log("add-domain added:", added);

  // Auto-sync hosts if blocking is active
  if (added.length > 0) {
    try {
      if (isActive()) {
        log("add-domain: blocking active, syncing hosts");
        writeHostsWithPrivilege(loadConfig().domains);
      }
    } catch (err) {
      log("add-domain: hosts sync failed:", err);
    }
  }

  return added;
});

ipcMain.handle("remove-domain", (_event, domain: string) => {
  log("remove-domain:", domain);
  const removed = removeDomains([domain]);
  log("remove-domain removed:", removed);

  // Auto-sync hosts if blocking is active
  if (removed.length > 0) {
    try {
      if (isActive()) {
        log("remove-domain: blocking active, syncing hosts");
        writeHostsWithPrivilege(loadConfig().domains);
      }
    } catch (err) {
      log("remove-domain: hosts sync failed:", err);
    }
  }

  return removed;
});

ipcMain.handle("get-status", () => {
  try {
    const active = isActive();
    log("get-status:", active);
    return active;
  } catch {
    return false;
  }
});

ipcMain.handle("enable-blocking", () => {
  const config = loadConfig();
  log("enable-blocking: domains =", config.domains);
  if (config.domains.length === 0) {
    throw new Error("No domains to block. Add some first.");
  }
  writeHostsWithPrivilege(config.domains);
  log("enable-blocking: done");
});

ipcMain.handle("disable-blocking", () => {
  log("disable-blocking");
  writeHostsWithPrivilege([]);
  log("disable-blocking: done");
});

ipcMain.handle("get-access-log", (_event, days?: number) => {
  const entries = readAccessLog(days);
  log("get-access-log: days =", days, "entries =", entries.length);
  if (entries.length > 0) {
    log("get-access-log: last 3 =", entries.slice(-3));
  }
  return entries;
});

// --- App lifecycle ---

app.whenReady().then(() => {
  log("app ready");
  createWindow();

  const active = isActive();
  const loggerRunning = isLoggerRunning();
  log("startup: blocking active =", active, "logger running =", loggerRunning);

  if (active && !loggerRunning) {
    log("startup: logger not running, attempting start...");
    try {
      ensureLoggerRunning();
      log("startup: ensureLoggerRunning returned, running =", isLoggerRunning());
    } catch (err) {
      log("startup: logger start failed:", err);
    }
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
