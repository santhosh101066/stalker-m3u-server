import axios from "axios";
import { tmdbApiToken } from "@/config/server";

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG_BASE  = "https://image.tmdb.org/t/p";

// Strip common quality/release-format suffixes from portal titles before searching
const QUALITY_RE = /\b(4K|UHD|HDCam|HDCAM|HD-?Cam|HDRip|HD-?Rip|BluRay|Blu-?Ray|BRRip|WEBRip|WEB-?DL|DVDRip|DVD-?Rip|HDTS|HDTC|CAM|TS|PDVD)\b[\s.]*/gi;

function cleanTitle(name: string): string {
  return name.replace(QUALITY_RE, "").replace(/\s+/g, " ").trim();
}

async function tmdbGet(path: string): Promise<any | null> {
  if (!tmdbApiToken) return null;
  try {
    const { data } = await axios.get(`${TMDB_BASE}${path}`, {
      headers: { Authorization: `Bearer ${tmdbApiToken}` },
      timeout: 5000,
    });
    return data;
  } catch {
    return null;
  }
}

export interface TmdbMeta {
  poster: string | null;
  backdrop: string | null;
  overview: string | null;
}

function buildMeta(r: any): TmdbMeta {
  return {
    poster:   r.poster_path   ? `${IMG_BASE}/w500${r.poster_path}`        : null,
    backdrop: r.backdrop_path ? `${IMG_BASE}/original${r.backdrop_path}`  : null,
    overview: r.overview || null,
  };
}

export async function fetchMovieMeta(name: string, year?: string): Promise<TmdbMeta | null> {
  const q = encodeURIComponent(cleanTitle(name));
  if (year) {
    const data = await tmdbGet(`/search/movie?query=${q}&year=${year}&language=en-US`);
    const r = data?.results?.[0];
    if (r) return buildMeta(r);
  }
  const data = await tmdbGet(`/search/movie?query=${q}&language=en-US`);
  const r = data?.results?.[0];
  return r ? buildMeta(r) : null;
}

export async function fetchTVMeta(name: string, year?: string): Promise<TmdbMeta | null> {
  const q = encodeURIComponent(cleanTitle(name));
  if (year) {
    const data = await tmdbGet(`/search/tv?query=${q}&first_air_date_year=${year}&language=en-US`);
    const r = data?.results?.[0];
    if (r) return buildMeta(r);
  }
  const data = await tmdbGet(`/search/tv?query=${q}&language=en-US`);
  const r = data?.results?.[0];
  return r ? buildMeta(r) : null;
}
