/**
 * Site Blocker core logic — ported from site_blocker.py.
 * All pure functions except writeHostsWithPrivilege and flushDns.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

const log = (...args: unknown[]) =>
  console.log("[site-blocker]", ...args);

const HOSTS_PATH = "/etc/hosts";
const MARKER_BEGIN = "# BEGIN SITE-BLOCKER";
const MARKER_END = "# END SITE-BLOCKER";

// Access logger daemon script — resolve for both dev and packaged app.
// Returns a path in /tmp (copied there to avoid macOS TCC restrictions
// when osascript runs the script with admin privileges).
function getLoggerScript(): string | null {
  // Packaged app: <app>/Contents/Resources/access_logger.py
  const packaged = path.join(process.resourcesPath || "", "access_logger.py");
  // Dev mode: two levels up from electron/dist/
  const dev = path.join(__dirname, "..", "..", "access_logger.py");

  const source = fs.existsSync(packaged)
    ? packaged
    : fs.existsSync(dev)
      ? dev
      : null;

  if (!source) {
    log("getLoggerScript: not found (tried", packaged, dev, ")");
    return null;
  }

  // Copy to /tmp so osascript elevated process can read it (Desktop is TCC-protected)
  const dest = "/tmp/site-blocker-access-logger.py";
  fs.copyFileSync(source, dest);
  log("getLoggerScript:", source, "->", dest);
  return dest;
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

function getRealUser(): string {
  if (process.env.SUDO_USER) return process.env.SUDO_USER;
  if (process.env.USER) return process.env.USER;
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
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
  log("writeHostsWithPrivilege: domains =", domains.length);
  const original = fs.readFileSync(HOSTS_PATH, "utf-8");

  // Safety: verify localhost entry
  if (!original.includes("127.0.0.1") || !original.includes("localhost")) {
    throw new Error("/etc/hosts missing 127.0.0.1 localhost — aborting");
  }

  const newContent = buildHostsContent(original, domains);

  // Write to temp file (unprivileged)
  const tmpFile = path.join(os.tmpdir(), `site-blocker-hosts-${Date.now()}`);
  fs.writeFileSync(tmpFile, newContent);

  // Use osascript for admin privilege — user sees native macOS auth dialog
  const steps = [
    `cp /etc/hosts /etc/hosts.site-blocker.bak`,
    `cp ${tmpFile} /etc/hosts`,
    `chmod 644 /etc/hosts`,
    `dscacheutil -flushcache`,
    `killall -HUP mDNSResponder 2>/dev/null || true`,
  ];

  // Start/stop access logger daemon alongside hosts changes
  // Paths need \" quoting for spaces (e.g. "Site Blocker.app" in packaged path)
  const loggerScript = getLoggerScript();
  log("writeHostsWithPrivilege: loggerScript =", loggerScript);
  if (domains.length > 0 && loggerScript) {
    // Set SUDO_USER so the daemon writes logs to the real user's home
    const user = getRealUser();
    const loggerCmd = `SUDO_USER=${user} /usr/bin/python3 \\"${loggerScript}\\" start || true`;
    log("writeHostsWithPrivilege: will start logger:", loggerCmd);
    steps.push(loggerCmd);
  } else if (domains.length === 0 && loggerScript) {
    steps.unshift(`/usr/bin/python3 \\"${loggerScript}\\" stop || true`);
  }

  const script = steps.join(" && ");
  log("writeHostsWithPrivilege: osascript cmd =", script);

  try {
    const result = execSync(
      `osascript -e 'do shell script "${script}" with administrator privileges'`,
      { stdio: "pipe" }
    );
    log("writeHostsWithPrivilege: osascript stdout =", result.toString());
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer };
    log("writeHostsWithPrivilege: osascript FAILED:", e.stderr?.toString());
    throw err;
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

// --- Access logger daemon lifecycle ---

const PID_FILE = "/tmp/site-blocker-logger.pid";
const ACCESS_LOG_JSONL = "access_log.jsonl";
const ACCESS_LOG_JSON = "access_log.json";

export function isPidRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // throws if process doesn't exist
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // Root-owned process can be alive but inaccessible from unprivileged app.
    return code === "EPERM";
  }
}

export function isLoggerRunning(): boolean {
  if (!fs.existsSync(PID_FILE)) {
    log("isLoggerRunning: no pid file");
    return false;
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    log("isLoggerRunning: invalid pid file");
    return false;
  }

  if (isPidRunning(pid)) {
    log("isLoggerRunning: yes, pid =", pid);
    return true;
  }
  log("isLoggerRunning: pid file exists but process dead");
  return false;
}

export function ensureLoggerRunning(): void {
  if (isLoggerRunning()) {
    log("ensureLoggerRunning: already running");
    return;
  }
  const loggerScript = getLoggerScript();
  if (!loggerScript) {
    log("ensureLoggerRunning: no logger script found");
    return;
  }

  const user = getRealUser();
  const cmd = `SUDO_USER=${user} /usr/bin/python3 \\"${loggerScript}\\" start`;
  log("ensureLoggerRunning: cmd =", cmd);
  try {
    const result = execSync(
      `osascript -e 'do shell script "${cmd}" with administrator privileges'`,
      { stdio: "pipe" }
    );
    log("ensureLoggerRunning: stdout =", result.toString());
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer };
    log("ensureLoggerRunning: FAILED:", e.stderr?.toString());
  }
}

// --- Access log ---

function isAccessLogEntry(entry: unknown): entry is AccessLogEntry {
  if (!entry || typeof entry !== "object") return false;
  const value = entry as Record<string, unknown>;
  return typeof value.domain === "string" && typeof value.ts === "string";
}

function parseJsonlAccessLog(logPath: string): AccessLogEntry[] {
  const raw = fs.readFileSync(logPath, "utf-8");
  log("readAccessLog: jsonl file =", logPath, "size =", raw.length, "bytes");
  if (!raw.trim()) return [];
  const lines = raw.trim().split("\n");
  log("readAccessLog: jsonl lines =", lines.length);
  return lines
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(isAccessLogEntry);
}

function parseLegacyJsonAccessLog(logPath: string): AccessLogEntry[] {
  const raw = fs.readFileSync(logPath, "utf-8");
  log("readAccessLog: legacy file =", logPath, "size =", raw.length, "bytes");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isAccessLogEntry);
}

export function readAccessLog(days?: number): AccessLogEntry[] {
  const configDir = getConfigDir();
  const logPathJsonl = path.join(configDir, ACCESS_LOG_JSONL);
  const logPathJson = path.join(configDir, ACCESS_LOG_JSON);
  const hasJsonl = fs.existsSync(logPathJsonl);
  const hasJson = fs.existsSync(logPathJson);
  log(
    "readAccessLog: paths =",
    logPathJsonl,
    hasJsonl,
    logPathJson,
    hasJson
  );
  if (!hasJsonl && !hasJson) return [];

  let entries: AccessLogEntry[] = [];
  try {
    if (hasJsonl) {
      entries = entries.concat(parseJsonlAccessLog(logPathJsonl));
    }
    if (hasJson) {
      entries = entries.concat(parseLegacyJsonAccessLog(logPathJson));
    }
    entries.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  } catch (err) {
    log("readAccessLog: parse error:", err);
    return [];
  }

  if (days !== undefined) {
    const cutoff = Date.now() - days * 86400 * 1000;
    const before = entries.length;
    entries = entries.filter((e) => new Date(e.ts).getTime() >= cutoff);
    log("readAccessLog: filtered", before, "->", entries.length, "for", days, "days");
  }

  return entries;
}
