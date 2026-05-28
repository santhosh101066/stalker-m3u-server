import { ServerRoute } from "@hapi/hapi";
import { spawn, exec, ChildProcess } from "child_process";
import { promisify } from "util";
import NodeCache from "node-cache";
import { logger } from "@/utils/logger";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const execAsync = promisify(exec);

// Cache ffprobe metadata for 6 hours
const metadataCache = new NodeCache({ stdTTL: 21600, checkperiod: 600 });

const SEGMENT_DURATION = 6; // seconds per HLS segment

interface MediaTrack {
  index: number;
  codec_name: string;
  codec_type: string;
  language?: string;
  title?: string;
}

interface MediaMetadata {
  duration: number;
  audio: MediaTrack[];
  subtitles: MediaTrack[];
}

interface HLSSession {
  url: string;
  process: ChildProcess | null;
  /** The absolute segment index FFmpeg started writing from */
  currentStartNumber: number;
  /** Segment index this restart is heading towards (for race-guard decisions) */
  restartTargetSeg: number;
  lastAccess: number;
  metadata: MediaMetadata;
  /** Guards against parallel seek-restart races */
  isRestarting: boolean;
  /** Timestamp of the last successful seek restart (for debounce) */
  lastSeekTime?: number;
  /** The last requested video segment index */
  lastRequestedSeg?: number;
}

const activeSessions = new Map<string, HLSSession>();

// Watchdog — clean up idle sessions every 10s
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions.entries()) {
    if (now - session.lastAccess > 60_000) {
      logger.info(`[HLS] Session ${sessionId} idle — cleaning up`);
      if (session.process && !session.process.killed) session.process.kill("SIGKILL");
      const dir = path.join(process.cwd(), "temp", "hls", sessionId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      activeSessions.delete(sessionId);
    }
  }
}, 10_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assertHttpUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error("Only http/https URLs are allowed");
  return u;
}

async function probeMetadata(url: string): Promise<MediaMetadata> {
  const cached = metadataCache.get<MediaMetadata>(url);
  if (cached) return cached;

  logger.info(`[HLS] Probing: ${url}`);
  const cmd = `ffprobe -user_agent "VLC/3.0.16 LibVLC/3.0.16" -probesize 5000000 -analyzeduration 2000000 -v quiet -print_format json -show_format -show_streams "${url}"`;
  const { stdout } = await execAsync(cmd, { timeout: 15_000 });
  const data = JSON.parse(stdout);

  const duration = parseFloat(data.format?.duration || "0");
  const audio: MediaTrack[] = [];
  const subtitles: MediaTrack[] = [];

  (data.streams || []).forEach((s: any) => {
    const t: MediaTrack = {
      index: s.index,
      codec_name: s.codec_name || "",
      codec_type: s.codec_type || "",
      language: s.tags?.language || s.tags?.LANGUAGE,
      title: s.tags?.title || s.tags?.TITLE || s.tags?.name || s.tags?.NAME,
    };
    if (t.codec_type === "audio") audio.push(t);
    else if (t.codec_type === "subtitle") subtitles.push(t);
  });

  const meta: MediaMetadata = { duration, audio, subtitles };
  metadataCache.set(url, meta);
  return meta;
}

