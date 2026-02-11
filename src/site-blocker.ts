/**
 * Site Blocker core logic — ported from site_blocker.py.
 * All pure functions except writeHostsWithPrivilege and flushDns.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const HOSTS_PATH = "/etc/hosts";
const MARKER_BEGIN = "# BEGIN SITE-BLOCKER";
const MARKER_END = "# END SITE-BLOCKER";

// Access logger daemon script — resolve for both dev and packaged app
function getLoggerScript(): string | null {
  // Packaged app: <app>/Contents/Resources/access_logger.py
  const packaged = path.join(process.resourcesPath || "", "access_logger.py");
  if (fs.existsSync(packaged)) return packaged;

  // Dev mode: two levels up from electron/dist/
  const dev = path.join(__dirname, "..", "..", "access_logger.py");
  if (fs.existsSync(dev)) return dev;

  return null;
}

// Config stored in ~/Library/Application Support/SiteBlocker/blocked.json
function getConfigDir(): string {
  const dir = path.join(
    process.env.HOME || "/tmp",
    "Library",
    "Application Support",
    "SiteBlocker"
  );
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getConfigPath(): string {
  return path.join(getConfigDir(), "blocked.json");
}

// --- Domain normalization ---

export function normalizeDomain(raw: string): string {
  let d = raw.trim();
  if (!d) throw new Error("Domain cannot be empty");

  // Strip protocol
  d = d.replace(/^https?:\/\//, "");
  // Strip www.
  d = d.replace(/^www\./, "");
  // Strip path and trailing slash
  d = d.split("/")[0];
  // Lowercase
  d = d.toLowerCase().trim();

  if (!d.includes(".")) throw new Error(`Invalid domain: ${d}`);

  return d;
}

// --- Config ---

export interface SiteBlockerConfig {
  domains: string[];
}

export function loadConfig(
  configPath: string = getConfigPath()
): SiteBlockerConfig {
  if (!fs.existsSync(configPath)) {
    const defaultConfig: SiteBlockerConfig = { domains: [] };
    saveConfig(defaultConfig, configPath);
    return defaultConfig;
  }
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

export function saveConfig(
  config: SiteBlockerConfig,
  configPath: string = getConfigPath()
): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

// --- CRUD ---

export function addDomains(
  domains: string[],
  configPath: string = getConfigPath()
): string[] {
  const config = loadConfig(configPath);
  const added: string[] = [];
  for (const raw of domains) {
    const d = normalizeDomain(raw);
    if (!config.domains.includes(d)) {
      config.domains.push(d);
      added.push(d);
    }
  }
  if (added.length > 0) {
    saveConfig(config, configPath);
  }
  return added;
}

export function removeDomains(
  domains: string[],
  configPath: string = getConfigPath()
): string[] {
  const config = loadConfig(configPath);
  const removed: string[] = [];
  for (const raw of domains) {
    const d = normalizeDomain(raw);
    const idx = config.domains.indexOf(d);
    if (idx !== -1) {
      config.domains.splice(idx, 1);
      removed.push(d);
    }
  }
  if (removed.length > 0) {
    saveConfig(config, configPath);
  }
  return removed;
}

// --- Hosts file ---

export function isActiveInContent(content: string): boolean {
  return content.includes(MARKER_BEGIN) && content.includes(MARKER_END);
}

export function isActive(): boolean {
  const content = fs.readFileSync(HOSTS_PATH, "utf-8");
  return isActiveInContent(content);
}

export function parseHostsRemoveBlock(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    if (line.trim() === MARKER_BEGIN) {
      inBlock = true;
      continue;
    }
    if (line.trim() === MARKER_END) {
      inBlock = false;
      continue;
    }
    if (!inBlock) {
      result.push(line);
    }
  }

  // Remove trailing blank lines left by block removal
  while (result.length > 0 && result[result.length - 1].trim() === "") {
    result.pop();
  }

  return result.join("\n") + "\n";
}

export function buildHostsContent(
  original: string,
  domains: string[]
): string {
  // Remove existing block first
  const base = parseHostsRemoveBlock(original);

  if (domains.length === 0) return base;

  const sorted = [...domains].sort();
  const blockLines = [MARKER_BEGIN];
  for (const d of sorted) {
    blockLines.push(`127.0.0.1 ${d}`);
    if (!d.startsWith("www.")) {
      blockLines.push(`127.0.0.1 www.${d}`);
    }
  }
  blockLines.push(MARKER_END);

  return base.trimEnd() + "\n\n" + blockLines.join("\n") + "\n";
}

// --- Privilege escalation via osascript ---

export function writeHostsWithPrivilege(domains: string[]): void {
  const original = fs.readFileSync(HOSTS_PATH, "utf-8");

  // Safety: verify localhost entry
  if (!original.includes("127.0.0.1") || !original.includes("localhost")) {
    throw new Error("/etc/hosts missing 127.0.0.1 localhost — aborting");
  }

  const newContent = buildHostsContent(original, domains);

  // Write to temp file (unprivileged)
  const tmpFile = path.join(
    require("os").tmpdir(),
    `site-blocker-hosts-${Date.now()}`
  );
  fs.writeFileSync(tmpFile, newContent);

  // Use osascript for admin privilege — user sees native macOS auth dialog
  const steps = [
    `cp /etc/hosts /etc/hosts.site-blocker.bak`,
    `cp ${tmpFile} /etc/hosts`,
    `chmod 644 /etc/hosts`,
    `dscacheutil -flushcache`,
    `killall -HUP mDNSResponder`,
  ];

  // Start/stop access logger daemon alongside hosts changes
  // Paths need \" quoting for spaces (e.g. "Site Blocker.app" in packaged path)
  const loggerScript = getLoggerScript();
  if (domains.length > 0 && loggerScript) {
    // Set SUDO_USER so the daemon writes logs to the real user's home
    const user = process.env.USER || "";
    steps.push(
      `SUDO_USER=${user} /usr/bin/python3 \\"${loggerScript}\\" start`
    );
  } else if (domains.length === 0 && loggerScript) {
    steps.unshift(`/usr/bin/python3 \\"${loggerScript}\\" stop || true`);
  }

  const script = steps.join(" && ");

  try {
    execSync(
      `osascript -e 'do shell script "${script}" with administrator privileges'`,
      { stdio: "pipe" }
    );
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

export function flushDns(): void {
  execSync(
    `osascript -e 'do shell script "dscacheutil -flushcache && killall -HUP mDNSResponder" with administrator privileges'`,
    { stdio: "pipe" }
  );
}

// --- Access log ---

export interface AccessLogEntry {
  domain: string;
  ts: string;
}

export function readAccessLog(days?: number): AccessLogEntry[] {
  const logPath = path.join(getConfigDir(), "access_log.json");
  if (!fs.existsSync(logPath)) return [];

  let entries: AccessLogEntry[];
  try {
    entries = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  } catch {
    return [];
  }

  if (days !== undefined) {
    const cutoff = Date.now() - days * 86400 * 1000;
    entries = entries.filter((e) => new Date(e.ts).getTime() >= cutoff);
  }

  return entries;
}
