# Stalker M3U Server — Full Feature Reference

---

## Table of Contents

1. [Environment Variables](#environment-variables)
2. [Provider Types](#provider-types)
3. [Portal Type Auto-Detection](#portal-type-auto-detection)
4. [Cache Warming](#cache-warming)
5. [VOD Category Versioning](#vod-category-versioning)
6. [Content Manager](#content-manager)
7. [Override System](#override-system)
8. [Jellyfin / .strm Integration](#jellyfin--strm-integration)
9. [HLS Transcode Proxy](#hls-transcode-proxy)
10. [EPG Handling](#epg-handling)
11. [Profiles](#profiles)
12. [Live Stream Proxy](#live-stream-proxy)
13. [TMDB Integration](#tmdb-integration)
14. [API Reference](#api-reference)

---

## Environment Variables

### Portal (Stalker)

| Variable | Default | Description |
|----------|---------|-------------|
| `STALKER_HOST` | — | Portal hostname |
| `STALKER_PORT` | `80` | Portal port |
| `STALKER_HTTPS` | `false` | Use HTTPS for portal connection |
| `STALKER_PATH` | `stalker_portal` | Context path |
| `STALKER_MAC` | `00:1A:79:00:00:00` | MAC address for STB emulation |
| `STALKER_STB` | `MAG254` | STB type |

> Xtream Codes credentials (host, username, password) are stored per-profile in the database and configured via the browser UI — not environment variables.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Listen port |
| `NODE_ENV` | — | `production` enforces `PROXY_SECRET` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ADMIN_PASSWORD` | `admin` | Content Manager password |
| `PROXY_SECRET` | — | HMAC secret for signed proxy URLs — required in production |
| `JWT_SECRET` | — | JWT secret for API tokens |
| `TLS_CERT_PATH` | — | TLS certificate path (enables HTTPS on the server) |
| `TLS_KEY_PATH` | — | TLS key path |

### Content

| Variable | Default | Description |
|----------|---------|-------------|
| `SERIES_FLAG` | `is_series` | Field name that marks series items on mixed Xtream portals (value `1` = series) |
| `VOD_CATEGORY_VERSIONING` | `false` | Set `true` to append version suffix to category IDs in Xtream responses |
| `STRM_MOVIES_PATH` | — | Directory to write movie `.strm` files for Jellyfin/Emby |
| `STRM_SERIES_PATH` | — | Directory to write series `.strm` files for Jellyfin/Emby |
| `TMDB_API_READ_TOKEN` | — | TMDB read token for metadata enrichment |

### Networking

| Variable | Default | Description |
|----------|---------|-------------|
| `API_TIMEOUT` | `5000` | HTTP request timeout (ms) |
| `API_RETRIES` | `3` | Retry attempts on failed requests (disabled for streams and aborted requests) |

---

## Provider Types

The server supports two backend provider types, switchable per-profile without restart.

### Stalker Portal

Connects to a Stalker Middleware portal using STB emulation (MAC address + token authentication). All portal API calls go through the Stalker `load.php` endpoint. The `stalkerApi` singleton manages token refresh, watchdog keep-alive, and request queuing.

**Configuration:** `STALKER_HOST`, `STALKER_MAC`, and related env vars.

### Xtream Codes API

Connects to any Xtream Codes-compatible API (`player_api.php`). Credentials (host, port, username, password) are stored in the active `ConfigProfile` in the database and configured via the browser UI.

**VLC User-Agent** is sent on all Xtream requests to maximize compatibility with portal-side access controls.

**Stream URLs** for Xtream use `this.baseUrl` (the portal's own address) and detect the real container extension via `get_vod_info` / `get_series_info` before building the final URL — falling back to `.mp4` if unavailable.

### Switching providers

Switching the active profile reinitializes the provider, stops the Stalker watchdog, clears the in-memory cache, and broadcasts a config-change event via WebSocket — no restart required.

---

## Portal Type Auto-Detection

Two Xtream portal layouts are supported and detected automatically on first series category warm:

**Type 1 — Mixed portal**
- Movies and series share the same VOD endpoint
- Items with `{SERIES_FLAG} == 1` are treated as series
- `SERIES_FLAG` defaults to `is_series`; override with the env var for portals using a different field name

**Type 2 — Native series portal**
- Separate `get_series` / `get_series_categories` API for series
- `get_vod_streams` returns only movies
- Separate category lists for each content type
- Detected and stored in cache as `portal_series_source = "native"`

Detection is automatic. The result is cached in `XtreamCache` under `portal_series_source`. To force re-detection, clear the Xtream cache or refresh series groups.

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

`warmSeriesInfoCache()` runs independently after the series warm:
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

Version bumps are triggered by:
- New content found during a warm cycle
- Category reorder (genres/reorder endpoint)
- Item moved to a different category (items/reorder endpoint)
- Server startup

**When NOT to use this:** If your player has a premium APK that bypasses Xtream category endpoints entirely, leave `VOD_CATEGORY_VERSIONING` unset.

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
| Move | Reassign to a different category, including virtual ones (VOD/Series only) |
| Reorder | Drag within category; persists `sort_order` |
| Multi-select | Shift+click for range selection; all selected items get the same operation |

All changes are stored in `GenreOverride` and `ContentOverride` tables and applied transparently to every Xtream, M3U, and browse API response — the portal cache is never modified.

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
| `target_category_id` | Category to move item into (supports virtual `vcat_*` IDs) |
| `original_category_id` | Source category (saved for restore) |
| `sort_order` | Custom position within category |

### Move semantics

When an item is moved, `target_category_id` is set and `original_category_id` is saved. When fetching a category, items moved away are excluded and items moved in are appended after applying sort order. Deleting a virtual category restores all items that were moved into it to their original categories.

### Virtual categories

Virtual categories have IDs prefixed `vcat_`. The Xtream response normalizes `vcat_*` → `*` before any portal API call, so the portal never sees the virtual ID. Items can be moved into virtual categories freely — they appear under that category in all API responses and are excluded from their original category.

---

## Jellyfin / .strm Integration

Set `STRM_MOVIES_PATH` and/or `STRM_SERIES_PATH` to a directory Jellyfin/Emby can scan. On every cache warm the server generates `.strm` files pointing to stream URLs. Files are only written when the URL changes — existing paths with unchanged URLs are left untouched.

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
4. Removes now-empty secondary folders on regeneration

Variant tag patterns detected:
- **Quality:** 4K, UHD, FHD, HD, SD, 720p, 1080p, 2160p
- **Audio:** Dual Audio, Dubbed, Multi, TriAudio
- **Language:** Hindi, Tamil, Telugu, Malayalam, Kannada, Bengali, and more
- **Format:** BluRay, WEBRip, WEB-DL, DVDRip, HDRip, HDCAM, CAM, TS

Trigger manual regeneration: `POST /api/admin/strm/generate` or via the Content Manager UI.

---

## HLS Transcode Proxy

An FFmpeg-based transcode proxy for VOD and series content. Useful for players that can't handle the portal's native stream format, need seeking in container formats that don't support it natively, or require specific audio track selection.

**Requires FFmpeg** to be installed (included in the default Docker image).

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/media/info?url=` | Probe a URL — returns duration, audio tracks, subtitle tracks |
| `GET /api/media/hls/master.m3u8?url=` | Master HLS playlist with all audio tracks |
| `GET /api/media/hls/session/{sessionId}/{file}` | Individual media playlists and `.ts` segments |
| `GET /api/media/subtitle?url=&index=` | Extract and serve a subtitle track |

### How it works

1. `GET /api/media/info` — FFprobe probes the URL and returns metadata (duration, audio/subtitle streams). Result cached for 6 hours.
2. `GET /api/media/hls/master.m3u8` — builds a master playlist listing all audio tracks as `#EXT-X-MEDIA` groups. Each track gets its own `playlist_audio_N.m3u8`.
3. Media playlists are VOD-type with timestamp-encoded segment URIs (`seg_video_0.ts?start=0.000`). Seeking is exact — the segment handler reads the `start` query param and passes `-ss` to FFmpeg.
4. FFmpeg is spawned per session with a `SIGKILL` watchdog that fires after 60 seconds of inactivity.
5. Parallel seek-restart races are guarded (`isRestarting` flag + debounce).

### Session lifecycle

- Sessions are stored in memory in `activeSessions`
- A watchdog interval (every 10s) kills FFmpeg and deletes temp files for sessions idle > 60 seconds
- Temp files are written to `temp/hls/{sessionId}/`

---

## EPG Handling

EPG data is fetched from the portal, cached in SQLite (`EpgCache` table, compressed with gzip), and served as XMLTV at `/epg.xml`.

### Fetch strategy

- **On startup:** fetch immediately if cache is missing or stale (>12 hours)
- **Background job:** checks every 30 minutes; only fetches if stale AND server has been idle for >2 minutes
- **On-demand:** `POST /api/v2/refresh-epg`

### Concurrency

Channels are fetched 5 at a time with a yield between batches to avoid memory spikes on large channel lists.

### Storage

EPG XML is gzip-compressed before writing to SQLite, with transparent decompression on read and a fallback for legacy uncompressed entries.

### Title decoding

Xtream portals Base64-encode EPG titles. The server decodes them automatically — with fallback handling for both standard and URL-safe Base64 variants and non-Base64 plain-text titles.

---

## Profiles

Multiple portal configurations can be stored and switched without restarting the server.

- Each profile has its own channels, genres, and EPG cache
- Content overrides (`GenreOverride`, `ContentOverride`) are **global** — shared across all profiles
- Only one profile can be active at a time
- Switching profiles stops the current provider, clears in-memory cache, reinitializes the provider with new credentials, and broadcasts a config-change event via WebSocket
- Deleting a profile cascades to its channels, genres, and EPG cache

**Profile API:** `GET/POST/PUT/DELETE /api/profiles` and `/api/profiles/{id}/activate`

---

## Live Stream Proxy

### Xtream live streams (`LiveStreamService`)

Two modes controlled per-request via `proxy=0` query param (default is proxy-on based on server config):

**Proxy mode (default):**
- `liveStreamService` fetches the master HLS playlist from the portal, rewrites segment URLs to signed `/player/{id}.ts` paths, and caches the segment map
- Segments are served at `GET /player/{resourceId}.ts` (or handled by `liveStreamService.getSegment`)
- VLC User-Agent is sent on all upstream HLS fetches
- Cache miss on a segment triggers a playlist refresh using the stored subpath

**Non-proxy mode:**
- `serverManager.getProvider().getChannelLink(cmd)` resolves the real CDN URL
- Client receives a `302` redirect directly to the stream

### Stalker live streams (HLS caching)

1. **Master playlist** — resolved from portal command via `cmdPlayerV2` and cached for 30 seconds
2. **Segment map** — `#EXT-X-MEDIA-SEQUENCE` number → relative URL, stored per stream
3. Segments served at `GET /player/{resourceId}.ts` with HMAC-signed URLs
4. On 301/302/403, server auto-refreshes the master URL and updates the cached base URL
5. Concurrent requests for the same stream share a single upstream fetch (pending-promise deduplication)

### Catchup

`GET /live.m3u8?cmd=...&start_time=...&end_time=...` passes timestamps to `cmdPlayerV2`, which forwards them to the portal's catchup endpoint.

---

## TMDB Integration

Set `TMDB_API_READ_TOKEN` to enrich VOD and series metadata with posters and backdrops.

The server strips quality/format tags from titles before searching TMDB:
```
Avatar 4K BluRay  →  search "Avatar"
```

Returns `poster`, `backdrop`, and `overview`. Enriched metadata is merged into Xtream `get_vod_info` and `get_series_info` responses. If TMDB is unavailable or the token is not set, the fields are silently omitted — nothing breaks.

---

## API Reference

### Xtream Codes

| Endpoint | Actions |
|----------|---------|
| `GET /player_api.php` | `get_live_categories`, `get_live_streams`, `get_vod_categories`, `get_vod_streams`, `get_vod_info`, `get_series_categories`, `get_series`, `get_series_info`, `get_short_epg` |
| `GET /live/{user}/{pass}/{id}.m3u8` | Live stream (HLS proxy or redirect) |
| `GET /live/{user}/{pass}/{id}.ts` | Live stream (TS segment proxy or redirect) |
| `GET /movie/{user}/{pass}/{id}.{ext}` | VOD stream (proxy) |
| `GET /series/{user}/{pass}/{id}.{ext}` | Episode stream (proxy) |
| `GET /xmltv.php` | EPG (XMLTV) |
| `GET /{user}/{pass}/{id}` | Legacy redirect (for players omitting `/live/`) |

### HLS Transcode

| Endpoint | Description |
|----------|-------------|
| `GET /api/media/info?url=` | Probe URL — returns duration, audio tracks, subtitles |
| `GET /api/media/hls/master.m3u8?url=` | Master HLS playlist (multi-audio) |
| `GET /api/media/hls/session/{sessionId}/{file}` | Media playlist or `.ts` segment |
| `GET /api/media/subtitle?url=&index=` | Subtitle track extraction |

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
| `DELETE /api/v2/clear-xtream-cache` | Wipe Xtream cache (triggers re-detection of portal type) |
| `POST /api/clear-cache` | Clear active provider in-memory cache |

### Config & Auth

| Endpoint | Description |
|----------|-------------|
| `GET /api/config` | Get server config |
| `POST /api/config` | Update server config |
| `POST /api/auth/admin` | Admin login (returns JWT) |
| `GET /api/v2/get-token` | Get API token (Stalker only) |
| `POST /api/v2/clear-tokens` | Revoke all tokens (Stalker only) |

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
