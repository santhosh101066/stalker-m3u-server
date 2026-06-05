<p align="center">
  <img src="public/stalker-logo.svg" alt="Stalker Server Logo" width="200" />
</p>

<h1 align="center">Stalker M3U Server</h1>

<p align="center">
  A Node.js middleware that bridges Stalker portals to Xtream Codes-compatible players, M3U playlist consumers, and a built-in browser UI.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20-green?style=for-the-badge&logo=nodedotjs" />
  <img src="https://img.shields.io/badge/Docker-Enabled-blue?style=for-the-badge&logo=docker" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue?style=for-the-badge&logo=typescript" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" />
</p>

---

## What it does

Connects to a Stalker portal (or Xtream source) and re-serves the content in formats your players actually understand — Xtream Codes API, M3U playlists, and XMLTV EPG. On top of raw passthrough it adds a full content management layer, Jellyfin integration, and several quality-of-life features for free IPTV player users.

**Core features at a glance:**

- **Xtream Codes API** — full protocol emulation (live, VOD, series, EPG)
- **M3U + EPG** — standard playlist and XMLTV endpoints
- **Content Manager** — browser UI to rename, hide, move, and reorder content without touching the portal
- **Cache warming** — incremental background fetching so players always see fresh content
- **VOD category versioning** — tricks free IPTV players into re-fetching updated categories on force-refresh
- **Jellyfin / Emby** — generates `.strm` files with automatic duplicate merging
- **Profiles** — multiple portal accounts, switchable without restart
- **TMDB metadata** — optional poster/backdrop enrichment
- **Portal type auto-detection** — handles mixed VOD+series portals and native series portals automatically

---

## Quick Start

```bash
cp stalker-m3u-server.yml docker-compose.yml
# edit credentials, then:
docker compose up -d
```

Open `http://localhost:3000` to configure.  
Open `http://localhost:3000/contentmanager` for the content admin panel.

---

## Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STALKER_HOST` | — | Portal hostname |
| `STALKER_MAC` | — | Device MAC address |
| `SERIES_FLAG` | `is_series` | Field that marks series items on mixed portals |
| `VOD_CATEGORY_VERSIONING` | `false` | Set `true` to enable category version suffixes (free player trick) |
| `STRM_MOVIES_PATH` | — | Output directory for movie `.strm` files |
| `STRM_SERIES_PATH` | — | Output directory for series `.strm` files |
| `TMDB_API_READ_TOKEN` | — | TMDB token for poster/backdrop enrichment |
| `PROXY_SECRET` | — | HMAC secret for signed proxy URLs (required in production) |
| `ADMIN_PASSWORD` | `admin` | Content Manager password |

Full variable reference and all features → **[docs/features.md](docs/features.md)**

---

## Connecting Players

**Xtream Codes** (TiviMate, IPTV Smarters, iPlayer):

| Field | Value |
|-------|-------|
| URL | `http://your-server:3000` |
| Username | *(configured username)* |
| Password | *(configured password)* |

**M3U / EPG:**

| | URL |
|---|---|
| Live | `http://your-server:3000/playlist.m3u` |
| VOD | `http://your-server:3000/vod/playlist.m3u` |
| EPG | `http://your-server:3000/epg.xml` |

---

## Disclaimer

Middleware proxy only. Does not host or distribute content. Users are responsible for legal access to their configured portal.

## License

MIT
