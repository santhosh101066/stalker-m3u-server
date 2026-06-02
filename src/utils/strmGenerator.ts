import fs from "fs";
import path from "path";
import { Op } from "sequelize";
import { initialConfig } from "@/config/server";
import { xtreamCache } from "@/routes/xtream";
import { readGenres } from "@/utils/storage";
import { logger } from "@/utils/logger";
import { StrmMovie } from "@/models/StrmMovie";
import { StrmSeries } from "@/models/StrmSeries";

const MOVIES_PATH = process.env.STRM_MOVIES_PATH;
const SERIES_PATH = process.env.STRM_SERIES_PATH;

// ── Variant / quality / language tag patterns ──────────────────────────────────
const VARIANT_RE =
  /\b(Hindi|Tamil|Telugu|Malayalam|Kannada|Bengali|Punjabi|Marathi|Odia|Gujarati|Assamese|Urdu|Bhojpuri|Sindhi|English|French|Spanish|German|Italian|Portuguese|Russian|Arabic|Chinese|Japanese|Korean|Dual\s*Audio|Dubbed|Multi|TriAudio|4K|UHD|FHD|HD|SD|SDR|HDR|HDRip|HDTV|HDCAM|BluRay|Blu-?Ray|BRRip|WEBRip|WEB-?DL|DVDRip|DVD-?Rip|CAM|HDTS|TS|PDVD|480p|720p|1080p|2160p)\b/gi;

const CHANNEL_PREFIX_RE = /^(Colors(?:\s+(?:Kannada|Tamil|Gujarati|Bangla|Marathi|Odia|Punjabi|Rishtey|Super|Infinity))?|Zee(?:\s+(?:TV|Telugu|Tamil|Kannada|Marathi|Bangla|Cafe|Cinema|News|Anmol|Bollywood|Classic|Action|World))?|Star(?:\s+(?:Plus|Vijay|Jalsha|Pravah|Suvarna|Maa|Utsav|Gold|World|Movies|Sports))?|Sony(?:\s+(?:TV|SAB|Liv|Max|Aath|Rox|Marathi))?|Sun(?:\s+(?:TV|Bangla|Marathi|Neo|Life))?|Gemini(?:\s+(?:TV|Music|Movies))?|Maa(?:\s+(?:TV|Gold|Movies))?|ETV(?:\s+(?:Telugu|Plus|Andhra))?|Life\s+OK|Asianet|Vijay\s*TV|SAB\s*TV|Rishtey|Big\s+Magic|Aaj\s+Tak|Republic\s*TV|NDTV|CNN|BBC|Discovery|National\s+Geographic|Nat\s+Geo)\s*/i;

