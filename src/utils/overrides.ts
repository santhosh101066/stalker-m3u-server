import { GenreOverride } from "@/models/GenreOverride";
import { ContentOverride } from "@/models/ContentOverride";
import { GenreType } from "@/models/Genre";

export function genreKey(type: GenreType, id: string): string {
  return `${type}_${id}`;
}

export function contentKey(type: string, id: string | number): string {
  return `${type}_${id}`;
}

async function loadGenreOverrides(keys: string[]): Promise<Map<string, any>> {
  if (keys.length === 0) return new Map();
  const rows = await GenreOverride.findAll({ where: { genre_key: keys }, raw: true });
  return new Map(rows.map((r) => [r.genre_key, r]));
}

async function loadVirtualGenres(type: GenreType): Promise<Array<{ id: string; title: string; sort_order: number | null }>> {
  const prefix = `${type}_`;
  const rows = await GenreOverride.findAll({ where: { virtual: true }, raw: true });
  return rows
    .filter((r) => r.genre_key.startsWith(prefix))
    .map((r) => ({
      id: r.genre_key.slice(prefix.length),
      title: r.virtual_title ?? r.genre_key,
      sort_order: r.sort_order,
    }));
}

async function loadContentOverrides(keys: string[]): Promise<Map<string, any>> {
  if (keys.length === 0) return new Map();
  const rows = await ContentOverride.findAll({ where: { item_key: keys }, raw: true });
  return new Map(rows.map((r) => [r.item_key, r]));
}

function sortByOrder<T>(items: T[], getKey: (item: T) => string, map: Map<string, any>): T[] {
  const hasSortOrder = [...map.values()].some((ov) => ov.sort_order != null);
  if (!hasSortOrder) return items;
  return [...items].sort((a, b) => {
    const aOrder = map.get(getKey(a))?.sort_order ?? Infinity;
    const bOrder = map.get(getKey(b))?.sort_order ?? Infinity;
    return aOrder - bOrder;
  });
}

// Apply to DB genre arrays: { id, title, ... }
export async function applyGenreOverrides(genres: any[], type: GenreType): Promise<any[]> {
  const map = genres.length > 0
    ? await loadGenreOverrides(genres.map((g) => genreKey(type, String(g.id))))
    : new Map();

  let filtered = genres
    .filter((g) => !map.get(genreKey(type, String(g.id)))?.hidden)
    .map((g) => {
      const ov = map.get(genreKey(type, String(g.id)));
      return ov?.display_name ? { ...g, title: ov.display_name } : g;
    });

  const virtuals = await loadVirtualGenres(type);
  const combinedMap = new Map(map);
  for (const v of virtuals) {
    filtered.push({ id: v.id, title: v.title });
    combinedMap.set(genreKey(type, v.id), { sort_order: v.sort_order });
  }

  return sortByOrder(filtered, (g) => genreKey(type, String(g.id)), combinedMap);
}

// Apply to Xtream category arrays: { category_id, category_name, ... }
export async function applyXtreamCatOverrides(cats: any[], type: GenreType): Promise<any[]> {
  const map = cats.length > 0
    ? await loadGenreOverrides(cats.map((c) => genreKey(type, String(c.category_id))))
    : new Map();

  let filtered = cats
    .filter((c) => !map.get(genreKey(type, String(c.category_id)))?.hidden)
    .map((c) => {
      const ov = map.get(genreKey(type, String(c.category_id)));
      return ov?.display_name ? { ...c, category_name: ov.display_name } : c;
    });

  const virtuals = await loadVirtualGenres(type);
  const combinedMap = new Map(map);
  for (const v of virtuals) {
    filtered.push({ category_id: v.id, category_name: v.title, parent_id: 0 });
    combinedMap.set(genreKey(type, v.id), { sort_order: v.sort_order });
  }

  return sortByOrder(filtered, (c) => genreKey(type, String(c.category_id)), combinedMap);
}

