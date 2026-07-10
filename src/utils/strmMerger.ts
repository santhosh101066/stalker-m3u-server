import fs from "fs";
import path from "path";
import { logger } from "@/utils/logger";

// Quality and language variant tags — stripped when computing canonical title
const VARIANT_RE =
  /\b(Hindi|Tamil|Telugu|Malayalam|Kannada|Bengali|Punjabi|Marathi|Odia|Gujarati|Assamese|Urdu|Bhojpuri|Sindhi|English|French|Spanish|German|Italian|Portuguese|Russian|Arabic|Chinese|Japanese|Korean|Dual\s*Audio|Dubbed|Multi|TriAudio|4K|UHD|FHD|HD|SD|SDR|HDR|HDRip|HDTV|HDCAM|BluRay|Blu-?Ray|BRRip|WEBRip|WEB-?DL|DVDRip|DVD-?Rip|CAM|HDTS|TS|PDVD|480p|720p|1080p|2160p)\b/gi;

// Indian/international TV channel name prefixes — stripped from the start of series folder names
const CHANNEL_PREFIX_RE = /^(Colors(?:\s+(?:Kannada|Tamil|Gujarati|Bangla|Marathi|Odia|Punjabi|Rishtey|Super|Infinity))?|Zee(?:\s+(?:TV|Telugu|Tamil|Kannada|Marathi|Bangla|Cafe|Cinema|News|Anmol|Bollywood|Classic|Action|World))?|Star(?:\s+(?:Plus|Vijay|Jalsha|Pravah|Suvarna|Maa|Utsav|Gold|World|Movies|Sports))?|Sony(?:\s+(?:TV|SAB|Liv|Max|Aath|Rox|Marathi))?|Sun(?:\s+(?:TV|Bangla|Marathi|Neo|Life))?|Gemini(?:\s+(?:TV|Music|Movies))?|Maa(?:\s+(?:TV|Gold|Movies))?|ETV(?:\s+(?:Telugu|Plus|Andhra))?|Life\s+OK|Asianet|Vijay\s*TV|SAB\s*TV|Rishtey|Big\s+Magic|Aaj\s+Tak|Republic\s*TV|NDTV|CNN|BBC|Discovery|National\s+Geographic|Nat\s+Geo)\s*/i;

function normalize(folderName: string): string {
  return folderName
    .replace(CHANNEL_PREFIX_RE, "")
    .replace(VARIANT_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractTags(folderName: string): string[] {
  const tags: string[] = [];
  const channelMatch = folderName.match(CHANNEL_PREFIX_RE);
  if (channelMatch) tags.push(channelMatch[0].trim());
  folderName.replace(VARIANT_RE, (match) => {
    tags.push(match.trim());
    return "";
  });
  return tags;
}

export async function mergeStrmDuplicates(moviesDir: string): Promise<void> {
  if (!fs.existsSync(moviesDir)) return;

  const entries = fs.readdirSync(moviesDir, { withFileTypes: true }).filter((d) => d.isDirectory());

  const groups = new Map<string, Array<{ folderName: string; folderPath: string; tags: string[] }>>();
  for (const entry of entries) {
    const key = normalize(entry.name);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push({
      folderName: entry.name,
      folderPath: path.join(moviesDir, entry.name),
      tags: extractTags(entry.name),
    });
    groups.set(key, group);
  }

  let mergedFolders = 0;
  let movedFiles = 0;

  for (const [, group] of groups) {
    if (group.length <= 1) continue;

    // Primary = fewest variant tags (cleanest title); tie-break alphabetically
    group.sort((a, b) => a.tags.length - b.tags.length || a.folderName.localeCompare(b.folderName));
    const primary = group[0];
    const secondaries = group.slice(1);

    for (const secondary of secondaries) {
      const label = secondary.tags.length > 0 ? secondary.tags.join(" ") : secondary.folderName;

      const strmFiles = fs.readdirSync(secondary.folderPath).filter((f) => f.endsWith(".strm"));
      for (const file of strmFiles) {
        const src = path.join(secondary.folderPath, file);
        const newName = file.replace(/\.strm$/, ` [${label}].strm`);
        const dest = path.join(primary.folderPath, newName);
        try {
          if (!fs.existsSync(dest)) {
            fs.renameSync(src, dest);
            movedFiles++;
          } else {
            fs.unlinkSync(src);
          }
        } catch (e: any) {
          logger.error(`[STRM Merge] Failed to move ${src}: ${e.message}`);
        }
      }

      // Remove secondary folder if now empty
      try {
        const remaining = fs.readdirSync(secondary.folderPath);
        if (remaining.length === 0) {
          fs.rmdirSync(secondary.folderPath);
          mergedFolders++;
        }
      } catch {}
    }
  }

  if (mergedFolders > 0) {
    logger.info(`[STRM Merge] Movies: merged ${mergedFolders} duplicate folders, moved ${movedFiles} files`);
  }
}

export async function mergeSeriesDuplicates(seriesDir: string): Promise<void> {
  if (!fs.existsSync(seriesDir)) return;

  const entries = fs.readdirSync(seriesDir, { withFileTypes: true }).filter((d) => d.isDirectory());

  const groups = new Map<string, Array<{ folderName: string; folderPath: string; tags: string[] }>>();
  for (const entry of entries) {
    const key = normalize(entry.name);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push({
      folderName: entry.name,
      folderPath: path.join(seriesDir, entry.name),
      tags: extractTags(entry.name),
    });
    groups.set(key, group);
  }

  let mergedFolders = 0;
  let movedFiles = 0;

  for (const [, group] of groups) {
    if (group.length <= 1) continue;

    group.sort((a, b) => a.tags.length - b.tags.length || a.folderName.localeCompare(b.folderName));
    const primary = group[0];
    const secondaries = group.slice(1);

    for (const secondary of secondaries) {
      const label = secondary.tags.length > 0 ? secondary.tags.join(" ") : secondary.folderName;

      const seasonDirs = fs.readdirSync(secondary.folderPath, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const seasonDir of seasonDirs) {
        const srcSeason = path.join(secondary.folderPath, seasonDir.name);
        const destSeason = path.join(primary.folderPath, seasonDir.name);
        fs.mkdirSync(destSeason, { recursive: true });

        const strmFiles = fs.readdirSync(srcSeason).filter((f) => f.endsWith(".strm"));
        for (const file of strmFiles) {
          const src = path.join(srcSeason, file);
          const newName = file.replace(/\.strm$/, ` [${label}].strm`);
          const dest = path.join(destSeason, newName);
          try {
            if (!fs.existsSync(dest)) {
              fs.renameSync(src, dest);
              movedFiles++;
            } else {
              fs.unlinkSync(src);
            }
          } catch (e: any) {
            logger.error(`[STRM Merge] Failed to move ${src}: ${e.message}`);
          }
        }

        try {
          if (fs.readdirSync(srcSeason).length === 0) fs.rmdirSync(srcSeason);
        } catch {}
      }

      try {
        if (fs.readdirSync(secondary.folderPath).length === 0) {
          fs.rmdirSync(secondary.folderPath);
          mergedFolders++;
        }
      } catch {}
    }
  }

  if (mergedFolders > 0) {
    logger.info(`[STRM Merge] Series: merged ${mergedFolders} duplicate show folders, moved ${movedFiles} files`);
  }
}
