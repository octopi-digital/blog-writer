# watch-blog

One command that runs every site's AI blog watcher.

Each site (Octopi, Brainy Box, …) already has its own watcher — the program
that waits for a blog request from the dashboard and asks Claude to write it.
Running them by hand means one terminal per site, and on the server one
service per site. This folder replaces that with a single `npm run watcher`
that starts all of them, labels their output, and restarts any that crash.

It writes no blogs itself and does not touch any site's code, database, or
Claude login. It only *starts* the watchers, the way a person would.

```
watch-blog/
  run.js              the manager
  sites.json          this machine's list of sites  (not in git — see below)
  sites.example.json  template for sites.json
```

## Adding a site

Add one line to `sites.json`. That is the whole job.

```json
[
  { "name": "octopi",    "cwd": "/var/www/octopi-web-new" },
  { "name": "brainybox", "cwd": "/var/www/Brainy-Box-backend" },
  { "name": "newsite",   "cwd": "/var/www/new-site" }
]
```

`name` is the label shown before each log line. `cwd` is the site's folder —
the manager runs `npm run blog:watch` inside it. Restart the manager and the
new site's watcher starts with the others.

Optional fields per site:

| Field | Meaning |
|---|---|
| `"run": "npm run blog:watch"` | Command to run in the folder. This is the default; set it only for a site that uses a different one. |
| `"claudeConfigDir": "/var/lib/claude/x"` | Give this site its **own Claude login** (see below). |
| `"env": { "KEY": "value" }` | Extra environment variables for this site only. |

## Claude login: one for all, or one per site

Claude Code keeps its login in a folder. The `CLAUDE_CONFIG_DIR` environment
variable says which folder; a different folder is a different login.

**Default — one login shared by every site.** Every watcher inherits
`CLAUDE_CONFIG_DIR` from the manager. Log in once, all sites use it. Simple,
but all sites share one usage limit.

**Per site — its own login.** Add `"claudeConfigDir"` to that site. It then
runs on its own account and its own usage limit, so a busy site can never slow
another down. Costs one extra `claude login` for that folder.

Mixing is fine: leave most sites on the shared login and give only the heavy
one its own.

## Running on your computer

```
cd C:\Office-project\watch-blog
copy sites.example.json sites.json
```

Edit `sites.json` so each `cwd` is the site's folder on *your* machine, e.g.
`C:/Office-project/octopi-web-new`. Then:

```
npm run watcher
```

You will see every site start in the same window:

```
[octopi]    blog writer watching
[brainybox] blog writer watching
```

Ctrl-C stops all of them.

`sites.json` is ignored by git on purpose: it holds paths that differ between
your computer and the server, so each machine keeps its own copy.

## Running on the server

Done once, over SSH. Replaces the separate per-site services.

### 1. Get the code

```bash
cd /var/www
git clone <repo-url> watch-blog
cd watch-blog
cp sites.example.json sites.json
nano sites.json          # set each cwd to the site's folder on the server
```

Every site listed must already be deployed on the server with its own
`npm install` done and its `.env` in place — the manager only starts what is
already there.

### 2. Log in to Claude

The shared login lives in one folder. Create it and log in once:

```bash
sudo mkdir -p /var/lib/claude/shared
sudo chown $USER /var/lib/claude/shared
CLAUDE_CONFIG_DIR=/var/lib/claude/shared claude login
```

For any site that has its own `"claudeConfigDir"` in `sites.json`, do the
same with that folder instead.

Never run a bare `claude login` on the server: without `CLAUDE_CONFIG_DIR` it
writes to `~/.claude`, which no site is looking at.

### 3. Try it in the terminal first

```bash
CLAUDE_CONFIG_DIR=/var/lib/claude/shared npm run watcher
```

Every site should reach "blog writer watching" and the dashboards should show
the writer online. Ctrl-C when satisfied.

### 4. Run it as a service

A terminal command dies when SSH disconnects; a service does not. Stop and
disable the old per-site services first (their names are in each site's own
setup doc, for example `blog-writer` (Octopi) and `brainybox-blog-writer` (Brainy Box)):

```bash
sudo systemctl disable --now blog-writer brainybox-blog-writer
```

Create `/etc/systemd/system/watch-blog.service` (a new name, so it cannot collide with the old per-site units):

```ini
[Unit]
Description=Blog watchers for all sites
After=network-online.target

[Service]
Type=simple
User=www-data                         # the user the sites run as
WorkingDirectory=/var/www/watch-blog
Environment=CLAUDE_CONFIG_DIR=/var/lib/claude/shared
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/npm run watcher
Restart=always
RestartSec=10
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`User` must be the account that ran `claude login` above and can read each
site's folder. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now watch-blog
sudo systemctl status watch-blog
```

### Day to day

```bash
sudo journalctl -u watch-blog -f          # live logs, every site labelled
sudo journalctl -u watch-blog -f | grep '\[octopi\]'   # one site only
sudo systemctl restart watch-blog         # after editing sites.json
```

After deploying new code to any site, restart the service so its watcher
picks it up.

## What the manager does when things go wrong

- A site's watcher crashes → only that one is restarted, after 5s, then 10s,
  20s, up to 60s between tries. Other sites are not affected.
- A watcher that ran for over a minute before crashing was working, so its
  restart wait goes back to 5s.
- The manager is stopped (Ctrl-C or `systemctl stop watch-blog`) → every watcher and the
  Claude run it may be in the middle of are stopped too. The dashboards show
  the writer offline within about a minute.
- A site's folder in `sites.json` does not exist → the manager refuses to
  start and says which one, rather than running half the list.
