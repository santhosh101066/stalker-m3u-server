import fs from "fs";
import path from "path";
import { initialConfig } from "@/config/server";
import { xtreamCache } from "@/routes/xtream";
import { readGenres } from "@/utils/storage";
import { logger } from "@/utils/logger";
import { mergeStrmDuplicates, mergeSeriesDuplicates } from "@/utils/strmMerger";

const MOVIES_PATH = process.env.STRM_MOVIES_PATH;
const SERIES_PATH = process.env.STRM_SERIES_PATH;

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

export async function generateStrmFiles(): Promise<void> {
  if (!MOVIES_PATH && !SERIES_PATH) return;

  if (MOVIES_PATH) {
    await generateMovies(MOVIES_PATH);
    await mergeStrmDuplicates(MOVIES_PATH);
  }
  if (SERIES_PATH) {
    await generateSeries(SERIES_PATH);
    await mergeSeriesDuplicates(SERIES_PATH);
  }
}

async function generateMovies(outputDir: string): Promise<void> {
  logger.info("[STRM] Generating movie .strm files...");
  fs.mkdirSync(outputDir, { recursive: true });

  const genres = await readGenres("movie");
  const base = portalBase();
  const u = initialConfig.username || "";
  const p = initialConfig.password || "";
  const seen = new Set<string>();
  let count = 0;

  for (const genre of genres) {
    if (!genre.id || genre.id === "*") continue;
    const movies = await xtreamCache.get<any[]>(`vod_streams_${genre.id}`);
    if (!movies) continue;

    for (const movie of movies) {
      const id = String(movie.stream_id);
      if (seen.has(id)) continue;
      seen.add(id);

      try {
        const rawName = sanitize(movie.name || `Movie_${id}`);
        const year = extractYear(movie.year || movie.added || "");
        const folderName = year ? `${rawName} (${year})` : rawName;
        const ext = movie.container_extension || "mp4";
        const url = `${base}/movie/${u}/${p}/${id}.${ext}`;
        const dir = path.join(outputDir, folderName);

        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${folderName}.strm`);
        // Only write if content changed
        if (!fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8") !== url) {
          fs.writeFileSync(filePath, url, "utf8");
          count++;
        }
      } catch (e: any) {
        logger.error(`[STRM] movie ${movie.name}: ${e.message}`);
      }
    }
  }

  logger.info(`[STRM] Movies done — ${count} new/updated .strm files in ${outputDir}`);
}

async function generateSeries(outputDir: string): Promise<void> {
  logger.info("[STRM] Generating series .strm files...");
  fs.mkdirSync(outputDir, { recursive: true });

  const genres = await readGenres("series");
  const base = portalBase();
  const u = initialConfig.username || "";
  const p = initialConfig.password || "";
  const seen = new Set<number>();
  let count = 0;

  for (const genre of genres) {
    if (!genre.id || genre.id === "*") continue;
    const seriesList = await xtreamCache.get<any[]>(`series_list_${genre.id}`);
    if (!seriesList) continue;

    for (const series of seriesList) {
      const seriesId = series.series_id as number;
      if (!seriesId || seen.has(seriesId)) continue;
      seen.add(seriesId);

      try {
        const seriesInfo = await xtreamCache.get<any>(`series_info_${seriesId}`);
        if (!seriesInfo?.episodes) continue;

        const rawName = sanitize(series.name || `Series_${seriesId}`);
        const year = extractYear(series.releaseDate || "");
        const showName = year ? `${rawName} (${year})` : rawName;

        for (const [seasonNum, episodes] of Object.entries(seriesInfo.episodes)) {
          const seasonFolder = `Season ${pad(parseInt(seasonNum))}`;
          const seasonDir = path.join(outputDir, showName, seasonFolder);
          fs.mkdirSync(seasonDir, { recursive: true });

          for (const ep of episodes as any[]) {
            const epNum = pad(parseInt(String(ep.episode_num || 1)));
            const s = pad(parseInt(seasonNum));
            const epTitle = sanitize(ep.title || `Episode ${ep.episode_num}`).slice(0, 80);
            const fileName = `${showName} S${s}E${epNum} - ${epTitle}`;
            const ext = ep.container_extension || "mp4";
            const url = `${base}/series/${u}/${p}/${ep.id}.${ext}`;
            const filePath = path.join(seasonDir, `${fileName}.strm`);

            if (!fs.existsSync(filePath) || fs.readFileSync(filePath, "utf8") !== url) {
              fs.writeFileSync(filePath, url, "utf8");
              count++;
            }
          }
        }
      } catch (e: any) {
        logger.error(`[STRM] series ${series.name}: ${e.message}`);
      }
    }
  }

  logger.info(`[STRM] Series done — ${count} new/updated .strm files in ${outputDir}`);
}
