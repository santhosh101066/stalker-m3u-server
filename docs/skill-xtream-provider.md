# Xtream Provider — Skill Reference

Covers `XtreamClient`, `XtreamCache`, dual-portal detection, category versioning, stream token substitution, and the Xtream Codes API routes. Key commits: `0d5cfbe`, `1bf9fe8`, `3dda72c`, `584ae8c`.

Related: [[skill-stalker-provider]], [[skill-m3u-playlist]], [[skill-auth-system]]

---

## XtreamClient (`src/utils/xtream-client.ts`)

Implements `IProvider`. Connects to any Xtream Codes-compatible portal via `player_api.php`.

### Constructor
Reads from `initialConfig`: `hostname`, `port`, `https`, `username`, `password`. Credentials come from the active `ConfigProfile` in DB, not from env vars.

### Request pipeline
1. Build cache key from sorted params (deterministic)
2. Check `NodeCache` (in-memory, 6h TTL) — return immediately on hit
3. Deduplicate in-flight: if same request is pending, return the existing promise (`inFlight` Map)
4. Circuit breaker check — if OPEN, immediately throws (avoids hammering a failing portal)
5. Fire `axios.get` to `player_api.php` with `VLC/3.0.16` User-Agent (maximizes portal compatibility)
6. On success: `breaker.recordSuccess()` + cache result; on failure: `breaker.recordFailure()` + clean up `inFlight`

### Key methods

| Method | Portal action | Notes |
|--------|--------------|-------|
| `getChannelGroups()` | `get_live_categories` | Maps to `Genre[]` |
| `getChannels()` | `get_live_streams` | Maps to `Channel[]`; cmd = `/live/{u}/{p}/{id}.m3u8` |
| `getChannelLink(cmd)` | — | Returns cmd as-is (redirect handled by live route) |
| `getEPG(channelId)` | `get_short_epg` | Decodes Base64 titles |
| `getMovies({ category, page })` | `get_vod_streams` | Paginated |
| `getMovieInfo(id)` | `get_vod_info` | Returns metadata + stream URL |
| `getSeries({ category })` | `get_series` or `get_vod_streams` depending on portal type |
| `getSeriesInfo(id)` | `get_series_info` | Seasons + episodes |
| `clearCache()` | — | Flushes `NodeCache` in-memory |

### EPG title decoding
Xtream portals Base64-encode EPG titles. `decodeBase64Safe` and `decodeBase64Title` handle both standard and URL-safe variants, with a plain-text fallback.

---

## XtreamCache (`src/models/XtreamCache.ts` + `src/routes/xtream.ts`)

SQLite-backed persistent cache. TTL = **24 hours** (`TTL_MS`).

### Cache object (exported from `src/routes/xtream.ts`)

```ts
xtreamCache.get<T>(key)           // Returns value or undefined
xtreamCache.getWithStaleness<T>(key)  // Returns { value, isStale }
xtreamCache.set(key, value)       // Upserts with 24h TTL
xtreamCache.delete(key)
```

### Cache key patterns

| Key | Contents |
|-----|---------|
| `vod_streams_{category_id}` | Movie list for a genre |
| `series_list_{category_id}` | Series list for a genre |
| `series_info_{series_id}` | Seasons and episodes |
| `vod_info_{stream_id}` | Movie metadata |
| `vod_cmd_{stream_id}` | Movie playback command |
| `ep_info_{episode_id}` | Episode metadata |
| `ep_cmd_{episode_id}` | Episode playback command |
| `portal_series_source` | `"native"` or `"mixed"` |

Wipe all entries via `DELETE /api/v2/clear-xtream-cache` — forces re-detection of portal type.

---

## Dual Portal Detection

Two portal layouts are auto-detected on first series warm:

**Type 1 — Mixed portal**
- Movies and series share `get_vod_streams`
- Items with `{SERIES_FLAG} == 1` are series; env var `SERIES_FLAG` overrides the field name
- `portal_series_source` cached as `"mixed"`

**Type 2 — Native series portal**
- Separate `get_series` / `get_series_categories` API
- `get_vod_streams` returns movies only
- `portal_series_source` cached as `"native"`

Detection is triggered by `warmSeriesCache()` and written to `XtreamCache`. Clearing the cache forces re-detection.

---

## Category Versioning

