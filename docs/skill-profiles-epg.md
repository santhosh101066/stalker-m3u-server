# Profiles & EPG — Skill Reference

Covers multi-profile support and EPG (Electronic Program Guide) handling.

Related: [[skill-stalker-provider]], [[skill-xtream-provider]], [[skill-database]]

---

## Profiles

Multiple portal configurations stored in `ConfigProfile`. Only one is active at a time.

### What's profile-scoped
- `Channel` and `Genre` DB rows — each row has a `profileId` foreign key
- `EpgCache` — per-profile EPG data
- `UserProgress` — progress is tied to the active profile at time of update

### What's global (not profile-scoped)
- `GenreOverride` and `ContentOverride` — content manager changes apply to all profiles
- `XtreamCache` — shared across profiles (keyed by category/stream ID, not profile)
- `User` and auth data

### Profile switching
1. `POST /api/profiles/{id}/activate`
2. Stops watchdog on current `StalkerAPI` instance
3. Clears in-memory `NodeCache` on current provider
4. Reinitializes `serverManager` provider with new profile credentials
5. Broadcasts `config-change` event via WebSocket — all connected clients re-initialize
6. No server restart needed

### Profile API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/profiles` | List all profiles |
| `POST` | `/api/profiles` | Create profile |
| `GET` | `/api/profiles/{id}` | Get profile |
| `PUT` | `/api/profiles/{id}` | Update profile |
| `DELETE` | `/api/profiles/{id}` | Delete (cascades to channels, genres, EPG) |
| `POST` | `/api/profiles/{id}/activate` | Switch active profile |
| `POST` | `/api/profiles/{id}/enable` | Enable profile |
| `POST` | `/api/profiles/{id}/disable` | Disable profile |

---

## EPG Handling

EPG data for Stalker portals is fetched per-channel, compressed with gzip, and stored in the `EpgCache` table (SQLite). Served as XMLTV at `/epg.xml`.

### Fetch strategy
- **Startup:** fetch immediately if cache is missing or stale (> 12 hours old)
- **Background job:** checks every 30 minutes; only fetches if stale AND server idle > 2 minutes
- **On-demand:** `POST /api/v2/refresh-epg`

### Storage
EPG XML is gzip-compressed before writing to SQLite (`EpgCache.data`). Transparent decompression on read. Legacy uncompressed entries are handled via fallback.

`writeEpgCache()` in `src/utils/storage.ts` always destroys the existing row before inserting — including the `profileId: null` case. This prevents unbounded accumulation on repeated EPG refreshes when no profile is active.

### Daily cleanup
A job in `server.ts` (runs on startup and every 24h) deletes `epg_cache` rows with `updatedAt` older than 7 days:
```ts
EpgCache.destroy({ where: { updatedAt: { [Op.lt]: cutoff } } })
```

### Concurrency
Channels are fetched 5 at a time with a yield between batches to avoid memory spikes on large channel lists.

### Xtream EPG
For Xtream providers, EPG is served via `GET /xmltv.php` using `get_short_epg` from the portal (limit: 24 entries per channel). EPG titles are Base64-decoded automatically.

### Title decoding (Xtream)
Xtream portals Base64-encode EPG titles. `decodeBase64Safe` in `xtream-client.ts` handles:
- Standard Base64
- URL-safe Base64
- Plain-text fallback (non-Base64 strings returned as-is)

### Debug endpoint
`GET /api/v2/debug/epg?id={channelId}` — returns raw EPG data for a channel. Useful for diagnosing missing or malformed EPG entries.

---

## Sync Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/v2/refresh-groups` | Sync live groups |
| `GET /api/v2/refresh-channels` | Sync live channels |
| `GET /api/v2/refresh-movie-groups` | Sync VOD categories + trigger cache warm |
| `GET /api/v2/refresh-series-groups` | Sync series categories + auto-detect portal type |
| `POST /api/v2/refresh-epg` | Refresh EPG |
| `POST /api/refresh/vod` | Refresh VOD M3U playlist |
| `GET /api/refresh/vod/status` | VOD refresh status |

---

## WebSocket Events

`SocketService` emits events to all connected browser clients:

| Event | Trigger |
|-------|---------|
| `config-change` | Profile switched |
| `cache-warming` | Cache warm started |
| `cache-warmed` | Cache warm completed |

Connect at `ws://server:3000/` — the frontend uses this to auto-reload when the active profile changes.

---

## Key Files

- `src/routes/profiles.ts` — Profile CRUD API
- `src/models/ConfigProfile.ts` — Profile Sequelize model
- `src/models/EpgCache.ts` — EPG cache model
- `src/utils/epg.ts` — EPG fetch and cache logic
- `src/services/SocketService.ts` — WebSocket event broadcasting
- `src/serverManager.ts` — Provider lifecycle management