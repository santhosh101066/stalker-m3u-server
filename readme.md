<p align="center">
  <img src="public/stalker-logo.svg" alt="Stalker Server Logo" width="200" />
</p>

<h1 align="center">Stalker M3U Server</h1>

<p align="center">
  A Node.js middleware that bridges Stalker portals to Xtream Codes-compatible players, M3U playlist consumers, and a built-in browser UI — all from a single server.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20-green?style=for-the-badge&logo=nodedotjs" />
  <img src="https://img.shields.io/badge/Docker-Enabled-blue?style=for-the-badge&logo=docker" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue?style=for-the-badge&logo=typescript" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" />
</p>

---

## Features

- **Xtream Codes API emulation** — exposes `/player_api.php` so any Xtream-compatible player (Tivimate, IPTV Smarters, etc.) works out of the box
- **Dual portal support** — handles both portal types automatically:
  - **Type 1**: single VOD section with movies and series mixed together (`is_series` flag)
  - **Type 2**: separate native series section alongside VOD
- **M3U playlist generation** — `/playlist.m3u` for live channels, `/vod/playlist.m3u` for VOD
- **Built-in browser UI** — manage channels, groups, VOD, and series from a web interface
- **Incremental cache warming** — on startup and every 24 hours, fetches only new items (stops the moment a known item is found) without a full re-fetch
- **Manual catchup scan** — force a full gap-fill across all pages when needed
- **EPG support** — XMLTV endpoint (`/xmltv.php`) and short EPG via Xtream API
- **Smart stream proxy** — rewrites HLS playlists so segments are served through the proxy, keeping upstream URLs hidden
- **SQLite persistence** — channels, genres, cache, and config profiles stored locally via Sequelize
- **JWT authentication** — secure API access
- **Socket.io signaling** — real-time device casting and remote control

---

## Quick Start

### Docker Compose (recommended)

1. Copy the example compose file and edit it:
   ```bash
   cp stalker-m3u-server.yml docker-compose.yml
   ```

2. Set your portal credentials in the environment section:
   ```yaml
   environment:
     - PORTAL_URL=http://your-portal-url
     - MAC=your:mac:address
   ```

3. Start the server:
   ```bash
   docker compose up -d
   ```

The server runs on port **3000**. Open `http://localhost:3000` in your browser to configure it.

### Local Development

```bash
npm install
npm run dev
```

---

## Connecting Players

### Xtream Codes players (Tivimate, IPTV Smarters, etc.)

| Field    | Value                              |
|----------|------------------------------------|
| URL      | `http://your-server-ip:3000`       |
| Username | *(your configured username)*       |
| Password | *(your configured password)*       |

The server exposes the full Xtream Codes API at `/player_api.php`.

### M3U playlist

| Content       | URL                                            |
|---------------|------------------------------------------------|
| Live channels | `http://your-server-ip:3000/playlist.m3u`      |
| VOD           | `http://your-server-ip:3000/vod/playlist.m3u`  |
| EPG (XMLTV)   | `http://your-server-ip:3000/epg.xml`           |

---

## API Reference

### Xtream Codes API

| Endpoint | Description |
|----------|-------------|
| `GET /player_api.php` | Full Xtream Codes API (`action=get_live_streams`, `get_vod_streams`, `get_series`, `get_series_info`, `get_vod_info`, `get_live_categories`, `get_vod_categories`, `get_series_categories`, `get_short_epg`) |
| `GET /live/{user}/{pass}/{id}.m3u8` | Live stream |
| `GET /movie/{user}/{pass}/{id}.m3u8` | VOD stream |
| `GET /series/{user}/{pass}/{id}.m3u8` | Series episode stream |
| `GET /xmltv.php` | EPG in XMLTV format |

### Browser / Management API

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/groups` | Live channel groups |
| `GET /api/v2/channels` | Live channels |
| `GET /api/v2/movie-groups` | VOD categories |
| `GET /api/v2/movies` | Movies (filtered, paginated) |
| `GET /api/v2/series-groups` | Series categories |
| `GET /api/v2/series` | Series (filtered, paginated) |
| `GET /api/v2/channel-link` | Resolve live stream URL |
| `GET /api/v2/movie-link` | Resolve VOD/episode URL |
| `GET /api/v2/epg` | EPG data |
| `GET /api/v2/expiry` | Portal subscription expiry |

### Refresh / Sync

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/refresh-groups` | Re-fetch live groups from portal |
| `GET /api/v2/refresh-channels` | Re-fetch live channels from portal |
| `GET /api/v2/refresh-movie-groups` | Re-fetch VOD categories (probes each for movies) |
| `GET /api/v2/refresh-series-groups` | Re-fetch series categories (auto-detects portal type) |
| `POST /api/v2/refresh-epg` | Refresh EPG |

### Cache Warming

| Endpoint | Description |
|----------|-------------|
| `POST /api/v2/warm-xtream-vod` | Incrementally warm VOD cache (new items only) |
| `POST /api/v2/warm-xtream-series` | Incrementally warm series list + episode info cache |
| `POST /api/v2/catchup-scan` | Full gap-fill scan across all pages (manual only) |
| `DELETE /api/v2/clear-xtream-cache` | Wipe all Xtream cache entries |

### Debug

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/debug/epg?id=` | Raw EPG for a channel ID |
| `GET /api/v2/debug/vod-item?id=` | Raw portal response for a movie/series ID |
| `GET /api/v2/debug/episode-fetch?seriesId=&seasonId=` | Try all episode-fetch strategies and return results |

---

## Cache Warming

The server maintains a local SQLite cache of VOD and series data so Xtream clients get fast responses without hitting the portal on every request.

**How incremental warming works:**

- On startup and every 24 hours, `warmVodCache` and `warmSeriesCache` run automatically
- Each run scans the portal page by page and stops the moment it finds an item already in the local cache — so only genuinely new content is fetched
- `warmSeriesInfoCache` (triggered alongside `warmSeriesCache`) fetches full season/episode data for any series that doesn't yet have it
- The very first run (empty cache) naturally fetches all pages since no item is known yet

**Manual catchup scan (`POST /api/v2/catchup-scan`):**

Use this when the incremental warm may have missed items in the middle of the catalog (e.g., after a long offline period). It performs a full scan of all pages, inserting any item not already in the cache at the correct position. This is the only operation that reads every page — normal warming never does a full fetch.

---

## Dual Portal Support

The server auto-detects which portal type you have when you call `GET /api/v2/refresh-series-groups`:

| Portal Type | Detection | Behavior |
|-------------|-----------|----------|
| **Type 2** (native series) | Series API returns categories | Uses `getSeries` for all series fetching |
| **Type 1** (mixed VOD) | Series API returns nothing; VOD contains `is_series=1` items | Uses `getMovies` + `is_series` filter |

The detected type is stored in the local database and used by all subsequent series operations. Re-run `refresh-series-groups` if you switch portals.

---

## Deployment

```bash
# Full build + deploy to remote host
./deploy.sh

# Restart container only
./deploy.sh restart

# View logs
./deploy.sh logs
```

---

## Disclaimer

This server is a **middleware proxy only**. It does not host, provide, or distribute any media content. It interfaces with user-provided Stalker portals. Users are solely responsible for ensuring they have the legal right to access their configured content.

## Contributing

Contributions are welcome. Please fork the repository and open a pull request.

## License

MIT