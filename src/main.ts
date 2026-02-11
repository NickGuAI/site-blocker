import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import {
  loadConfig,
  setEnabled,
  addDomains,
  removeDomains,
  isActive,
  needsHostsSync,
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
      const config = loadConfig();
      if (config.enabled === true) {
        log("add-domain: blocking enabled, syncing hosts");
        writeHostsWithPrivilege(config.domains);
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
      const config = loadConfig();
      if (config.enabled === true) {
        log("remove-domain: blocking enabled, syncing hosts");
        writeHostsWithPrivilege(config.domains);
      }
    } catch (err) {
      log("remove-domain: hosts sync failed:", err);
    }
  }

  return removed;
});

ipcMain.handle("get-status", () => {
  try {
    const config = loadConfig();
    const active = isActive();
    const status = config.enabled === true && active;
    log("get-status:", status, "(enabled =", config.enabled, "active =", active, ")");
    return status;
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
  setEnabled(true);
  log("enable-blocking: done");
});

ipcMain.handle("disable-blocking", () => {
  log("disable-blocking");
  writeHostsWithPrivilege([]);
  setEnabled(false);
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
  let config = loadConfig();
  const active = isActive();
  if (config.enabled !== true && active && config.domains.length > 0) {
    // Backward-compat migration: old config had no explicit enabled flag.
    setEnabled(true);
    config = loadConfig();
    log("startup: migrated enabled flag from active hosts state");
  }

  createWindow();

  const shouldBeEnabled = config.enabled === true && config.domains.length > 0;
  let loggerRunning = isLoggerRunning();
  log(
    "startup: shouldBeEnabled =",
    shouldBeEnabled,
    "active =",
    active,
    "logger running =",
    loggerRunning
  );

  if (shouldBeEnabled) {
    try {
      const syncNeeded = !active || needsHostsSync(config.domains);
      log("startup: hosts sync needed =", syncNeeded);
      if (syncNeeded) {
        log("startup: re-syncing /etc/hosts for active blocking");
        writeHostsWithPrivilege(config.domains);
      }
    } catch (err) {
      log("startup: hosts sync check/repair failed:", err);
    }
  }

  loggerRunning = isLoggerRunning();
  if (shouldBeEnabled && !loggerRunning) {
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
