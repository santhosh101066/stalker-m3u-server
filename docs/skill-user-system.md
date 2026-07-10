# User System — Skill Reference

Covers the user data model, progress tracking, preferences, and admin user management. All implemented in `feature/dual-portal-xtream-support` (commit `54846ea`).

Related: [[skill-auth-system]] for login/tokens.

---

## Models

### User (`src/models/User.ts`)

| Field | Type | Notes |
|-------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `email` | STRING | Unique, normalized to lowercase |
| `name` | STRING | Display name |
| `role` | STRING | `"admin"` or `"user"` |
| `isActive` | BOOLEAN | `false` until admin approves |
| `avatarUrl` | STRING | Google profile picture URL |
| `passwordHash` | STRING | PBKDF2 hash (null for Google-only users) |
| `salt` | STRING | Salt for password hashing |
| `preferences` | JSON | `{ preferredContentType, favorites[], recentChannels[] }` |

`passwordHash` and `salt` are stripped from all API responses — never returned to clients.

### UserProgress (`src/models/UserProgress.ts`)

Tracks per-user, per-profile watch progress.

| Field | Type | Notes |
|-------|------|-------|
| `userId` | INTEGER FK | References User |
| `profileId` | INTEGER | Active ConfigProfile at time of update |
| `mediaId` | STRING | Stream/movie/episode ID |
| `progress` | FLOAT | Playback position (seconds or %) |
| `completed` | BOOLEAN | Whether the item was fully watched |
| `meta` | JSON | Extra data (e.g. episode info) |

Upserted on each progress update (userId + profileId + mediaId is the unique key).

### ContentCache (`src/models/ContentCache.ts`)

Generic response cache keyed by a string hash of query arguments.

| Field | Type | Notes |
|-------|------|-------|
| `cacheKey` | STRING PK | Hash of query args |
| `profileId` | INTEGER | Profile the cache belongs to |
| `response` | JSON | Cached payload |
| `expiresAt` | DATE | TTL timestamp |

Used as a generic API response cache. Check `expiresAt` before serving — expired entries should be refreshed.

---

## User API Routes (`src/routes/user.ts`)

All routes require a valid JWT (any role).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/user/profile` | Returns `{ id, email, name, role, avatarUrl, preferences }` |
| `PUT` | `/api/user/preferences` | Merge-updates `user.preferences` (shallow merge) |
| `GET` | `/api/user/progress` | All progress records for active profile |
| `PUT` | `/api/user/progress` | Upsert progress: `{ mediaId, progress, completed, meta }` |
| `DELETE` | `/api/user/progress/{mediaId}` | Remove one progress record |
| `POST` | `/api/user/clear-history` | Deletes all progress for active profile + clears `recentChannels` |

Progress is **profile-scoped** — switching active profile shows different history.

---

## Admin User Management Routes (`src/routes/userManagement.ts`)

All routes require `role === "admin"`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/users` | List all users (ordered by createdAt DESC) |
| `POST` | `/api/admin/users` | Create user: `{ email, name, role, isActive, password? }` |
| `PUT` | `/api/admin/users/{id}` | Update user — activating triggers approval email |
| `DELETE` | `/api/admin/users/{id}` | Delete user (cannot delete self) |

### Self-protection guards (PUT)
- Cannot set `isActive: false` on own account
- Cannot change own `role` away from `admin`

### Approval email trigger
When `PUT /api/admin/users/{id}` flips a user from `isActive: false` → `true`, `sendUserApprovedEmail` fires asynchronously (errors are logged, not surfaced to the caller).

---

## Preferences Structure

```json
{
  "preferredContentType": "movie",
  "favorites": [],
  "recentChannels": []
}
```

`PUT /api/user/preferences` shallow-merges, so sending `{ "preferredContentType": "series" }` only updates that field. Sequelize requires `user.changed("preferences", true)` after mutating a JSON column — already handled in the route.

---

## Key Files

- `src/models/User.ts`
- `src/models/UserProgress.ts`
- `src/models/ContentCache.ts`
- `src/routes/user.ts`
- `src/routes/userManagement.ts`