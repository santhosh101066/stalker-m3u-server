---
name: feedback-no-db-deletes
description: User does not want direct database delete commands suggested as fixes
metadata:
  type: feedback
---

Do not suggest `sqlite3 database.db "DELETE FROM ..."` commands as fixes or workarounds. Even for cache cleanup or stale data, propose a code-level or API-level solution instead.

**Why:** User finds it dangerous/unwanted to give direct SQL delete commands against the production DB.

**How to apply:** When a cache entry is stale or needs invalidation, suggest triggering the correct API endpoint or code path that handles invalidation, not a raw SQL delete.