function normalize(name: string): string {
  return name
    .replace(CHANNEL_PREFIX_RE, "")
    .replace(VARIANT_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractTags(name: string): string[] {
  const tags: string[] = [];
  const ch = name.match(CHANNEL_PREFIX_RE);
  if (ch) tags.push(ch[0].trim());
  name.replace(VARIANT_RE, (m) => { tags.push(m.trim()); return ""; });
  return tags;
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\.+$/, "").trim();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function extractYear(str: string): string {
  const m = String(str || "").match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

function portalBase(): string {
  const proto = initialConfig.https ? "https" : "http";
  return `${proto}://${initialConfig.hostname}:${initialConfig.port}`;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const UPSERT_FIELDS = ["canonical_key", "raw_folder", "variant_tags", "folder_path", "file_name", "url", "synced_to_disk"];
const CHUNK = 500; // safe SQLite parameter budget (500 rows × 8 cols = 4 000 params)

async function bulkUpsert(Model: typeof StrmMovie | typeof StrmSeries, rows: any[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await Model.bulkCreate(rows.slice(i, i + CHUNK), { updateOnDuplicate: UPSERT_FIELDS });
  }
}

// ── Public entry point ─────────────────────────────────────────────────────────

export async function generateStrmFiles(): Promise<void> {
  if (!MOVIES_PATH && !SERIES_PATH) return;
  if (MOVIES_PATH) await generateMovies(MOVIES_PATH);
  if (SERIES_PATH) await generateSeries(SERIES_PATH);
}

// ── Movies ─────────────────────────────────────────────────────────────────────

async function generateMovies(outputDir: string): Promise<void> {
  logger.info("[STRM] Movies: starting generation...");
  fs.mkdirSync(outputDir, { recursive: true });

  const base = portalBase();
  const u    = initialConfig.username || "";
  const p    = initialConfig.password || "";

  // ── Phase 1: bulk upsert raw entries (own folder, no merge yet) ──────────────

  const existingRows = await StrmMovie.findAll({ raw: true }) as any[];
  const existingById = new Map<string, typeof existingRows[0]>(existingRows.map((r) => [r.id, r]));

  const genres = await readGenres("movie");
  const seen   = new Set<string>();
  const toUpsert: any[] = [];

  for (const genre of genres) {
    if (!genre.id || genre.id === "*") continue;
    const movies = await xtreamCache.get<any[]>(`vod_streams_${genre.id}`);
    if (!movies) continue;

    for (const movie of movies) {
      const id = String(movie.stream_id);
      if (seen.has(id)) continue;
      seen.add(id);

      const rawName    = sanitize(movie.name || `Movie_${id}`);
      const year       = extractYear(movie.year || movie.added || "");
      const folderName = year ? `${rawName} (${year})` : rawName;
      const tags       = extractTags(folderName);
      const ext        = movie.container_extension || "mp4";
      const url        = `${base}/movie/${u}/${p}/${id}.${ext}`;
      const entryId    = `movie_${id}`;
      const existing   = existingById.get(entryId);

      if (!existing || existing.url !== url) {
        toUpsert.push({
          id:             entryId,
          canonical_key:  normalize(folderName),
          raw_folder:     folderName,
          variant_tags:   tags.length,
          folder_path:    folderName,
          file_name:      `${folderName}.strm`,
          url,
          synced_to_disk: false,
        });
      }
    }
  }

  if (toUpsert.length > 0) await bulkUpsert(StrmMovie, toUpsert);

  // ── Phase 2: merge duplicates in DB ──────────────────────────────────────────

  const allEntries = await StrmMovie.findAll({ raw: true }) as any[];
  const byKey = new Map<string, typeof allEntries>();
  for (const e of allEntries) {
    const group = byKey.get(e.canonical_key) ?? [];
    group.push(e);
    byKey.set(e.canonical_key, group);
  }

  for (const [, group] of byKey) {
    if (group.length <= 1) continue;

    group.sort((a: any, b: any) =>
      a.variant_tags - b.variant_tags || a.raw_folder.localeCompare(b.raw_folder)
    );
    const primary     = group[0];
    const secondaries = group.slice(1);

    for (const sec of secondaries) {
      const tags       = extractTags(sec.raw_folder);
      const label      = tags.length > 0 ? tags.join(" ") : sec.raw_folder;
      const mergedFile = `${sec.raw_folder} [${label}].strm`;

      if (sec.folder_path !== primary.folder_path || sec.file_name !== mergedFile) {
        await StrmMovie.update(
          { folder_path: primary.folder_path, file_name: mergedFile, synced_to_disk: false },
          { where: { id: sec.id } },
        );
      }
    }
  }

  // ── Phase 3: write unsynced entries to disk ───────────────────────────────────

  const toWrite = await StrmMovie.findAll({ where: { synced_to_disk: false }, raw: true }) as any[];

  if (toWrite.length === 0) {
    logger.info("[STRM] Movies: nothing to write");
    return;
  }

  const written: string[] = [];
  for (const entry of toWrite) {
    try {
      fs.mkdirSync(path.join(outputDir, entry.folder_path), { recursive: true });
      fs.writeFileSync(path.join(outputDir, entry.folder_path, entry.file_name), entry.url, "utf8");
      written.push(entry.id);
    } catch (e: any) {
      logger.error(`[STRM] movie ${entry.file_name}: ${e.message}`);
    }
  }

  for (let i = 0; i < written.length; i += CHUNK) {
    await StrmMovie.update({ synced_to_disk: true }, { where: { id: { [Op.in]: written.slice(i, i + CHUNK) } } });
  }

  logger.info(`[STRM] Movies done — ${written.length} files written`);
}

// ── Series ─────────────────────────────────────────────────────────────────────

async function generateSeries(outputDir: string): Promise<void> {
  logger.info("[STRM] Series: starting generation...");
  fs.mkdirSync(outputDir, { recursive: true });

  const base = portalBase();
  const u    = initialConfig.username || "";
  const p    = initialConfig.password || "";

  // ── Phase 1: bulk upsert raw entries ─────────────────────────────────────────

  const existingRows = await StrmSeries.findAll({ raw: true }) as any[];
  const existingById = new Map<string, typeof existingRows[0]>(existingRows.map((r) => [r.id, r]));

  const genres    = await readGenres("series");
  const seenShows = new Set<number>();
  const toUpsert: any[] = [];

  for (const genre of genres) {
    if (!genre.id || genre.id === "*") continue;
    const seriesList = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
    if (!seriesList) continue;

    for (const series of seriesList) {
      const seriesId = series.series_id as number;
      if (!seriesId || seenShows.has(seriesId)) continue;
      seenShows.add(seriesId);

      try {
        const seriesInfo = await xtreamCache.get<any>(`series_info_${seriesId}`);
        if (!seriesInfo?.episodes) continue;

        const rawName  = sanitize(series.name || `Series_${seriesId}`);
        const year     = extractYear(series.releaseDate || "");
        const showName = year ? `${rawName} (${year})` : rawName;
        const canonicalKey = normalize(showName);
        const variantTags  = extractTags(showName).length;

        for (const [seasonNum, episodes] of Object.entries(seriesInfo.episodes)) {
          const seasonFolder = `Season ${pad(parseInt(seasonNum))}`;
          const folderPath   = `${showName}/${seasonFolder}`;

          for (const ep of episodes as any[]) {
            const epId     = String(ep.id);
            const entryId  = `seriesep_${epId}`;
            const existing = existingById.get(entryId);

            const epNum    = pad(parseInt(String(ep.episode_num || 1)));
            const s        = pad(parseInt(seasonNum));
            const epTitle  = sanitize(ep.title || `Episode ${ep.episode_num}`).slice(0, 80);
            const fileName = `${showName} S${s}E${epNum} - ${epTitle}.strm`;
            const ext      = ep.container_extension || "mp4";
            const url      = `${base}/series/${u}/${p}/${epId}.${ext}`;

            if (!existing || existing.url !== url) {
              toUpsert.push({
                id:             entryId,
                canonical_key:  canonicalKey,
                raw_folder:     showName,
                variant_tags:   variantTags,
                folder_path:    folderPath,
                file_name:      fileName,
                url,
                synced_to_disk: false,
              });
            }
          }
        }
      } catch (e: any) {
        logger.error(`[STRM] series ${series.name}: ${e.message}`);
      }
    }
  }

  if (toUpsert.length > 0) await bulkUpsert(StrmSeries, toUpsert);

  // ── Phase 2: merge duplicate shows in DB ─────────────────────────────────────

  const allEntries = await StrmSeries.findAll({ raw: true }) as any[];

  const showGroups = new Map<string, Set<string>>();
  for (const e of allEntries) {
    const group = showGroups.get(e.canonical_key) ?? new Set();
    group.add(e.raw_folder);
    showGroups.set(e.canonical_key, group);
  }

  const primaryShowByKey = new Map<string, string>();
  for (const [key, shows] of showGroups) {
    if (shows.size <= 1) continue;
    const sorted = [...shows].sort((a, b) => {
      const ta = extractTags(a).length;
      const tb = extractTags(b).length;
      return ta - tb || a.localeCompare(b);
    });
    primaryShowByKey.set(key, sorted[0]);
  }

  for (const e of allEntries) {
    const primaryShow = primaryShowByKey.get(e.canonical_key);
    if (!primaryShow || e.raw_folder === primaryShow) continue;

    const seasonPart   = e.folder_path.split("/").slice(1).join("/");
    const mergedFolder = `${primaryShow}/${seasonPart}`;
    const mergedFile   = e.file_name.replace(e.raw_folder, primaryShow);

    if (e.folder_path !== mergedFolder || e.file_name !== mergedFile) {
      await StrmSeries.update(
        { folder_path: mergedFolder, file_name: mergedFile, synced_to_disk: false },
        { where: { id: e.id } },
      );
    }
  }

  // ── Phase 3: write unsynced entries to disk ───────────────────────────────────

  const toWrite = await StrmSeries.findAll({ where: { synced_to_disk: false }, raw: true }) as any[];

  if (toWrite.length === 0) {
    logger.info("[STRM] Series: nothing to write");
    return;
  }

  const written: string[] = [];
  for (const entry of toWrite) {
    try {
      fs.mkdirSync(path.join(outputDir, entry.folder_path), { recursive: true });
      fs.writeFileSync(path.join(outputDir, entry.folder_path, entry.file_name), entry.url, "utf8");
      written.push(entry.id);
    } catch (e: any) {
      logger.error(`[STRM] episode ${entry.file_name}: ${e.message}`);
    }
  }

  for (let i = 0; i < written.length; i += CHUNK) {
    await StrmSeries.update({ synced_to_disk: true }, { where: { id: { [Op.in]: written.slice(i, i + CHUNK) } } });
  }

  logger.info(`[STRM] Series done — ${written.length} files written`);
}