function getLanguageName(code?: string): string {
  if (!code) return "Unknown";
  const n = code.toLowerCase().trim();
  const map: Record<string, string> = {
    eng: "English", en: "English",
    fre: "French", fra: "French", fr: "French",
    ger: "German", deu: "German", de: "German",
    spa: "Spanish", es: "Spanish",
    ita: "Italian", it: "Italian",
    rus: "Russian", ru: "Russian",
    chi: "Chinese", zho: "Chinese", zh: "Chinese",
    jpn: "Japanese", ja: "Japanese",
    kor: "Korean", ko: "Korean",
    hin: "Hindi", hi: "Hindi",
    tam: "Tamil", ta: "Tamil",
    tel: "Telugu", te: "Telugu",
    kan: "Kannada", kn: "Kannada",
    mal: "Malayalam", ml: "Malayalam",
    ara: "Arabic", ar: "Arabic",
    por: "Portuguese", pt: "Portuguese",
    tur: "Turkish", tr: "Turkish",
    dut: "Dutch", nld: "Dutch", nl: "Dutch",
    swe: "Swedish", sv: "Swedish",
    nor: "Norwegian", no: "Norwegian",
    dan: "Danish", da: "Danish",
    fin: "Finnish", fi: "Finnish",
    pol: "Polish", pl: "Polish",
    ukr: "Ukrainian", uk: "Ukrainian",
    ben: "Bengali", bn: "Bengali",
    pan: "Punjabi", pa: "Punjabi",
  };
  return map[n] || n.toUpperCase();
}

// ─── Master playlist (written once per session) ───────────────────────────────

function buildMasterPlaylist(metadata: MediaMetadata): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  if (metadata.audio.length > 0) {
    metadata.audio.forEach((t, i) => {
      const lang = t.language || "und";
      const langLabel = getLanguageName(t.language);
      const codec = t.codec_name ? ` (${t.codec_name.toUpperCase()})` : "";
      const name = t.title ? `${t.title} [${langLabel}]` : `Audio ${i + 1} [${langLabel}]${codec}`;
      lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${name}",DEFAULT=${i === 0 ? "YES" : "NO"},AUTOSELECT=YES,LANGUAGE="${lang}",URI="playlist_audio_${i}.m3u8"`);
    });
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=10000000,AUDIO="audio"`);
  } else {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=10000000`);
  }
  lines.push("playlist_video.m3u8");
  return lines.join("\n");
}

// ─── Media playlists (regenerated dynamically with correct timestamps) ────────
/**
 * Build a VOD media playlist whose segment URIs encode the exact seek-time
 * in their query-string. This ensures the browser can seek to ANY position
 * without the server needing to pre-compute segment-index offsets.
 *
 * URI format:  seg_<type>_<idx>.ts?start=<seconds>
 *
 * The segment handler reads `start` and restarts FFmpeg at that exact point,
 * so index drift between our math and FFmpeg's keyframe alignment is irrelevant.
 */
