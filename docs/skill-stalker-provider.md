# Stalker Provider — Skill Reference

Covers `StalkerAPI`, token management, watchdog keep-alive, caching strategy, and Stalker-specific routes. Key commits: `3dda72c`, `0d5cfbe`, `79f33b5`.

Related: [[skill-xtream-provider]], [[skill-m3u-playlist]]

---

## StalkerAPI (`src/utils/stalker.ts`)

Implements `IProvider`. Connects to a Stalker Middleware portal using STB emulation (MAC address + token auth). All portal calls go through `load.php` (or `portal.php` depending on `contextPath`).

### Configuration (env vars)

| Variable | Default | Purpose |
|----------|---------|---------|
| `STALKER_HOST` | — | Portal hostname |
| `STALKER_PORT` | `80` | Portal port |
| `STALKER_HTTPS` | `false` | Use HTTPS |
| `STALKER_PATH` | `stalker_portal` | Context path prefix |
| `STALKER_MAC` | `00:1A:79:00:00:00` | MAC address for STB emulation |
| `STALKER_STB` | `MAG254` | STB type sent in headers |

### Token management
- Token is fetched via `getToken()` and cached in `NodeCache` under `"auth_token"` (1h TTL)
- On startup, `loadTokenFromDB()` restores the last valid token from the `Token` table to avoid a cold-start refetch
- Token refresh is protected by `profileRefreshPromise` — concurrent callers share one in-flight refresh
- `isProfileFetching` flag prevents re-entrant fetches

### Watchdog
Stalker portals require periodic keep-alive signals (`type=watchdog, action=get_events`) or they drop the session.

```
startWatchdog(interval = 30)  →  runs every 30 seconds
stopWatchdog()                →  called on provider teardown / profile switch
```

Watchdog sends `cur_play_type=1` and `event_active_id={activeChannelId}`. Call `setActiveChannel(id)` whenever the user starts watching a channel so the portal knows what's playing.

### Circuit breaker

`StalkerAPI.makeRequest()` uses a `CircuitBreaker` instance (`src/utils/circuitBreaker.ts`). Opens after `CB_FAILURE_THRESHOLD` failures (default 5) within `CB_FAILURE_WINDOW_MS` (default 60s); cooldown is `CB_COOLDOWN_MS` (default 30s). Auth errors (401/403) do **not** count as failures — only network/timeout errors do.

### Caching strategy

Requests are cached in-memory with `NodeCache`:

| Action | TTL |
|--------|-----|
| `get_genres`, `get_categories`, `get_all_channels` | 6 hours (21600s) |
| `get_ordered_list`, `get_epg`, `get_short_epg` | 10 minutes (600s) |
| Default | 10 minutes |

Cache key excludes `token`, `timestamp`, `api_signature` (volatile fields) so equivalent requests share a cache entry. In-flight deduplication: `inFlight` Map prevents duplicate upstream calls for identical requests.

Concurrency: `pLimit(5)` limits simultaneous upstream requests to 5.

### URL construction

```
Base URL: http://{STALKER_HOST}:{STALKER_PORT}/{STALKER_PATH}
PHP URL:  /server/load.php  (or /portal.php if no contextPath)
```

---

## StalkerV2 Route (`src/routes/stalkerV2.ts`)

Internal browse API consumed by the web UI and M3U generation. Not Stalker-protocol — uses `/api/v2/*` paths.

Key features added in this branch:
- **Portal URL parameter support** (commit `79f33b5`): `?portal=` param overrides the active portal temporarily, allowing multi-portal requests without switching profiles
- **Profile-based data isolation** (commit `eddd29e`): all DB reads scoped to the active `ConfigProfile.id`
- **VOD series logic refinement**: respects `SERIES_FLAG` env var for mixed portals

### Key endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/groups` | Live channel groups |
| `GET /api/v2/channels` | Live channels (profile-scoped) |
| `GET /api/v2/movie-groups` | VOD categories |
| `GET /api/v2/movies` | Movies (paginated) |
| `GET /api/v2/series-groups` | Series categories |
| `GET /api/v2/series` | Series list |
| `GET /api/v2/channel-link` | Resolve live stream URL |
| `GET /api/v2/movie-link` | Resolve VOD/episode URL |
| `GET /api/v2/epg` | EPG for a channel |
| `GET /api/v2/expiry` | Portal subscription expiry |

---

## cmdPlayerV2 (`src/utils/cmdPlayer.ts`)

Resolves a Stalker `cmd` string (e.g. `ffmpeg http://...`) to a real stream URL by calling the portal's `get_link` action. Also handles catchup by passing `start_time` and `end_time` params.

---

## Live Playlist & Stream

`GET /m3u` — returns the live M3U playlist (Stalker channels only).

Live stream via `GET /live.m3u8?cmd=...&id=...`:
1. Resolves `cmd` via `cmdPlayerV2`
2. Fetches master HLS playlist from portal, rewrites segment URLs to signed `/player/{id}.ts` paths
3. Segment cache maps sequence number → relative URL per stream
4. On 301/302/403, auto-refreshes master URL and updates cached base URL
5. Concurrent requests for the same stream share one upstream fetch

---

## Provider Switching

Switching the active profile:
1. Calls `stopWatchdog()` on the current `StalkerAPI` instance
2. Clears in-memory `NodeCache`
3. Reinitializes the provider (new credentials)
4. Broadcasts `config-change` event via WebSocket (all connected clients re-initialize)

No server restart needed.

---

## Key Files

- `src/utils/stalker.ts` — StalkerAPI class (includes circuit breaker)
- `src/routes/stalkerV2.ts` — Browse API
- `src/utils/cmdPlayer.ts` — Stream URL resolution
- `src/serverManager.ts` — Provider lifecycle (init, switch, teardown)
- `src/services/LiveStreamService.ts` — HLS proxy for live streams
- `src/utils/circuitBreaker.ts` — Reusable `CircuitBreaker` class (configurable via `CB_*` env vars)