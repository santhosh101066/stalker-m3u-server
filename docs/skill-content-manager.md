# Content Manager — Skill Reference

The Content Manager is the admin UI and API for customizing how content appears to players — without touching the portal or cache. Access at `http://your-server:3000/contentmanager` (password: `ADMIN_PASSWORD`).

Related: [[skill-database]], [[skill-xtream-provider]], [[skill-m3u-playlist]]

---

## What It Does

All changes are stored in `GenreOverride` and `ContentOverride` tables. The override layer is applied transparently to every Xtream, M3U, and browse API response — the portal cache is never modified.

Three tabs: **Live**, **VOD**, **Series**.

---

## Category Operations

| Action | Effect |
|--------|--------|
| Rename | Override display name (`GenreOverride.display_name`); original preserved in DB |
| Hide | Set `GenreOverride.hidden = true` — excluded from all API responses |
| Reorder | Drag-and-drop or A-Z sort; persists `GenreOverride.sort_order` |
| Reset order | Clears `sort_order` for all genres of a type; restores portal order |
| Create virtual | Adds a new `GenreOverride` with `virtual = true`, `id` prefixed `vcat_` (VOD/Series only) |
| Delete virtual | Removes virtual category; all items moved into it are restored to `original_category_id` |

---

## Item Operations

| Action | Effect |
|--------|--------|
| Rename | `ContentOverride.display_name` |
| Hide | `ContentOverride.hidden = true` |
| Move | Sets `target_category_id` (saves `original_category_id` for restore); moves item in all API responses |
| Reorder | `ContentOverride.sort_order` within category |
| Multi-select | Shift+click for range selection; same operation applied to all selected items |

---

## Move Semantics

When an item is moved:
- `target_category_id` is set (can be a `vcat_*` virtual ID)
- `original_category_id` is saved

When fetching a category:
- Items with `target_category_id = THIS` are appended (moved in)
- Items with `target_category_id ≠ THIS` are excluded (moved out)
- Sort order is applied after merge

Deleting a virtual category: all `ContentOverride` records pointing to it have `target_category_id` cleared, restoring items to `original_category_id`.

---

## Virtual Categories

- IDs prefixed `vcat_` (e.g. `vcat_1234`)
- The Xtream response strips `vcat_` prefix before any portal API call — portal never sees virtual IDs
- VOD M3U builder handles `vcat_*` groups by reading from `ContentOverride` + `XtreamCache` directly (no portal call)
- Items from any regular category can be moved into virtual categories freely

---

## Override Application (how it works in code)

`src/utils/overrides.ts` exports:

| Function | Used by |
|----------|---------|
| `applyGenreOverrides(genres, type)` | M3U live, Xtream category endpoints |
| `applyChannelOverrides(channels)` | M3U live, browse API |
| `applyXtreamCatOverrides(categories, type)` | Xtream `get_vod_categories`, `get_series_categories`, `get_live_categories` |
| `applyXtreamChannelOverrides(channels)` | Xtream `get_live_streams` |
| `applyVodOverrides(movies, categoryId)` | Xtream `get_vod_streams` |
| `applySeriesOverrides(series, categoryId)` | Xtream `get_series` |
| `applyPortalItemOverrides(items, type, categoryId, getCached)` | VOD M3U builder |
| `getHiddenGenreIds(type)` | Used to filter search results |

---

## STRM Generation (Jellyfin Integration)

Triggered from Content Manager UI or `POST /api/admin/strm/generate`.

**Works across providers.** `generateStrmFiles()` reads from `XtreamCache` (global, not profile-scoped) and `readGenres()` without a profileId (returns genres from all profiles). So STRM generation works even when the active provider is Stalker, as long as XtreamCache was previously populated by an Xtream profile.

**Credential fallback:** `STRM_XTREAM_USERNAME` → `ADMIN_EMAIL` → `"admin"` (same for password). By default STRM files use the admin credential — the same one used for web UI and Xtream API. A `logger.warn` is emitted when the active provider is not Xtream and neither `STRM_XTREAM_USERNAME` nor `ADMIN_EMAIL` is set.

**Design decision — STRM is always a shared credential:** `.strm` files are static on disk; the credential is baked into the URL. Any media player (Jellyfin) fetching the file sends those baked-in credentials regardless of which Jellyfin user is watching. Per-user STRM directories are impractical (files multiply per user, Jellyfin library setup per user). Admin credential is the right default — everyone in Jellyfin uses it transparently.

Set `STRM_MOVIES_PATH` and/or `STRM_SERIES_PATH` to a Jellyfin-scannable directory. On every cache warm (or manual trigger), `.strm` files are written pointing to the proxy stream URL. Files are only rewritten if the URL changed.

### Duplicate merging
Portals often list the same movie multiple times with variant tags (language, quality). The generator:
1. Groups by canonical title (stripped of variant tags)
2. Primary copy keeps clean name; duplicates become `Title [Tag].strm` in same folder
3. Empty secondary folders are removed on regeneration

Variant patterns detected: 4K/UHD/FHD/HD, Dual Audio/Dubbed/Multi, Hindi/Tamil/Telugu/Malayalam/Kannada/Bengali/etc., BluRay/WEBRip/WEB-DL/DVDRip/HDRip.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/genres?type=` | List categories with override state |
| `POST` | `/api/admin/genres/{type}` | Create virtual category |
| `PUT` | `/api/admin/genres/{type}/{id}` | Update category (rename/hide/sort) |
| `PUT` | `/api/admin/genres/{type}/reorder` | Bulk-set category sort order |
| `DELETE` | `/api/admin/genres/{type}/{id}` | Remove category override |
| `DELETE` | `/api/admin/genres/{type}/order` | Clear all custom sort order |
| `GET` | `/api/admin/items?type=&category_id=` | List items with override state |
| `PUT` | `/api/admin/items/{type}/{id}` | Update item (rename/hide/move) |
| `PUT` | `/api/admin/items/{type}/{category_id}/reorder` | Bulk-set item sort order |
| `DELETE` | `/api/admin/items/{type}/{id}` | Remove item override |
| `POST` | `/api/admin/strm/generate` | Trigger .strm file generation |

`type` param values: `channel`, `movie`, `series`.

---

## Key Files

- `src/utils/overrides.ts` — all override application functions
- `src/models/GenreOverride.ts`, `src/models/ContentOverride.ts`
- `src/routes/config.ts` — content manager admin API routes