**Problem:** Free IPTV players (TiviMate free, etc.) cache category contents and only re-fetch when they see a new category ID.

**Solution:** When `VOD_CATEGORY_VERSIONING=true`, a Unix timestamp is appended to every VOD/series category ID in Xtream API responses:
```
"42"  →  "42_v1719234567890"
```

`bumpVodVersion()` writes a new timestamp to `SystemConfig` key `vod_cat_version`. The `addVer(id, v)` helper appends it; `stripVer(id)` removes it before cache lookups.

Version bumps are triggered by:
- New content found during warm cycles
- Category reorder
- Item moved to different category
- Server startup

---

## Xtream API Route (`src/routes/xtream.ts`)

Exposes Xtream Codes-compatible endpoints so any player expecting Xtream format works:

| Endpoint | Action params supported |
|----------|------------------------|
| `GET /player_api.php` | `get_live_categories`, `get_live_streams`, `get_vod_categories`, `get_vod_streams`, `get_vod_info`, `get_series_categories`, `get_series`, `get_series_info`, `get_short_epg` |
| `GET /live/{u}/{p}/{id}.m3u8` | Live stream (HLS proxy or redirect) |
| `GET /live/{u}/{p}/{id}.ts` | Live TS segment |
| `GET /movie/{u}/{p}/{id}.{ext}` | VOD stream proxy |
| `GET /series/{u}/{p}/{id}.{ext}` | Episode stream proxy |
| `GET /xmltv.php` | EPG (XMLTV format) |

Override layer (`applyXtreamCatOverrides`, `applyVodOverrides`, `applySeriesOverrides`) is applied transparently to every Xtream response before returning to the player.

---

## Stream Token Substitution

Xtream stream URLs carry `{username}/{password}` in the path. Sending the real password in every URL is a security risk (logs, proxies, player analytics).

**Fix:** When a player authenticates via `GET /player_api.php?action=player_api.php`, the `user_info.password` in the response is a **30-day JWT stream token** (`{ sub: userId, scope: "stream" }`) instead of the real password. Players cache this value and use it in all subsequent `/live/{user}/{token}/...` URLs.

`resolveXtreamUser()` accepts either:
- Real password (existing DB hash check)
- Valid stream token (JWT starting with `eyJ`, verified `scope === "stream"`, `sub` → userId lookup)

Env-var-only admin (no numeric DB id) still uses the real password as fallback. Implementation: `generateStreamToken(userId)` in `src/routes/xtream.ts`.

---

## Cache Warming

`warmVodCache()` and `warmSeriesCache()` run in parallel on startup and every 24 hours:
1. Fetch portal pages until a known item is found (incremental — stops early)
2. Insert only new items; bump `vod_cat_version` if new content found
3. Upsert genres from actual content; `cleanupGenres()` removes empty genres

`warmSeriesInfoCache()` pre-fetches all seasons/episodes for every cached series (500ms throttle between series to avoid portal hammering).

### Catchup scan (`POST /api/v2/catchup-scan`)

Use after a long offline period. The incremental warm stops at the first known item, so gaps at the tail are missed. Catchup does full reconciliation per genre:

- **diff > 0** (portal has more): incremental scan from page 1; track `balance = new items found`; stop when `balance >= diff`. Also detects deletions from pages scanned via `seenPortalIds`.
- **diff < 0** (portal has fewer): scan ALL portal pages; build a complete ID set; filter local cache removing any item absent from portal; pick up any newly-added items too.
- **diff = 0**: skip (already in sync).

`fetchAllPages()` accepts an optional `startPage` parameter so already-fetched page 1 data can be reused.

### XtreamCache daily cleanup

A job in `server.ts` runs on startup and every 24h:
```ts
XtreamCache.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } })
```
Expired rows are purged automatically — no manual intervention needed.

---

## Key Files

- `src/utils/xtream-client.ts` — XtreamClient implementation (includes circuit breaker)
- `src/routes/xtream.ts` — XtreamCache object, versioning, API routes, warm functions, stream token generation, catchupScan
- `src/models/XtreamCache.ts` — Sequelize model
- `src/utils/xtream.ts` — Shared Xtream helpers
- `src/utils/circuitBreaker.ts` — Reusable `CircuitBreaker` class (configurable via `CB_*` env vars)