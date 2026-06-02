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

## How it works

```
Stalker Portal
      │
      ├── Live channels  ──────────────────────────────► /player_api.php (get_live_streams)
      │                                                  /playlist.m3u
      │
      ├── VOD (movies + series mixed)
      │     │
      │     │  warm functions split by SERIES_FLAG
      │     ├── is_series = 0  ──► vod_streams_X  ──────► /player_api.php (get_vod_streams)
      │     │                                             /vod/playlist.m3u
      │     └── is_series = 1  ──► series_list_X  ──────► /player_api.php (get_series)
      │
      └── Native series (Type 2 portal, preferred)  ──► /player_api.php (get_series)
```

**Portal types — auto-detected on `refresh-series-groups`:**

- **Type 1** — movies and series share the same VOD endpoint, split by `SERIES_FLAG`
- **Type 2** — portal has a dedicated series API (preferred when available)

---

## Quick Start

```bash
cp stalker-m3u-server.yml docker-compose.yml
# edit credentials, then:
docker compose up -d
```

Key environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `STALKER_HOST` | — | Portal hostname |
| `STALKER_MAC` | — | Device MAC address |
| `SERIES_FLAG` | `is_series` | Field name on VOD items that marks series (`1` = series) |
| `STRM_MOVIES_PATH` | — | Directory to write movie `.strm` files (Jellyfin/Emby) |
| `STRM_SERIES_PATH` | — | Directory to write series `.strm` files (Jellyfin/Emby) |

> If your portal uses a different field than `is_series` to distinguish movies from series, set `SERIES_FLAG` to match.

Open `http://localhost:3000` to configure.

---

## Connecting Players

**Xtream Codes** (Tivimate, IPTV Smarters, iPlayer):

| Field | Value |
|-------|-------|
| URL | `http://your-server-ip:3000` |
| Username | *(configured username)* |
| Password | *(configured password)* |

**M3U / EPG:**

| | URL |
|---|---|
| Live | `http://your-server-ip:3000/playlist.m3u` |
| VOD | `http://your-server-ip:3000/vod/playlist.m3u` |
| EPG | `http://your-server-ip:3000/epg.xml` |

---

## Cache Warming

On startup and every 24 hours:

```
warmVodCache + warmSeriesCache (parallel)
  └── fetchUntilKnown: scan pages, stop at first known item
  └── upsert genre DB based on actual content found
        └── cleanupGenres: remove genre entries with no cache content
warmSeriesInfoCache (independent)
  └── fetch season/episode data for uncached series
```

Use `POST /api/v2/catchup-scan` to force a full page scan (e.g. after a long offline period).

After each warm cycle, `.strm` files are regenerated if `STRM_MOVIES_PATH` / `STRM_SERIES_PATH` are set.

---

## Jellyfin / Emby (.strm Files)

Set `STRM_MOVIES_PATH` and/or `STRM_SERIES_PATH` to a directory Jellyfin/Emby can scan. On every cache warm cycle the server writes one `.strm` file per movie/episode containing the stream URL. Files are only written when the URL changes.

**Folder layout — movies:**
```
<STRM_MOVIES_PATH>/
  Movie Title (2023)/
    Movie Title (2023).strm
```

**Folder layout — series:**
```
<STRM_SERIES_PATH>/
  Show Name (2021)/
    Season 01/
      Show Name (2021) S01E01 - Episode Title.strm
```

Duplicate folders that differ only by variant tags (language, quality, source — e.g. "Hindi", "4K", "WEBRip") are automatically merged into the cleanest folder name, with the tag appended to each file's stem.

Trigger a manual regeneration from the Content Manager UI or via `POST /api/admin/strm/generate`.

---

## Content Manager

Open `http://your-server-ip:3000/contentmanager` for a browser-based admin panel to customise how content appears to players.

**What you can do:**
- **Hide** categories or individual items so they never appear in players
- **Rename** categories and items with a display name (original name is preserved)
- **Move** VOD/series items to a different category
- **Reorder** categories and items with drag-friendly sort controls
- **Create virtual categories** (genre groups not present on the portal)

Changes are stored in the database and applied transparently to all Xtream, M3U, and browser API responses without touching the cache.

---

## API Reference

**Xtream Codes**

