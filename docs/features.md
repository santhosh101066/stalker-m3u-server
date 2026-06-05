# Stalker M3U Server — Full Feature Reference

---

## Table of Contents

1. [Environment Variables](#environment-variables)
2. [Portal Types & Auto-Detection](#portal-types--auto-detection)
3. [Cache Warming](#cache-warming)
4. [VOD Category Versioning](#vod-category-versioning)
5. [Content Manager](#content-manager)
6. [Override System](#override-system)
7. [Jellyfin / .strm Integration](#jellyfin--strm-integration)
8. [EPG Handling](#epg-handling)
9. [Profiles](#profiles)
10. [Live Stream Proxy & HLS](#live-stream-proxy--hls)
11. [TMDB Integration](#tmdb-integration)
12. [API Reference](#api-reference)

---

## Environment Variables

### Portal

| Variable | Default | Description |
|----------|---------|-------------|
| `STALKER_HOST` | — | Portal hostname |
| `STALKER_PORT` | `80` | Portal port |
| `STALKER_HTTPS` | `false` | Use HTTPS for portal connection |
| `STALKER_PATH` | `stalker_portal` | Context path |
| `STALKER_MAC` | `00:1A:79:00:00:00` | MAC address for STB emulation |
| `STALKER_STB` | `MAG254` | STB type |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Listen port |
| `NODE_ENV` | — | `production` enforces `PROXY_SECRET` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ADMIN_PASSWORD` | `admin` | Content Manager password |
| `PROXY_SECRET` | — | HMAC secret for signed proxy URLs — required in production |
| `JWT_SECRET` | — | JWT secret for API tokens |
| `TLS_CERT_PATH` | — | TLS certificate path (enables HTTPS) |
| `TLS_KEY_PATH` | — | TLS key path (enables HTTPS) |

### Content

| Variable | Default | Description |
|----------|---------|-------------|
| `SERIES_FLAG` | `is_series` | Field name that marks series items on mixed portals (value `1` = series) |
| `VOD_CATEGORY_VERSIONING` | `false` | Set `true` to append version suffix to category IDs in Xtream responses |
| `STRM_MOVIES_PATH` | — | Directory to write movie `.strm` files for Jellyfin/Emby |
| `STRM_SERIES_PATH` | — | Directory to write series `.strm` files for Jellyfin/Emby |
| `TMDB_API_READ_TOKEN` | — | TMDB read token for metadata enrichment |

### Networking

| Variable | Default | Description |
|----------|---------|-------------|
| `API_TIMEOUT` | `5000` | HTTP request timeout (ms) |
| `API_RETRIES` | `3` | Retry attempts on failed requests |

---

## Portal Types & Auto-Detection

Two portal layouts are supported and detected automatically on first series warm:

**Type 1 — Mixed portal**
- Movies and series share the same VOD endpoint
- Items with `{SERIES_FLAG} == 1` are treated as series
- Single category list serves both movies and series

**Type 2 — Native series portal**
- Separate `getSeries()` API for series
- `getMovies()` returns only movies
- Separate category lists for each content type
- Detected and stored in cache as `portal_series_source = "native"`

Detection is automatic. The result is cached in `XtreamCache` under `portal_series_source`. To force re-detection, clear the Xtream cache.

---

## Cache Warming

Content is cached in SQLite (`XtreamCache` table, 24-hour TTL) so the server never makes live portal calls during playback.

### Incremental warm (startup + every 24h)

`warmVodCache()` and `warmSeriesCache()` run in parallel:

1. Fetch portal pages until a known item is encountered
2. Only new items are inserted — no full reload
3. If new content is found, `bumpVodVersion()` is called to signal players
4. Genres are upserted based on actual content found
5. `cleanupGenres()` removes any genre entries with no cached content

`warmSeriesInfoCache()` runs independently after:
- Iterates every cached series and pre-fetches all seasons/episodes
- 500ms throttle between series to avoid portal hammering
- Stores episodes under `ep_info_{ep_id}` and `ep_cmd_{ep_id}`

### Full catchup scan

`POST /api/v2/catchup-scan` — use after a long offline period to fill any gaps the incremental scan would miss (it stops at the first known item).

### Cache key patterns

| Key | Content |
|-----|---------|
| `vod_streams_{category_id}` | Movie list for a genre |
| `series_list_{category_id}` | Series list for a genre |
| `series_info_{series_id}` | Seasons and episodes |
| `vod_info_{stream_id}` | Movie metadata |
| `vod_cmd_{stream_id}` | Movie playback command |
| `ep_info_{episode_id}` | Episode metadata |
| `ep_cmd_{episode_id}` | Episode playback command |
| `portal_series_source` | `"native"` or `"mixed"` |

---

## VOD Category Versioning

**The problem:** Free IPTV players (TiviMate free, etc.) cache category contents and only refresh when they see a new category ID. After a force-update they won't pick up new movies unless the category ID has changed.

**The trick:** When `VOD_CATEGORY_VERSIONING=true`, a Unix timestamp version is appended to every VOD and series category ID in Xtream responses:

```
category_id: "42"  →  category_id: "42_v1719234567890"
```

When new content arrives or you reorder/move items in the Content Manager, `bumpVodVersion()` writes a new timestamp. The player sees new category IDs on the next force-refresh and re-fetches the stream lists automatically.

**Internally**, `stripVer()` removes the suffix before any cache lookup, so the bare ID is always used server-side.

**When NOT to use this:** If your player has a premium APK with its own catchup/caching that bypasses your Xtream endpoints entirely, leave `VOD_CATEGORY_VERSIONING` unset. The player won't call your category endpoints anyway, so versioning won't help.

Version bumps are triggered by:
- New content found during a warm cycle
- Category reorder (genres/reorder endpoint)
- Item moved to a different category (items/reorder endpoint)
- Server startup (`bumpVodVersion` called once on init)

---

## Content Manager

Access at `http://your-server:3000/contentmanager`. Password protected via `ADMIN_PASSWORD`.

Three tabs: **Live**, **VOD**, **Series**.

### Category operations

| Action | Description |
|--------|-------------|
| Rename | Override the display name (original is preserved in DB) |
| Hide | Exclude from all API responses |
| Reorder | Drag-and-drop or A-Z sort; persists `sort_order` |
| Reset order | Clear custom sort, restore original portal order |
| Create virtual | Add a new user-defined category (VOD/Series only) |
| Delete virtual | Removes the category; items moved into it are restored to their originals |

### Item operations

| Action | Description |
|--------|-------------|
| Rename | Override display name |
| Hide | Exclude from all API responses |
| Move | Reassign to a different category (VOD/Series only) |
| Reorder | Drag within category; persists `sort_order` |
| Multi-select | Shift+click for range selection; all selected items get the same operation |

All changes are stored in `GenreOverride` and `ContentOverride` tables and applied transparently to every Xtream, M3U, and browse API response — the portal cache is never touched.

---

## Override System

Two database tables power the override layer:

### GenreOverride

| Field | Purpose |
|-------|---------|
| `genre_key` | Composite key: `{type}_{id}` e.g. `movie_42` |
| `display_name` | Renamed title (null = no rename) |
| `hidden` | Exclude from responses |
| `sort_order` | Custom position (null = original order) |
| `virtual` | True for user-created categories |
| `virtual_title` | Name of virtual category |

### ContentOverride

| Field | Purpose |
|-------|---------|
| `item_key` | Composite key: `{type}_{id}` e.g. `movie_12345` |
| `item_type` | `movie`, `series`, or `channel` |
| `display_name` | Renamed title |
| `hidden` | Exclude from responses |
| `target_category_id` | Category to move item into |
| `original_category_id` | Source category (saved for restore) |
| `sort_order` | Custom position within category |

### Move semantics

When an item is moved, `target_category_id` is set and `original_category_id` is saved. When fetching a category, items moved away are excluded and items moved in are included. Deleting a virtual category restores all items that were moved into it.

---

## Jellyfin / .strm Integration

Set `STRM_MOVIES_PATH` and/or `STRM_SERIES_PATH` to a directory Jellyfin/Emby can scan. On every cache warm the server generates `.strm` files pointing to stream URLs. Files are only written when the URL changes.

### Folder layout

**Movies:**
```
<STRM_MOVIES_PATH>/
  Movie Title (2023)/
    Movie Title (2023).strm
    Movie Title (2023) [4K].strm
    Movie Title (2023) [Hindi Dubbed].strm
```

**Series:**
```
<STRM_SERIES_PATH>/
  Show Name (2021)/
    Season 01/
      Show Name (2021) S01E01 - Episode Title.strm
```

### Duplicate merging

Portals commonly list the same movie multiple times with variant tags (language, quality, source). The server automatically:

1. Groups by canonical title (stripped of variant tags)
2. Picks the cleanest name as the primary folder
3. Renames duplicates as `Title [Tag].strm` inside the same folder
4. Removes now-empty secondary folders

Variant tag patterns detected:
- **Quality:** 4K, UHD, FHD, HD, SD, 720p, 1080p, 2160p
- **Audio:** Dual Audio, Dubbed, Multi, TriAudio
- **Language:** Hindi, Tamil, Telugu, Malayalam, Kannada, Bengali, and more
- **Format:** BluRay, WEBRip, WEB-DL, DVDRip, HDRip, HDCAM, CAM, TS

Trigger manual regeneration: `POST /api/admin/strm/generate` or via the Content Manager UI.

---

## EPG Handling

EPG data is fetched from the portal, cached in SQLite (`EpgCache` table), and served as XMLTV at `/epg.xml`.

### Fetch strategy

- **On startup:** fetch immediately if cache is missing or stale (>12 hours)
- **Background job:** checks every 30 minutes; only fetches if stale AND server has been idle for >2 minutes (avoids contention during active playback)
- **On-demand:** `POST /api/v2/refresh-epg`

### Concurrency

Channels are fetched 5 at a time with a yield between batches to avoid memory spikes on large channel lists.

### Title decoding

Xtream portals Base64-encode EPG titles. The server decodes them automatically before caching.

---

## Profiles

Multiple portal configurations can be stored and switched without restarting the server.

- Each profile has its own channels, genres, and EPG cache
- Content overrides (GenreOverride, ContentOverride) are global — shared across all profiles
- Only one profile can be active at a time
- Switching profiles reinitializes the provider and broadcasts a config-change event via WebSocket
- Deleting a profile cascades to its channels, genres, and EPG cache

**Profile API:** `GET/POST/PUT/DELETE /api/profiles` and `/api/profiles/{id}/activate`

---

## Live Stream Proxy & HLS

### Two-level HLS caching

1. **Master playlist** — resolved from portal command and cached for 30 seconds
2. **Segment map** — `#EXT-X-MEDIA-SEQUENCE` number → relative URL, stored per stream

Segments are served at `GET /player/{resourceId}.ts` with HMAC-signed URLs (`PROXY_SECRET`). Concurrent requests for the same stream share a single upstream fetch (pending-promise deduplication).

If the master playlist returns 301/302/403, the server auto-fetches a new master URL and updates the cache.

### General proxy

`GET /api/proxy/stream?url={base64url}&ref={base64ref}` — forwards Range headers (seeking), copies content headers, adds CORS headers. Referer can be set for servers that require it.

---

## TMDB Integration

Set `TMDB_API_READ_TOKEN` to enrich VOD and series metadata with posters and backdrops.

The server strips quality/format tags from titles before searching TMDB:
```
Avatar 4K BluRay  →  search "Avatar"
```

Returns `poster`, `backdrop`, and `overview` URLs. If TMDB is unavailable or the token is not set, the field is silently omitted — nothing breaks.

---

## API Reference

### Xtream Codes

| Endpoint | Actions |
|----------|---------|
| `GET /player_api.php` | `get_live_categories`, `get_live_streams`, `get_vod_categories`, `get_vod_streams`, `get_vod_info`, `get_series_categories`, `get_series`, `get_series_info`, `get_short_epg` |
| `GET /live/{user}/{pass}/{id}.m3u8` | Live stream |
| `GET /movie/{user}/{pass}/{id}.{ext}` | VOD stream |
| `GET /series/{user}/{pass}/{sid}/{season}/{ep}.{ext}` | Episode stream |
| `GET /xmltv.php` | EPG (XMLTV) |

### Browse (internal UI / custom players)

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
| `GET /api/v2/epg` | EPG data |
| `GET /api/v2/expiry` | Portal subscription expiry |

### Sync

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/refresh-groups` | Sync live groups |
| `GET /api/v2/refresh-channels` | Sync live channels |
| `GET /api/v2/refresh-movie-groups` | Sync VOD categories + trigger warm |
| `GET /api/v2/refresh-series-groups` | Sync series categories + auto-detect portal type |
| `POST /api/v2/refresh-epg` | Refresh EPG |
| `POST /api/refresh/vod` | Refresh VOD playlist |
| `GET /api/refresh/vod/status` | VOD refresh status |

### Cache

| Endpoint | Description |
|----------|-------------|
| `POST /api/v2/warm-xtream-vod` | Warm VOD cache (incremental) |
| `POST /api/v2/warm-xtream-series` | Warm series cache (incremental) |
| `POST /api/v2/catchup-scan` | Full gap-fill scan |
| `POST /api/v2/cleanup-genres` | Remove empty genre DB entries |
| `DELETE /api/v2/clear-xtream-cache` | Wipe Xtream cache |

### Config & Auth

| Endpoint | Description |
|----------|-------------|
| `GET /api/config` | Get server config |
| `POST /api/config` | Update server config |
| `POST /api/auth/admin` | Admin login (returns JWT) |
| `GET /api/v2/get-token` | Get API token |
| `POST /api/v2/clear-tokens` | Revoke all tokens |

### Profiles

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

### Content Manager

| Endpoint | Description |
|----------|-------------|
| `GET /contentmanager` | Browser UI |
| `GET /api/admin/genres?type=` | List categories with override state |
| `POST /api/admin/genres/{type}` | Create virtual category |
| `PUT /api/admin/genres/{type}/{id}` | Update category (rename / hide / sort) |
| `PUT /api/admin/genres/{type}/reorder` | Bulk-set category sort order |
| `DELETE /api/admin/genres/{type}/{id}` | Remove category override |
| `DELETE /api/admin/genres/{type}/order` | Clear all custom sort order |
| `GET /api/admin/items?type=&category_id=` | List items with override state |
| `PUT /api/admin/items/{type}/{id}` | Update item (rename / hide / move) |
| `PUT /api/admin/items/{type}/{category_id}/reorder` | Bulk-set item sort order |
| `DELETE /api/admin/items/{type}/{id}` | Remove item override |
| `POST /api/admin/strm/generate` | Trigger `.strm` generation |

### Debug

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/debug/epg?id=` | Raw EPG for a channel |
| `GET /api/v2/debug/vod-item?id=` | Raw portal item |
| `GET /api/v2/debug/episode-fetch?seriesId=&seasonId=` | Episode fetch diagnostics |
