# Database Schema — Skill Reference

SQLite via Sequelize-TypeScript. DB path resolved by `src/db/index.ts`. All models are registered in `sequelize.models` array.

---

## DB Path Resolution

Priority order:
1. `SQLITE_DB_PATH` env var (if points to dir → `{dir}/database.db`; else used as literal path)
2. `./database.db` (if exists)
3. `./database.sqlite` (if exists)
4. Default: `./database.db`

Export: `databasePath` (used by pull-db.sh and diagnostics).

---

## All Models

| Model | Table | Purpose |
|-------|-------|---------|
| `Token` | `tokens` | Stalker auth tokens (restored on startup) |
| `SystemConfig` | `system_config` | Key-value store (playlist cache, vod cache, vod_cat_version) |
| `ConfigProfile` | `config_profiles` | Multi-portal configs (one active at a time) |
| `Channel` | `channels` | Live channels (profile-scoped) |
| `Genre` | `genres` | Channel/VOD/series categories (profile-scoped) |
| `EpgCache` | `epg_cache` | Gzip-compressed XMLTV EPG data |
| `XtreamCache` | `xtream_cache` | Persistent content cache (24h TTL) |
| `GenreOverride` | `genre_overrides` | Category renames, hides, sort order, virtual categories |
| `ContentOverride` | `content_overrides` | Item renames, hides, moves, sort order |
| `StrmMovie` | `strm_movies` | Tracked .strm file paths for Jellyfin |
| `StrmSeries` | `strm_series` | Tracked .strm series paths |
| `User` | `users` | Auth users (added in `54846ea`) |
| `DeviceCode` | `device_codes` | TV device auth codes (added in `54846ea`) |
| `UserProgress` | `user_progress` | Per-user watch progress (added in `54846ea`) |
| `ContentCache` | `content_cache` | Generic API response cache (added in `d954af5`) |

---

## Key SystemConfig Keys

| Key | Value |
|-----|-------|
| `playlist_cache` | Last-built live M3U string |
| `vod_cache` | Last-built VOD M3U string |
| `vod_cat_version` | Unix timestamp — bumped when new VOD content found |

---

## Override Tables Detail

### GenreOverride

| Field | Type | Purpose |
|-------|------|---------|
| `genre_key` | STRING PK | `{type}_{id}` e.g. `movie_42` |
| `display_name` | STRING | Renamed title (null = no rename) |
| `hidden` | BOOLEAN | Exclude from responses |
| `sort_order` | INTEGER | Custom position (null = original order) |
| `virtual` | BOOLEAN | User-created category |
| `virtual_title` | STRING | Name of virtual category |

### ContentOverride

| Field | Type | Purpose |
|-------|------|---------|
| `item_key` | STRING PK | `{type}_{id}` e.g. `movie_12345` |
| `item_type` | STRING | `movie`, `series`, or `channel` |
| `display_name` | STRING | Renamed title |
| `hidden` | BOOLEAN | Exclude from responses |
| `target_category_id` | STRING | Category to move item into |
| `original_category_id` | STRING | Source category (saved for restore) |
| `sort_order` | INTEGER | Custom position within category |

Virtual categories have IDs prefixed `vcat_`. The Xtream response normalizes `vcat_*` → bare ID before any portal call.

---

## Migrations (inline in `initDB`)

`src/db/index.ts` contains two inline migrations run before `sync()`:

1. **`content_cache` table** — if PK is not `cacheKey`, drop and recreate (added in `d954af5`)
2. **`user_progress` table** — if `profileId` column is missing, drop and recreate (added in `54846ea`)

After migrations: `sequelize.sync({ alter: true })` adds any missing columns non-destructively.

---

## Key Files

- `src/db/index.ts` — Sequelize setup, model registration, `initDB()`, migrations
- `src/models/` — All model files
- `SQLITE_DB_PATH` env var — override DB location (useful for Docker volumes)