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
| `ADMIN_PASSWORD` | `admin` | Content Manager password |
| `PROXY_SECRET` | — | HMAC secret for signed proxy URLs (required in production) |
| `JWT_SECRET` | — | JWT secret for API tokens |
| `SERIES_FLAG` | `is_series` | Field that marks series items on mixed portals where VOD and series share the same endpoint |
| `VOD_CATEGORY_VERSIONING` | `false` | Set `true` to enable category version suffixes (free player trick) |
| `STRM_MOVIES_PATH` | — | Output directory for movie `.strm` files |
| `STRM_SERIES_PATH` | — | Output directory for series `.strm` files |
| `TMDB_API_READ_TOKEN` | — | TMDB token for poster/backdrop enrichment |
| `TLS_CERT_PATH` | — | TLS certificate path (enables HTTPS on the server) |
| `TLS_KEY_PATH` | — | TLS key path |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Full variable reference and all features → **[docs/features.md](docs/features.md)**

---

## Connecting Players

### Xtream Codes (TiviMate, IPTV Smarters, iPlayer, etc.)

| Field | Value |
|-------|-------|
| URL | `http://your-server:3000` |
| Username | *(configured username)* |
| Password | *(configured password)* |

### M3U / EPG

| | URL |
|---|---|
| Live | `http://your-server:3000/playlist.m3u` |
| VOD | `http://your-server:3000/vod/playlist.m3u` |
| EPG | `http://your-server:3000/epg.xml` |

### Jellyfin / Emby

Set `STRM_MOVIES_PATH` and `STRM_SERIES_PATH` to directories your media server scans. `.strm` files are automatically generated and updated on every cache warm cycle.

---

## HLS Transcode Proxy

For players that can't handle direct stream URLs (DRM, unusual containers, multi-audio), the built-in FFmpeg proxy at `/api/media/hls/master.m3u8?url=...` transcodes on-the-fly with:

- Full VOD seeking via timestamp-encoded segment URIs
- Multi-audio track selection (language-labeled)
- Subtitle track passthrough
- Session-based FFmpeg process management with idle cleanup

Requires FFmpeg installed in the container (included in the default Docker image).

---

## Disclaimer

Middleware proxy only. Does not host or distribute content. Users are responsible for legal access to their configured portal.

## License

MIT