function buildMediaPlaylist(
  type: string,   // "video" | "audio_0" | "audio_1" …
  duration: number,
  segDuration: number = SEGMENT_DURATION
): string {
  const count = Math.ceil(duration / segDuration);
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${segDuration + 1}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  for (let i = 0; i < count; i++) {
    const startSec = i * segDuration;
    const isLast = i === count - 1;
    const dur = isLast
      ? (duration - startSec > 0 ? duration - startSec : segDuration)
      : segDuration;
    lines.push(`#EXTINF:${dur.toFixed(3)},`);
    lines.push(`seg_${type}_${i}.ts?start=${startSec.toFixed(3)}`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

// ─── FFmpeg spawner ───────────────────────────────────────────────────────────

function spawnFFmpeg(
  url: string,
  sessionDir: string,
  seekTime: number,
  startNumber: number,
  metadata: MediaMetadata
): ChildProcess {
  logger.info(`[HLS] Spawning FFmpeg  seek=${seekTime}s  startSeg=${startNumber}`);

  const args: string[] = [
    "-user_agent", "VLC/3.0.16 LibVLC/3.0.16",
    "-seekable", "1",
    "-reconnect", "1",
    "-reconnect_on_network_error", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "10",
    "-rw_timeout", "10000000", // 10 seconds socket timeout
    "-probesize", "5000000", // 5MB limit to find moov/SeekHead quickly
    "-analyzeduration", "2000000", // 2s codec extraction limit
    "-fflags", "+genpts",
  ];

  // Input-side seek: fast, keyframe-accurate, corrected below with -avoid_negative_ts
  if (seekTime > 0) args.push("-ss", seekTime.toFixed(3));

  args.push("-i", url);

  // Map video + all audio streams
  args.push("-map", "0:v:0");
  metadata.audio.forEach((_, i) => args.push("-map", `0:a:${i}`));

  // Video: stream copy (zero CPU)
  args.push("-c:v", "copy");

  // Audio: transcode each track to AAC stereo 128k
  metadata.audio.forEach((_, i) => {
    args.push(`-c:a:${i}`, "aac", `-b:a:${i}`, "128k", `-ac:${i}`, "2");
  });

  // Timestamp preservation: copy original timestamps and disable zero-resetting
  args.push("-copyts", "-avoid_negative_ts", "disabled");

  // HLS muxer settings
  args.push(
    "-f", "hls",
    "-hls_time", String(SEGMENT_DURATION),
    "-start_number", String(startNumber),
    "-hls_playlist_type", "vod",
    "-hls_flags", "temp_file+independent_segments",
    // Write FFmpeg's own playlist separately — we serve our pre-built one
    "-hls_segment_filename", path.join(sessionDir, "seg_%v_%d.ts")
  );

  const varStreamMaps = ["v:0,name:video"];
  metadata.audio.forEach((_, i) => varStreamMaps.push(`a:${i},name:audio_${i}`));

  args.push("-var_stream_map", varStreamMaps.join(" "));
  args.push(path.join(sessionDir, "ffmpeg_pl_%v.m3u8")); // private — not served

  const proc = spawn("ffmpeg", args);

  proc.stderr.on("data", (d) => {
    const line = (d as Buffer).toString().trim();
    if (line.includes("Error") || line.includes("error"))
      logger.error(`[HLS FFmpeg] ${line}`);
    else
      logger.debug(`[HLS FFmpeg] ${line}`);
  });
  proc.on("close", (code) => logger.info(`[HLS] FFmpeg exited  code=${code}`));
  proc.on("error", (e) => logger.error(`[HLS] FFmpeg error: ${e.message}`));

  return proc;
}

// ─── Seek / restart helper ────────────────────────────────────────────────────

async function seekSession(
  session: HLSSession,
  sessionId: string,
  segmentIdx: number,
  seekTime: number
): Promise<void> {
  // Start 1 segment before the requested index so that the segment
  // immediately before the seek point is also available. This prevents
  // the case where audio triggers the seek at N and video arrives asking
  // for N-1 (or vice-versa) and gets a 503.
  const preBuffer = Math.max(0, segmentIdx - 1);
  const preSeekTime = preBuffer * SEGMENT_DURATION;

  logger.info(`[HLS] Seek → seg ${segmentIdx}  t=${seekTime}s  startAt=${preBuffer}`);
  session.currentStartNumber = preBuffer;  // set early to gate parallel requests
  session.restartTargetSeg   = segmentIdx;
  session.lastSeekTime       = Date.now();

  if (session.process && !session.process.killed) session.process.kill("SIGKILL");

  const sessionDir = path.join(process.cwd(), "temp", "hls", sessionId);

  // Purge only .ts files — keep playlists and metadata
  try {
    for (const f of await fs.promises.readdir(sessionDir)) {
      if (f.endsWith(".ts"))
        await fs.promises.unlink(path.join(sessionDir, f)).catch(() => {});
    }
  } catch { /* dir may not exist yet */ }

  session.process = spawnFFmpeg(session.url, sessionDir, preSeekTime, preBuffer, session.metadata);
}

// ─── Poll until a file exists (or timeout / process replaced) ────────────────

async function waitForFile(
  filePath: string,
  timeoutMs: number,
  segIdx: number,
  session?: HLSSession,
  expectedStartSeg?: number
): Promise<"ready" | "timeout" | "abandoned"> {
  const intervalMs = 100;
  let elapsed = 0;
  let currentExpected = expectedStartSeg;
  while (elapsed < timeoutMs) {
    if (fs.existsSync(filePath)) return "ready";

    // Early-exit check if the FFmpeg process was replaced
    if (session && currentExpected !== undefined) {
      if (session.currentStartNumber !== currentExpected) {
        // If the new FFmpeg process starts at a position AFTER the requested segment,
        // it will never write this segment. We must abandon.
        if (segIdx < session.currentStartNumber) {
          logger.warn(`[HLS] Early-exit: FFmpeg moved to seg ${session.currentStartNumber} (requested ${segIdx}), abandoning wait`);
          return "abandoned";
        }
        // Otherwise, the new FFmpeg process started at or before the requested segment,
        // so it WILL write it. We update our expected track and continue waiting.
        logger.info(`[HLS] FFmpeg restarted at seg ${session.currentStartNumber} (requested ${segIdx}). Updating wait baseline.`);
        currentExpected = session.currentStartNumber;
      }
    }

    await new Promise(r => setTimeout(r, intervalMs));
    elapsed += intervalMs;
  }
  return "timeout";
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const hlsRoutes: ServerRoute[] = [

  // ── Metadata probe ─────────────────────────────────────────────────────────
  {
    method: "GET",
    path: "/api/media/info",
    handler: async (request, h) => {
      const { url } = request.query as { url?: string };
      if (!url) return h.response({ error: "Missing url" }).code(400);
      try {
        const raw = Buffer.from(url, "base64").toString("utf-8");
        assertHttpUrl(raw);
        return h.response(await probeMetadata(raw));
      } catch (e: any) {
        logger.error(`[HLS] /media/info error: ${e.message}`);
        return h.response({ error: "Probe failed" }).code(500);
      }
    },
  },

  // ── Session initialiser — redirects to static session URL ──────────────────
  {
    method: "GET",
    path: "/api/media/hls/master.m3u8",
    handler: async (request, h) => {
      const { url } = request.query as { url?: string };
      if (!url) return h.response("Missing url").code(400);

      try {
        const raw = Buffer.from(url, "base64").toString("utf-8");
        assertHttpUrl(raw);

        const sessionId = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
        const sessionDir = path.join(process.cwd(), "temp", "hls", sessionId);

        let session = activeSessions.get(sessionId);

        if (!session) {
          const meta = await probeMetadata(raw);
          fs.mkdirSync(sessionDir, { recursive: true });

          // Write master + media playlists
          fs.writeFileSync(path.join(sessionDir, "master.m3u8"), buildMasterPlaylist(meta));
          fs.writeFileSync(path.join(sessionDir, "playlist_video.m3u8"), buildMediaPlaylist("video", meta.duration));
          meta.audio.forEach((_, i) =>
            fs.writeFileSync(path.join(sessionDir, `playlist_audio_${i}.m3u8`), buildMediaPlaylist(`audio_${i}`, meta.duration))
          );

          const proc = spawnFFmpeg(raw, sessionDir, 0, 0, meta);
          session = { url: raw, process: proc, currentStartNumber: 0, restartTargetSeg: 0, lastAccess: Date.now(), metadata: meta, isRestarting: false, lastSeekTime: 0, lastRequestedSeg: 0 };
          activeSessions.set(sessionId, session);

          // Wait up to 10 s for the first video segment
          const ready = await waitForFile(path.join(sessionDir, "seg_video_0.ts"), 10_000, 0);
          logger.info(`[HLS] Session ${sessionId} ready=${ready}`);
        } else {
          session.lastAccess = Date.now();
          const dead = !session.process || session.process.killed || session.process.exitCode !== null || session.process.signalCode !== null;
          if (dead) {
            logger.warn(`[HLS] Session ${sessionId}: process dead — restarting from 0`);
            await seekSession(session, sessionId, 0, 0);
          }
        }

        return h.redirect(`/api/media/hls/session/${sessionId}/master.m3u8`);
      } catch (e: any) {
        logger.error(`[HLS] master.m3u8 error: ${e.message}`);
        return h.response("Failed").code(500);
      }
    },
  },

  // ── Static segment + playlist server with seek-detection ───────────────────
  {
    method: "GET",
    path: "/api/media/hls/session/{sessionId}/{file}",
    handler: async (request, h) => {
      const { sessionId, file } = request.params as { sessionId: string; file: string };
      const sessionDir = path.join(process.cwd(), "temp", "hls", sessionId);

      const session = activeSessions.get(sessionId);
      if (session) session.lastAccess = Date.now();

      // ── Serve playlists immediately ─────────────────────────────────────────
      if (file.endsWith(".m3u8")) {
        const fp = path.join(sessionDir, file);
        if (!fs.existsSync(fp)) return h.response("Not found").code(404);
        return h.file(fp)
          .type("application/vnd.apple.mpegurl")
          .header("Access-Control-Allow-Origin", "*")
          .header("Cache-Control", "no-cache");
      }

      // ── Serve .ts segments ─────────────────────────────────────────────────
      if (file.endsWith(".ts")) {
        // File name: seg_video_42.ts  or  seg_audio_0_42.ts
        // Query-string carries the authoritative seek time: ?start=252.000
        const segMatch = file.match(/seg_(video|audio_\d+)_(\d+)\.ts/);
        if (!segMatch) return h.response("Bad segment name").code(400);

        const segType = segMatch[1];       // "video" | "audio_0" | …
        const segIdx  = parseInt(segMatch[2], 10);

        if (!session) return h.response("Session not found").code(404);

        // Fast-reject requests beyond the total duration of the media file
        const totalSegments = Math.ceil(session.metadata.duration / SEGMENT_DURATION);
        if (segIdx >= totalSegments) {
          logger.info(`[HLS] Out of bounds segment requested segIdx=${segIdx} (total=${totalSegments}). Returning empty 200.`);
          return h.response(Buffer.alloc(0))
            .type("video/mp2t")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-cache");
        }

        // The `start` query param is the ground-truth seek time — set by buildMediaPlaylist
        const startParam = (request.query as any).start;
        const seekTime = startParam !== undefined ? parseFloat(startParam) : segIdx * SEGMENT_DURATION;

        const filePath = path.join(sessionDir, file);

        const isVideo = segType === "video";
        const LOOKAHEAD = 8;
        const LOOKBACK = 4;

        const dead = !session.process || session.process.killed || session.process.exitCode !== null || session.process.signalCode !== null;

        // Find the highest video segment written so far
        const existingFiles = await fs.promises.readdir(sessionDir).catch(() => [] as string[]);
        let maxWritten = session.currentStartNumber;
        for (const f of existingFiles) {
          const m = f.match(/seg_video_(\d+)\.ts/);
          if (m) maxWritten = Math.max(maxWritten, parseInt(m[1], 10));
        }

        // segIdx is behind if it lies before our current active FFmpeg start position.
        const isBehind = segIdx < session.currentStartNumber;

        // Detect backward seek using lastRequestedSeg (only for video requests)
        let isBackwardSeek = false;
        if (isVideo && session.lastRequestedSeg !== undefined) {
          if (segIdx < session.lastRequestedSeg - LOOKBACK) {
            isBackwardSeek = true;
          }
        }

        // Update lastRequestedSeg for video requests
        if (isVideo) {
          session.lastRequestedSeg = segIdx;
        }

        const isAhead  = segIdx > maxWritten + LOOKAHEAD;
        const needsSeek = dead || isBehind || isBackwardSeek || isAhead;

        if (needsSeek) {
          if (session.isRestarting) {
            // A restart is in progress. Only override it if this request is
            // far from the current restart target (user seeked a second time).
            const distFromTarget = Math.abs(segIdx - session.restartTargetSeg);
            if (distFromTarget > LOOKAHEAD) {
              // Apply seek throttle cooldown to new, overridden seek requests
              const now = Date.now();
              const seekCooldown = 1500;
              const timeSinceLastSeek = now - (session.lastSeekTime || 0);
              if (timeSinceLastSeek < seekCooldown) {
                logger.warn(`[HLS] Seek override request for seg ${segIdx} throttled (cooldown: ${timeSinceLastSeek}ms < ${seekCooldown}ms)`);
                return h.response("Segment not ready").code(503);
              }

              logger.info(`[HLS] Override stale restart (target was seg ${session.restartTargetSeg}) → seeking to seg ${segIdx}`);
              await seekSession(session, sessionId, segIdx, seekTime);
            }
            // else: same-ish target — fall through to the polling loop (no cooldown throttle!)
          } else {
            // Apply seek throttle cooldown to new, fresh seek requests
            const now = Date.now();
            const seekCooldown = 1500;
            const timeSinceLastSeek = now - (session.lastSeekTime || 0);
            if (timeSinceLastSeek < seekCooldown) {
              logger.warn(`[HLS] Seek request for seg ${segIdx} throttled (cooldown: ${timeSinceLastSeek}ms < ${seekCooldown}ms)`);
              return h.response("Segment not ready").code(503);
            }

            session.isRestarting = true;
            logger.info(`[HLS] Seek needed  seg=${segIdx}  t=${seekTime}s  dead=${dead}  behind=${isBehind}  backward=${isBackwardSeek}  ahead=${isAhead}`);
            try {
              await seekSession(session, sessionId, segIdx, seekTime);
            } finally {
              session.isRestarting = false;
            }
          }
        }

        // Poll up to 15 s for FFmpeg to write the segment
        // Pass session + the start number at the time of this request so
        // we can bail early if a newer seek replaces the current FFmpeg process.
        const expectedStart = session.currentStartNumber;
        const status = await waitForFile(filePath, 15_000, segIdx, session, expectedStart);

        if (status === "timeout") {
          logger.warn(`[HLS] Timeout waiting for ${file}`);
          return h.response("Segment not ready").code(503);
        } else if (status === "abandoned") {
          // The request was abandoned because a new seek process was spawned.
          // We return an empty 200 instantly so the player receives a successful response
          // and does not trigger error-recovery retries for the old position.
          logger.info(`[HLS] Stale request for ${file} abandoned (FFmpeg moved). Returning empty 200.`);
          return h.response(Buffer.alloc(0))
            .type("video/mp2t")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-cache");
        }

        return h.file(filePath)
          .type("video/mp2t")
          .header("Access-Control-Allow-Origin", "*");
      }

      return h.response("Not found").code(404);
    },
  },

  // ── Subtitle extractor ─────────────────────────────────────────────────────
  {
    method: "GET",
    path: "/api/media/subtitle",
    handler: async (request, h) => {
      const { url, track } = request.query as { url?: string; track?: string };
      if (!url || track === undefined) return h.response("Missing params").code(400);

      try {
        const raw = Buffer.from(url, "base64").toString("utf-8");
        assertHttpUrl(raw);
        const idx = parseInt(track, 10);
        const args = [
          "-user_agent", "VLC/3.0.16 LibVLC/3.0.16",
          "-i", raw,
          "-map", `0:${idx}`,
          "-f", "webvtt",
          "pipe:1",
        ];
        const proc = spawn("ffmpeg", args);
        request.raw.req.on("close", () => { if (!proc.killed) proc.kill("SIGKILL"); });
        proc.stderr.on("data", () => {});
        return h.response(proc.stdout).type("text/vtt").header("Access-Control-Allow-Origin", "*");
      } catch (e: any) {
        logger.error(`[HLS] subtitle error: ${e.message}`);
        return h.response("Failed").code(500);
      }
    },
  },
];