// Apply to Xtream VOD arrays: { stream_id, name, category_id, ... }
// categoryId=null means no category context (search / all-streams): apply hide+rename only.
// categoryId=string means category-specific fetch: also handle move-in/move-out logic.
export async function applyVodOverrides(
  items: any[],
  categoryId: string | null,
  getSourceCache?: (catId: string) => Promise<any[]>,
): Promise<any[]> {
  if (items.length === 0 && !categoryId) return items;

  const itemKeys = items.map((i) => contentKey("movie", i.stream_id));
  const overrideMap = await loadContentOverrides(itemKeys);

  let result = items
    .filter((i) => {
      const ov = overrideMap.get(contentKey("movie", i.stream_id));
      if (ov?.hidden) return false;
      // When fetching a specific category, exclude items moved to a different one
      if (categoryId && ov?.target_category_id && ov.target_category_id !== categoryId) return false;
      return true;
    })
    .map((i) => {
      const ov = overrideMap.get(contentKey("movie", i.stream_id));
      if (!ov) return i;
      return {
        ...i,
        name: ov.display_name ?? i.name,
        // Reflect the target category in the item so clients see correct grouping
        category_id: ov.target_category_id ?? i.category_id,
      };
    });

  // For category-specific fetches: pull in items moved INTO this category from elsewhere
  if (categoryId && getSourceCache) {
    const movedIn = await ContentOverride.findAll({
      where: { item_type: "movie", target_category_id: categoryId },
      raw: true,
    });
    const existingIds = new Set(result.map((i) => String(i.stream_id)));

    for (const ov of movedIn) {
      if (!ov.original_category_id) continue;
      if (ov.hidden) continue;
      const streamId = parseInt(ov.item_key.replace("movie_", ""));
      if (existingIds.has(String(streamId))) continue;
      const srcItems = await getSourceCache(ov.original_category_id);
      const srcItem = srcItems.find((i: any) => i.stream_id === streamId);
      if (!srcItem) continue;
      result.push({ ...srcItem, name: ov.display_name ?? srcItem.name, category_id: categoryId });
      overrideMap.set(contentKey("movie", streamId), ov);
    }
  }

  const hasSortOrder = [...overrideMap.values()].some((ov) => ov.sort_order != null);
  if (hasSortOrder) {
    result.sort((a, b) => {
      const aOrder = overrideMap.get(contentKey("movie", a.stream_id))?.sort_order ?? Infinity;
      const bOrder = overrideMap.get(contentKey("movie", b.stream_id))?.sort_order ?? Infinity;
      return aOrder - bOrder;
    });
  }

  return result;
}

// Apply to Xtream Series arrays: { series_id, name, category_id, ... }
// categoryId=null means no category context (search / all-series): apply hide+rename only.
export async function applySeriesOverrides(
  items: any[],
  categoryId: string | null,
  getSourceCache?: (catId: string) => Promise<any[]>,
): Promise<any[]> {
  if (items.length === 0 && !categoryId) return items;

  const itemKeys = items.map((i) => contentKey("series", i.series_id));
  const overrideMap = await loadContentOverrides(itemKeys);

  let result = items
    .filter((i) => {
      const ov = overrideMap.get(contentKey("series", i.series_id));
      if (ov?.hidden) return false;
      if (categoryId && ov?.target_category_id && ov.target_category_id !== categoryId) return false;
      return true;
    })
    .map((i) => {
      const ov = overrideMap.get(contentKey("series", i.series_id));
      if (!ov) return i;
      return {
        ...i,
        name: ov.display_name ?? i.name,
        category_id: ov.target_category_id ?? i.category_id,
      };
    });

  if (categoryId && getSourceCache) {
    const movedIn = await ContentOverride.findAll({
      where: { item_type: "series", target_category_id: categoryId },
      raw: true,
    });
    const existingIds = new Set(result.map((i) => String(i.series_id)));

    for (const ov of movedIn) {
      if (!ov.original_category_id) continue;
      if (ov.hidden) continue;
      const seriesId = parseInt(ov.item_key.replace("series_", ""));
      if (existingIds.has(String(seriesId))) continue;
      const srcItems = await getSourceCache(ov.original_category_id);
      const srcItem = srcItems.find((i: any) => i.series_id === seriesId);
      if (!srcItem) continue;
      result.push({ ...srcItem, name: ov.display_name ?? srcItem.name, category_id: categoryId });
      overrideMap.set(contentKey("series", seriesId), ov);
    }
  }

  const hasSortOrder = [...overrideMap.values()].some((ov) => ov.sort_order != null);
  if (hasSortOrder) {
    result.sort((a, b) => {
      const aOrder = overrideMap.get(contentKey("series", a.series_id))?.sort_order ?? Infinity;
      const bOrder = overrideMap.get(contentKey("series", b.series_id))?.sort_order ?? Infinity;
      return aOrder - bOrder;
    });
  }

  return result;
}

