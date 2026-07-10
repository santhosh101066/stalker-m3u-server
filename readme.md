<p align="center">
  <img src="public/stalker-logo.svg" alt="Stalker Server Logo" width="200" />
</p>

<h1 align="center">Stalker M3U Server</h1>

<p align="center">
  A Node.js middleware that bridges Stalker portals and Xtream Codes sources to any IPTV player — with a full content management layer, Jellyfin integration, and an HLS transcode proxy.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20-green?style=for-the-badge&logo=nodedotjs" />
  <img src="https://img.shields.io/badge/Docker-Enabled-blue?style=for-the-badge&logo=docker" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue?style=for-the-badge&logo=typescript" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" />
</p>

---

## What it does

Connects to a **Stalker portal** or **Xtream Codes API** and re-serves the content in formats your players actually understand — Xtream Codes API, M3U playlists, and XMLTV EPG. On top of raw passthrough it adds a full content management layer, Jellyfin/.strm integration, HLS transcode proxy, and several quality-of-life features.

**Core features at a glance:**

- **Dual provider support** — Stalker STB portals and Xtream Codes APIs both supported; switch via UI without restart
- **Xtream Codes API** — full protocol emulation (live, VOD, series, EPG, XMLTV)
- **M3U + EPG** — standard playlist and XMLTV endpoints
- **Content Manager** — browser UI to rename, hide, move, and reorder content without touching the portal
- **Virtual categories** — create custom groupings; move items in from any portal category
- **Cache warming** — incremental background fetching so players always see fresh content
- **VOD category versioning** — tricks free IPTV players into re-fetching updated categories on force-refresh
- **Jellyfin / Emby** — generates `.strm` files with automatic duplicate merging and variant tag detection
- **HLS transcode proxy** — FFmpeg-based VOD/series proxy with full seek support, multi-audio, and subtitle tracks
- **TMDB metadata** — optional poster/backdrop enrichment for VOD and series
- **Profiles** — multiple portal accounts, switchable without restart
- **Portal type auto-detection** — handles mixed VOD+series portals and native series portals automatically
- **Reverse-proxy friendly** — all generated URLs honor `X-Forwarded-Proto`/`X-Forwarded-Host`, so the same server works via LAN `ip:port` and an HTTPS domain simultaneously (Caddy/nginx/Traefik)
- **Client-aware live playback** — browsers get CORS-safe proxied HLS; Smart TVs (Tizen/WebOS) get direct redirects with zero server load
- **HTTPS / TLS** — optional TLS termination built in

---

## Quick Start

```bash
cp stalker-m3u-server.yml docker-compose.yml
# edit credentials, then:
docker compose up -d
```

Open `http://localhost:3000` to configure your portal.
Open `http://localhost:3000/contentmanager` for the content admin panel.

---

## Provider Setup

### Stalker Portal

| Variable | Description |
|----------|-------------|
| `STALKER_HOST` | Portal hostname (e.g. `portal.example.com`) |
| `STALKER_PORT` | Portal port (default `80`) |
| `STALKER_HTTPS` | Set `true` to connect over HTTPS |
| `STALKER_PATH` | Context path (default `stalker_portal`) |
| `STALKER_MAC` | Device MAC address for STB emulation |
| `STALKER_STB` | STB type (default `MAG254`) |

### Xtream Codes API

Configure via the browser UI at `http://localhost:3000` — set provider type to **Xtream**, then enter your host, username, and password. No environment variables needed; all Xtream credentials are stored per-profile in the database.

---

## Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Listen port |
| `JWT_SECRET` | — | **Required.** JWT signing key — server refuses to start if unset |
| `ADMIN_EMAIL` | — | **Required for admin login.** Email address of the admin account |
| `ADMIN_PASSWORD` | — | **Required for admin login.** Admin password — server returns 503 if unset |
| `PROXY_SECRET` | — | HMAC secret for signed proxy URLs (required in production) |
| `PUBLIC_BASE_URL` | — | Hard override for all generated URLs (e.g. `https://iptv.example.com`). If unset, URLs are derived per-request from `X-Forwarded-Proto`/`X-Forwarded-Host` (reverse proxy) or the request host — leave unset when the server is reached both via LAN ip:port and a proxied domain |
| `LIVE_TRANSCODE` | `false` | Set `true` to transcode HEVC live streams to H.264 on the server (ffmpeg) for clients without hardware HEVC decoding. Off by default — streams are proxied untouched and the client decodes |
| `SERIES_FLAG` | `is_series` | Field that marks series items on mixed portals where VOD and series share the same endpoint |
| `VOD_CATEGORY_VERSIONING` | `false` | Set `true` to enable category version suffixes (forces IPTV players to re-fetch updated categories) |
| `STRM_MOVIES_PATH` | — | Output directory for movie `.strm` files |
| `STRM_SERIES_PATH` | — | Output directory for series `.strm` files |
| `STRM_BASE_URL` | — | Base URL in `.strm` files — set to the address Jellyfin uses to reach this server (e.g. `http://192.168.1.100:3000`) |
| `STRM_XTREAM_USERNAME` | — | Email of the dedicated Xtream user whose credentials go into `.strm` file URLs — must have `xtreamEnabled: true` in the DB |
| `STRM_XTREAM_PASSWORD` | — | Password for the `STRM_XTREAM_USERNAME` account |
| `TMDB_API_READ_TOKEN` | — | TMDB token for poster/backdrop enrichment |
| `GOOGLE_CLIENT_ID` | — | Google OAuth client ID (enables Google sign-in) |
| `TLS_CERT_PATH` | — | TLS certificate path (enables HTTPS on the server) |
| `TLS_KEY_PATH` | — | TLS key path |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Full variable reference and all features → **[docs/features.md](docs/features.md)**

---

## Authentication

One user store (the `Users` table), reachable through several doors:

**Admin** — log in with `ADMIN_EMAIL` + `ADMIN_PASSWORD` through the normal login, or via the password-only admin login `POST /api/auth/admin` (used by the Content Manager). If `ADMIN_EMAIL` is not set, the server runs in **bootstrap mode**: any email + `ADMIN_PASSWORD` logs in as admin, and a startup warning is printed — set `ADMIN_EMAIL` to lock this down.

**Users** — Email/password or Google OAuth via `/api/auth/*`. New users are pending until an admin approves them. TV apps pair via a device code flow: the TV displays a short code, the user enters it in the web UI, and the TV receives a JWT automatically.

All `/api/` and `/v2/` endpoints require a Bearer JWT in the `Authorization` header unless the path is explicitly exempted (stream proxies, auth endpoints, Xtream player paths). Management endpoints (config, profiles, content manager, user admin) and all write operations additionally require the admin role.

The Xtream Codes API layer (`/player_api.php`, `/live/`, `/movie/`, `/series/`, M3U playlists) authenticates with **per-user credentials**: any active user's email + password (the same account used for web login), or the admin env credentials. There is no shared playlist password.

---

## Connecting Players

### Xtream Codes (TiviMate, IPTV Smarters, iPlayer, etc.)

| Field | Value |
|-------|-------|
| URL | `http://your-server:3000` (or your reverse-proxy domain) |
| Username | Your account email (same as web login) |
| Password | Your account password |

### M3U / EPG

| | URL |
|---|---|
| Live | `http://your-server:3000/playlist.m3u` |
| VOD | `http://your-server:3000/vod/playlist.m3u` |
| EPG | `http://your-server:3000/epg.xml` |

### Jellyfin / Emby

Set `STRM_MOVIES_PATH` and `STRM_SERIES_PATH` to directories your media server scans. `.strm` files are automatically generated and updated on every cache warm cycle.

---

## Reverse Proxy

Works out of the box behind Caddy, nginx, or Traefik. Every generated URL — the Xtream handshake (`server_info`), M3U playlist entries, TV pairing links — is derived **per request** from `X-Forwarded-Proto`/`X-Forwarded-Host`, falling back to the request host. So `https://iptv.example.com` and `http://192.168.1.x:3010` both work at the same time, each client getting URLs that match how it connected.

- **Caddy**: works with a plain `reverse_proxy` directive — it sets the forwarded headers by default
- **nginx**: add `proxy_set_header X-Forwarded-Proto $scheme;` and `proxy_set_header Host $host;`
- Set `PUBLIC_BASE_URL` only if you want to force one canonical address into every URL

---

## HLS Transcode Proxy

For players that can't handle direct stream URLs (DRM, unusual containers, multi-audio), the built-in FFmpeg proxy at `/api/media/hls/master.m3u8?url=...` transcodes on-the-fly with:

- Full VOD seeking via timestamp-encoded segment URIs
- Multi-audio track selection (language-labeled)
- Subtitle track passthrough
- Session-based FFmpeg process management with idle cleanup

For **live** streams, server-side HEVC→H.264 transcoding is available but off by default (`LIVE_TRANSCODE=true` to enable) — by default the server stays a pure proxy and clients decode with their own hardware.

Requires FFmpeg installed in the container (included in the default Docker image).

---

## Disclaimer

Middleware proxy only. Does not host or distribute content. Users are responsible for legal access to their configured portal.

## License

MIT
