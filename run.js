/**
 * One command, every site's blog watcher.
 *
 * Each site already has its own watcher (`npm run blog:watch` inside that
 * site's folder). Running them by hand means one terminal per site, and on a
 * server one service per site. This process reads sites.json, starts each
 * watcher in its own folder, labels their output, and restarts any that die.
 * It writes no blogs itself and touches no site's code.
 *
 * sites.json — one entry per site:
 *   {
 *     "name": "octopi",                        // label shown before each log line
 *     "cwd":  "/var/www/octopi-web-new",       // the site's folder
 *     "run":  "npm run blog:watch",            // optional, this is the default
 *     "claudeConfigDir": "/var/lib/claude/x",  // optional: give this site its own Claude login
 *     "env":  { "KEY": "value" }               // optional: extra environment for this site
 *   }
 *
 * Claude login: every site inherits CLAUDE_CONFIG_DIR from this process (one
 * shared login). A site with its own "claudeConfigDir" uses that instead, so
 * it runs on its own account and its own usage limit.
 */

const { spawn, execFileSync } = require("node:child_process");
const { readFileSync, existsSync } = require("node:fs");
const path = require("node:path");

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_RUN = "npm run blog:watch";

// A watcher that dies is restarted after a pause that doubles each time, so a
// site that is broken does not spin. A watcher that ran for a while before
// dying was working, so its pause starts over from the shortest.
const RESTART_MIN_MS = 5_000;
const RESTART_MAX_MS = 60_000;
const HEALTHY_AFTER_MS = 60_000;

function loadSites() {
  const file = path.join(__dirname, "sites.json");
  if (!existsSync(file)) {
    console.error("sites.json not found. Copy sites.example.json to sites.json and fill in this machine's paths.");
    process.exit(1);
  }
  let sites;
  try {
    sites = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`sites.json is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(sites) || sites.length === 0) {
    console.error("sites.json must be a list with at least one site.");
    process.exit(1);
  }
  const names = new Set();
  for (const site of sites) {
    if (!site.name || !site.cwd) {
      console.error(`Every site needs a "name" and a "cwd": ${JSON.stringify(site)}`);
      process.exit(1);
    }
    if (names.has(site.name)) {
      console.error(`Two sites are named "${site.name}". Names must be unique.`);
      process.exit(1);
    }
    names.add(site.name);
    if (!existsSync(site.cwd)) {
      console.error(`[${site.name}] folder does not exist: ${site.cwd}`);
      process.exit(1);
    }
  }
  return sites;
}

function makeLogger(label, width) {
  const tag = `[${label}]`.padEnd(width + 2);
  return (stream) => {
    let rest = "";
    stream.on("data", (chunk) => {
      rest += chunk.toString();
      const lines = rest.split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) console.log(`${tag} ${line}`);
    });
    stream.on("end", () => {
      if (rest) console.log(`${tag} ${rest}`);
      rest = "";
    });
  };
}

function siteEnv(site) {
  const env = { ...process.env, ...(site.env || {}) };
  if (site.claudeConfigDir) env.CLAUDE_CONFIG_DIR = site.claudeConfigDir;
  // Colour codes would be garbage in a log file and are noise between labels.
  env.FORCE_COLOR = "0";
  return env;
}

function startSite(site, log) {
  const command = site.run || DEFAULT_RUN;
  const child = spawn(command, {
    cwd: site.cwd,
    env: siteEnv(site),
    // The command is a fixed string from sites.json, not user input, so a
    // shell is fine here — and on Windows `npm` is a .cmd that needs one.
    shell: true,
    // On Linux/macOS the watcher becomes its own process group, so stopping
    // it stops everything it started (npm → tsx → node → claude) rather than
    // just the shell at the top.
    detached: !IS_WINDOWS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  log(child.stdout);
  log(child.stderr);
  return child;
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (IS_WINDOWS) {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    // Already gone.
  }
}

function main() {
  const sites = loadSites();
  const width = Math.max(...sites.map((s) => s.name.length));
  const children = new Map();
  let stopping = false;

  console.log("watch-blog: starting watchers");
  for (const site of sites) {
    const login = site.claudeConfigDir || process.env.CLAUDE_CONFIG_DIR || "default (~/.claude)";
    console.log(`  ${site.name.padEnd(width)}  ${site.cwd}`);
    console.log(`  ${"".padEnd(width)}  claude login: ${login}`);
  }
  console.log("");

  const supervise = (site, attempt) => {
    if (stopping) return;
    const log = makeLogger(site.name, width);
    const startedAt = Date.now();
    const child = startSite(site, log);
    children.set(site.name, child);

    child.on("exit", (code, signal) => {
      children.delete(site.name);
      if (stopping) return;
      const ranFor = Date.now() - startedAt;
      const wait = Math.min(RESTART_MIN_MS * 2 ** attempt, RESTART_MAX_MS);
      const next = ranFor > HEALTHY_AFTER_MS ? 0 : attempt + 1;
      console.log(
        `[${site.name}] exited (${signal || `code ${code}`}); restarting in ${wait / 1000}s`,
      );
      setTimeout(() => supervise(site, next), wait);
    });
  };

  for (const site of sites) supervise(site, 0);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log("\nwatch-blog: stopping all watchers");
    for (const child of children.values()) stopChild(child);
    // Give them a moment to disconnect cleanly, then go.
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