// Apply to Xtream live-stream arrays: { stream_id, name, ... }
export async function applyXtreamChannelOverrides(streams: any[]): Promise<any[]> {
  if (streams.length === 0) return streams;
  const map = await loadContentOverrides(streams.map((s) => contentKey("channel", s.stream_id)));
  return streams
    .filter((s) => !map.get(contentKey("channel", s.stream_id))?.hidden)
    .map((s) => {
      const ov = map.get(contentKey("channel", s.stream_id));
      return ov?.display_name ? { ...s, name: ov.display_name } : s;
    });
}

// Apply to channel DB arrays: { id, name, tv_genre_id, ... }
export async function applyChannelOverrides(channels: any[]): Promise<any[]> {
  if (channels.length === 0) return channels;
  const map = await loadContentOverrides(channels.map((c) => contentKey("channel", c.id)));
  return channels
    .filter((c) => !map.get(contentKey("channel", c.id))?.hidden)
    .map((c) => {
      const ov = map.get(contentKey("channel", c.id));
      if (!ov) return c;
      return {
        ...c,
        name: ov.display_name ?? c.name,
        tv_genre_id: ov.target_category_id ?? c.tv_genre_id,
      };
    });
}

export async function getHiddenGenreIds(type: GenreType): Promise<Set<string>> {
  const prefix = `${type}_`;
  const rows = await GenreOverride.findAll({ where: { hidden: true }, raw: true });
  return new Set(
    rows.filter((r) => r.genre_key.startsWith(prefix)).map((r) => r.genre_key.slice(prefix.length))
  );
}

// Apply to portal item arrays (browser stalkerV2): { id, name, ... }
// categoryId: when provided, filters items moved to a different category and (with getSourceCache) pulls in moved-in items
export async function applyPortalItemOverrides(
  items: any[],
  type: "movie" | "series",
  categoryId?: string | null,
  getSourceCache?: (catId: string) => Promise<any[]>,
): Promise<any[]> {
  if (items.length === 0 && !(categoryId && getSourceCache)) return items;
  const map = items.length > 0
    ? await loadContentOverrides(items.map((i) => contentKey(type, String(parseInt(i.id)))))
    : new Map<string, any>();

  let result = items
    .filter((i) => {
      const ov = map.get(contentKey(type, String(parseInt(i.id))));
      if (ov?.hidden) return false;
      if (categoryId && ov?.target_category_id && ov.target_category_id !== categoryId) return false;
      return true;
    })
    .map((i) => {
      const ov = map.get(contentKey(type, String(parseInt(i.id))));
      return ov?.display_name ? { ...i, name: ov.display_name } : i;
    });

  if (categoryId && getSourceCache) {
    const movedIn = await ContentOverride.findAll({
      where: { item_type: type, target_category_id: categoryId },
      raw: true,
    });
    const existingIds = new Set(result.map((i: any) => String(parseInt(i.id))));
    for (const ov of movedIn) {
      if (ov.hidden) continue;
      const itemId = ov.item_key.replace(`${type}_`, "");
      if (existingIds.has(itemId)) continue;
      if (!ov.original_category_id) continue;
      const srcItems = await getSourceCache(ov.original_category_id);
      const srcItem = type === "movie"
        ? srcItems.find((i: any) => String(i.stream_id) === itemId)
        : srcItems.find((i: any) => String(i.series_id) === itemId);
      if (!srcItem) continue;
      result.push({ ...srcItem, id: itemId, name: ov.display_name ?? srcItem.name });
      map.set(contentKey(type, itemId), ov);
    }
  }

  const hasSortOrder = [...map.values()].some((ov) => ov.sort_order != null);
  if (hasSortOrder) {
    result.sort((a, b) => {
      const aOrder = map.get(contentKey(type, String(parseInt(a.id))))?.sort_order ?? Infinity;
      const bOrder = map.get(contentKey(type, String(parseInt(b.id))))?.sort_order ?? Infinity;
      return aOrder - bOrder;
    });
  }

  return result;
}