| Endpoint | Actions |
|----------|---------|
| `GET /player_api.php` | `get_live_streams`, `get_vod_streams`, `get_series`, `get_series_info`, `get_vod_info`, `get_live_categories`, `get_vod_categories`, `get_series_categories`, `get_short_epg` |
| `GET /live/{user}/{pass}/{id}.m3u8` | Live stream |
| `GET /movie/{user}/{pass}/{id}.m3u8` | VOD stream |
| `GET /series/{user}/{pass}/{id}.m3u8` | Series episode |
| `GET /xmltv.php` | EPG (XMLTV) |

**Browse**

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/groups` | Live channel groups |
| `GET /api/v2/channels` | Live channels |
| `GET /api/v2/movie-groups` | VOD categories |
| `GET /api/v2/movies` | Movies (paginated) |
| `GET /api/v2/series-groups` | Series categories |
| `GET /api/v2/series` | Series (paginated) |
| `GET /api/v2/channel-link` | Resolve live stream URL |
| `GET /api/v2/movie-link` | Resolve VOD / episode URL |
| `GET /api/vod/play` | Play VOD item |
| `GET /api/v2/epg` | EPG data |
| `GET /api/v2/expiry` | Portal subscription expiry |

**Sync**

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/refresh-groups` | Sync live groups |
| `GET /api/v2/refresh-channels` | Sync live channels |
| `GET /api/v2/refresh-movie-groups` | Sync VOD categories + trigger warm |
| `GET /api/v2/refresh-series-groups` | Sync series categories + auto-detect portal type |
| `POST /api/v2/refresh-epg` | Refresh EPG |
| `POST /api/refresh/vod` | Refresh VOD playlist |
| `GET /api/refresh/vod/status` | VOD refresh status |

**Cache**

| Endpoint | Description |
|----------|-------------|
| `POST /api/v2/warm-xtream-vod` | Warm VOD cache (incremental) |
| `POST /api/v2/warm-xtream-series` | Warm series cache (incremental) |
| `POST /api/v2/cleanup-genres` | Remove empty genre DB entries |
| `POST /api/v2/catchup-scan` | Full gap-fill scan (manual) |
| `DELETE /api/v2/clear-xtream-cache` | Wipe Xtream cache |

**Config & Auth**

| Endpoint | Description |
|----------|-------------|
| `GET /api/config` | Get server config |
| `POST /api/config` | Update server config |
| `POST /api/auth/admin` | Admin login |
| `GET /api/v2/get-token` | Get API token |
| `POST /api/v2/clear-tokens` | Revoke all tokens |

**Profiles**

| Endpoint | Description |
|----------|-------------|
| `GET /api/profiles` | List profiles |
| `POST /api/profiles` | Create profile |
| `GET /api/profiles/{id}` | Get profile |
| `PUT /api/profiles/{id}` | Update profile |
| `DELETE /api/profiles/{id}` | Delete profile |
| `POST /api/profiles/{id}/activate` | Switch active profile |
| `POST /api/profiles/{id}/enable` | Enable profile |
| `POST /api/profiles/{id}/disable` | Disable profile |

**Debug**

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/debug/epg?id=` | Raw EPG for channel |
| `GET /api/v2/debug/vod-item?id=` | Raw portal item |
| `GET /api/v2/debug/episode-fetch?seriesId=&seasonId=` | Episode fetch diagnostics |

**Content Manager**

| Endpoint | Description |
|----------|-------------|
| `GET /contentmanager` | Browser admin UI |
| `GET /api/admin/genres?type=` | List categories with override state |
| `POST /api/admin/genres/{type}` | Create a virtual category |
| `PUT /api/admin/genres/{type}/{id}` | Update category override (rename / hide / sort) |
| `PUT /api/admin/genres/{type}/reorder` | Bulk-set sort order for categories |
| `DELETE /api/admin/genres/{type}/{id}` | Remove category override |
| `DELETE /api/admin/genres/{type}/order` | Clear all custom sort order for a type |
| `GET /api/admin/items?type=&category_id=` | List items with override state |
| `PUT /api/admin/items/{type}/{id}` | Update item override (rename / hide / move) |
| `PUT /api/admin/items/{type}/{category_id}/reorder` | Bulk-set sort order for items |
| `DELETE /api/admin/items/{type}/{id}` | Remove item override |
| `POST /api/admin/strm/generate` | Trigger `.strm` file generation in background |

---

## Disclaimer

Middleware proxy only. Does not host or distribute content. Users are responsible for legal access to their configured portal.

## License

MIT