```
     _____ _ _          ____  _            _
    / ____(_) |        |  _ \| |          | |
   | (___  _| |_ ___  | |_) | | ___   ___| | _____ _ __
    \___ \| | __/ _ \ |  _ <| |/ _ \ / __| |/ / _ \ '__|
    ____) | | ||  __/ | |_) | | (_) | (__|   <  __/ |
   |_____/|_|\__\___| |____/|_|\___/ \___|_|\_\___|_|

          🔒 Block distracting websites. Stay focused.

               ┌─────────────────────────┐
               │  youtube.com      ✖ NO  │
               │  reddit.com       ✖ NO  │
               │  twitter.com      ✖ NO  │
               │  your-work.com    ✔ YES │
               └─────────────────────────┘
```

A native macOS desktop app that blocks distracting websites by managing `/etc/hosts`. No background daemons, no browser extensions, no subscriptions — just a simple utility that does one thing well.

## Install

Download the latest `.dmg` from [Releases](../../releases), open it, drag to Applications.

## How It Works

```
  You            Site Blocker         /etc/hosts
   │                  │                    │
   ├─ "block X" ─────►│                    │
   │                  ├─ writes ──────────►│  # BEGIN SITE-BLOCKER
   │                  │                    │  127.0.0.1 X
   │                  │                    │  # END SITE-BLOCKER
   │                  │                    │
   │    Browser tries X ──── DNS ─────────►│  → 127.0.0.1 🚫
   │                  │                    │
```

Sites are blocked at the OS level — works across all browsers, no extensions needed. Requires admin permission to modify `/etc/hosts` (macOS will prompt you).

## Build from Source

```bash
npm install
npm run build
npm start
```

## License

MIT
