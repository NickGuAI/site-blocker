/**
 * Tests for site-blocker.ts — ported from test_site_blocker.py.
 * All pure unit tests, no sudo/hosts modification.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  normalizeDomain,
  loadConfig,
  saveConfig,
  addDomains,
  removeDomains,
  isActiveInContent,
  buildHostsContent,
  parseHostsRemoveBlock,
  isPidRunning,
  readAccessLog,
} from "./site-blocker";

// --- Test helpers ---

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "site-blocker-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function tmpPath(name: string): string {
  return path.join(tmpDir, name);
}

// --- normalizeDomain ---

describe("normalizeDomain", () => {
  it("basic domain", () => {
    expect(normalizeDomain("facebook.com")).toBe("facebook.com");
  });

  it("strips https", () => {
    expect(normalizeDomain("https://facebook.com")).toBe("facebook.com");
  });

  it("strips http", () => {
    expect(normalizeDomain("http://facebook.com")).toBe("facebook.com");
  });

  it("strips www", () => {
    expect(normalizeDomain("www.facebook.com")).toBe("facebook.com");
  });

  it("strips trailing slash", () => {
    expect(normalizeDomain("facebook.com/")).toBe("facebook.com");
  });

  it("strips path", () => {
    expect(normalizeDomain("facebook.com/some/path")).toBe("facebook.com");
  });

  it("lowercases", () => {
    expect(normalizeDomain("Facebook.COM")).toBe("facebook.com");
  });

  it("full URL normalization", () => {
    expect(normalizeDomain("https://www.Reddit.com/r/all")).toBe("reddit.com");
  });

  it("rejects empty string", () => {
    expect(() => normalizeDomain("")).toThrow("Domain cannot be empty");
  });

  it("rejects no-dot domain", () => {
    expect(() => normalizeDomain("localhost")).toThrow("Invalid domain");
  });

  it("trims whitespace", () => {
    expect(normalizeDomain("  facebook.com  ")).toBe("facebook.com");
  });
});

// --- Config load/save ---

describe("Config", () => {
  it("loads existing config", () => {
    const p = tmpPath("blocked.json");
    fs.writeFileSync(p, JSON.stringify({ domains: ["facebook.com"] }));
    const config = loadConfig(p);
    expect(config.domains).toEqual(["facebook.com"]);
  });

  it("creates default when missing", () => {
    const p = tmpPath("blocked.json");
    const config = loadConfig(p);
    expect(config.domains).toEqual([]);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("save and reload round-trip", () => {
    const p = tmpPath("blocked.json");
    saveConfig({ domains: ["reddit.com", "twitter.com"] }, p);
    const reloaded = loadConfig(p);
    expect(reloaded.domains).toEqual(["reddit.com", "twitter.com"]);
  });
});

// --- Hosts file manipulation ---

const SAMPLE_HOSTS = `\
##
# Host Database
#
# localhost is used to configure the loopback interface
# when the system is booting.  Do not alter this file.
##
127.0.0.1\tlocalhost
255.255.255.255\tbroadcasthost
::1             localhost
`;

const SAMPLE_HOSTS_WITH_BLOCK = `\
##
# Host Database
#
# localhost is used to configure the loopback interface
# when the system is booting.  Do not alter this file.
##
127.0.0.1\tlocalhost
255.255.255.255\tbroadcasthost
::1             localhost

# BEGIN SITE-BLOCKER
127.0.0.1 facebook.com
127.0.0.1 www.facebook.com
# END SITE-BLOCKER
`;

describe("buildHostsContent", () => {
  it("adds block to clean hosts", () => {
    const result = buildHostsContent(SAMPLE_HOSTS, ["facebook.com"]);
    expect(result).toContain("# BEGIN SITE-BLOCKER");
    expect(result).toContain("127.0.0.1 facebook.com");
    expect(result).toContain("127.0.0.1 www.facebook.com");
    expect(result).toContain("# END SITE-BLOCKER");
    // Original content preserved
    expect(result).toContain("127.0.0.1\tlocalhost");
  });

  it("replaces existing block", () => {
    const result = buildHostsContent(SAMPLE_HOSTS_WITH_BLOCK, ["reddit.com"]);
    expect(result).not.toContain("facebook.com");
    expect(result).toContain("127.0.0.1 reddit.com");
    expect(result).toContain("127.0.0.1 www.reddit.com");
    // Only one block
    expect(result.split("# BEGIN SITE-BLOCKER").length - 1).toBe(1);
  });

  it("empty domains removes block", () => {
    const result = buildHostsContent(SAMPLE_HOSTS, []);
    expect(result).not.toContain("# BEGIN SITE-BLOCKER");
    expect(result.trim()).toBe(SAMPLE_HOSTS.trim());
  });

  it("multiple domains", () => {
    const domains = ["facebook.com", "reddit.com", "twitter.com"];
    const result = buildHostsContent(SAMPLE_HOSTS, domains);
    for (const d of domains) {
      expect(result).toContain(`127.0.0.1 ${d}`);
      expect(result).toContain(`127.0.0.1 www.${d}`);
    }
  });

  it("www subdomain not doubled", () => {
    const result = buildHostsContent(SAMPLE_HOSTS, ["example.com"]);
    expect(result).not.toContain("www.www.example.com");
  });
});

describe("parseHostsRemoveBlock", () => {
  it("removes block", () => {
    const result = parseHostsRemoveBlock(SAMPLE_HOSTS_WITH_BLOCK);
    expect(result).not.toContain("# BEGIN SITE-BLOCKER");
    expect(result).not.toContain("facebook.com");
    // Original content preserved
    expect(result).toContain("127.0.0.1\tlocalhost");
  });

  it("no-op on clean hosts", () => {
    const result = parseHostsRemoveBlock(SAMPLE_HOSTS);
    expect(result.trim()).toBe(SAMPLE_HOSTS.trim());
  });
});

describe("isActiveInContent", () => {
  it("detects active", () => {
    expect(isActiveInContent(SAMPLE_HOSTS_WITH_BLOCK)).toBe(true);
  });

  it("detects inactive", () => {
    expect(isActiveInContent(SAMPLE_HOSTS)).toBe(false);
  });
});

// --- CRUD ---

describe("addDomains", () => {
  it("adds new domain", () => {
    const p = tmpPath("blocked.json");
    saveConfig({ domains: [] }, p);
    const added = addDomains(["facebook.com"], p);
    expect(added).toContain("facebook.com");
    expect(loadConfig(p).domains).toContain("facebook.com");
  });

  it("skips duplicate", () => {
    const p = tmpPath("blocked.json");
    saveConfig({ domains: ["facebook.com"] }, p);
    const added = addDomains(["facebook.com"], p);
    expect(added).toEqual([]);
    expect(loadConfig(p).domains.filter((d) => d === "facebook.com")).toHaveLength(1);
  });

  it("adds multiple", () => {
    const p = tmpPath("blocked.json");
    saveConfig({ domains: [] }, p);
    const added = addDomains(["facebook.com", "reddit.com", "twitter.com"], p);
    expect(added).toHaveLength(3);
    expect(loadConfig(p).domains).toHaveLength(3);
  });
});

describe("removeDomains", () => {
  it("removes existing domain", () => {
    const p = tmpPath("blocked.json");
    saveConfig({ domains: ["facebook.com", "reddit.com"] }, p);
    const removed = removeDomains(["facebook.com"], p);
    expect(removed).toContain("facebook.com");
    const config = loadConfig(p);
    expect(config.domains).not.toContain("facebook.com");
    expect(config.domains).toContain("reddit.com");
  });

  it("no-op for nonexistent domain", () => {
    const p = tmpPath("blocked.json");
    saveConfig({ domains: ["facebook.com"] }, p);
    const removed = removeDomains(["twitter.com"], p);
    expect(removed).toEqual([]);
  });
});

describe("isPidRunning", () => {
  it("rejects invalid pid values", () => {
    expect(isPidRunning(0)).toBe(false);
    expect(isPidRunning(-10)).toBe(false);
    expect(isPidRunning(Number.NaN)).toBe(false);
  });

  it("treats EPERM as running (root-owned process)", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    expect(isPidRunning(4242)).toBe(true);
  });

  it("returns false when process is gone", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    expect(isPidRunning(4242)).toBe(false);
  });
});

describe("readAccessLog", () => {
  it("reads legacy access_log.json when jsonl is missing", () => {
    const priorHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const configDir = path.join(
      tmpDir,
      "Library",
      "Application Support",
      "SiteBlocker"
    );
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "access_log.json"),
      JSON.stringify([
        { domain: "a.com", ts: "2026-02-10T00:00:00Z" },
        { domain: "b.com", ts: "2026-02-11T00:00:00Z" },
      ])
    );

    try {
      const entries = readAccessLog();
      expect(entries).toHaveLength(2);
      expect(entries[0].domain).toBe("a.com");
      expect(entries[1].domain).toBe("b.com");
    } finally {
      if (priorHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = priorHome;
      }
    }
  });
});
