import { cmdPlayerV2 } from "@/utils/cmdPlayer";
import axios, { AxiosError, AxiosResponse } from "axios";
import { ServerRoute } from "@hapi/hapi";
import { http, https } from "follow-redirects";
import { RequestOptions } from "https";
import NodeCache from "node-cache";
import { appConfig, initialConfig } from "@/config/server";
import { ReqRefDefaults, ResponseToolkit } from "@hapi/hapi/lib/types";
import { stalkerApi } from "@/utils/stalker";
import { logger } from "@/utils/logger";
import { spawn, ChildProcess, execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

// ─── HEVC codec detection (cached per cmd for 1 hour) ─────────────────────────

// Server-side HEVC→H.264 transcoding is opt-in (LIVE_TRANSCODE=true). By default
// streams are proxied untouched and the client's hardware decoder handles HEVC.
const LIVE_TRANSCODE_ENABLED = process.env.LIVE_TRANSCODE === "true";

const codecCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

async function detectCodec(cmd: string): Promise<string> {
  const cached = codecCache.get<string>(cmd);
  if (cached !== undefined) return cached;
  try {
    const streamUrl = await cmdPlayerV2(cmd);
    if (!streamUrl) return "";
    logger.info(`[LiveTranscode] Probing codec: ${streamUrl}`);
    const { stdout } = await execFileAsync("ffprobe", [
      "-user_agent", "VLC/3.0.16 LibVLC/3.0.16",
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-select_streams", "v:0",
      "-probesize", "2000000",
      "-analyzeduration", "1000000",
      streamUrl,
    ], { timeout: 12_000 });
    const data = JSON.parse(stdout);
    const codec: string = data.streams?.[0]?.codec_name || "";
    codecCache.set(cmd, codec);
    logger.info(`[LiveTranscode] Detected codec=${codec} for cmd=${cmd}`);
    return codec;
  } catch (e: any) {
    logger.warn(`[LiveTranscode] Probe failed: ${e.message}`);
    codecCache.set(cmd, "");
    return "";
  }
}

// ─── Live transcode sessions ──────────────────────────────────────────────────

interface TranscodeSession {
  process: ChildProcess | null;
  lastAccess: number;
  ready: boolean;
}

const transcodeSessions = new Map<string, TranscodeSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of transcodeSessions.entries()) {
    if (now - session.lastAccess > 60_000) {
      logger.info(`[LiveTranscode] Cleaning up idle session ${id}`);
      if (session.process && !session.process.killed) session.process.kill("SIGKILL");
      const dir = path.join(process.cwd(), "temp", "live-transcode", id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      transcodeSessions.delete(id);
    }
  }
}, 15_000);

async function ensureTranscodeSession(cmd: string): Promise<string | null> {
  const sessionId = crypto.createHash("sha256").update(cmd).digest("hex").slice(0, 16);
  const sessionDir = path.join(process.cwd(), "temp", "live-transcode", sessionId);
  const playlistPath = path.join(sessionDir, "playlist.m3u8");

  let session = transcodeSessions.get(sessionId);
  const dead = !session?.process || session.process.killed ||
    session.process.exitCode !== null || session.process.signalCode !== null;

  if (!session || dead) {
    const streamUrl = await cmdPlayerV2(cmd);
    if (!streamUrl) return null;

    if (session?.process && !session.process.killed) session.process.kill("SIGKILL");
    fs.mkdirSync(sessionDir, { recursive: true });
    try {
      for (const f of fs.readdirSync(sessionDir)) {
        fs.unlinkSync(path.join(sessionDir, f));
      }
    } catch {}

    const proc = spawn("ffmpeg", [
      "-user_agent", "VLC/3.0.16 LibVLC/3.0.16",
      "-reconnect", "1",
      "-reconnect_on_network_error", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-i", streamUrl,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2",
      "-f", "hls",
      "-hls_time", "4",
      "-hls_flags", "delete_segments+omit_endlist",
      "-hls_list_size", "6",
      "-hls_segment_filename", path.join(sessionDir, "%d.ts"),
      playlistPath,
    ]);

    proc.stderr.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line.includes("error") || line.includes("Error"))
        logger.error(`[LiveTranscode:${sessionId}] ${line}`);
    });
    proc.on("close", (code) => logger.info(`[LiveTranscode:${sessionId}] FFmpeg exited code=${code}`));
    proc.on("error", (e) => logger.error(`[LiveTranscode:${sessionId}] Spawn error: ${e.message}`));

    session = { process: proc, lastAccess: Date.now(), ready: false };
    transcodeSessions.set(sessionId, session);

    let waited = 0;
    while (!fs.existsSync(playlistPath) && waited < 15_000) {
      await new Promise(r => setTimeout(r, 300));
      waited += 300;
    }
    session.ready = fs.existsSync(playlistPath);
    logger.info(`[LiveTranscode:${sessionId}] ready=${session.ready} after ${waited}ms`);
  } else {
    session.lastAccess = Date.now();
  }

  return session.ready ? sessionId : null;
}

const SECRET_KEY = appConfig.proxy.secretKey;
const sequenceRegex = /#EXT-X-MEDIA-SEQUENCE:(\d+)/;

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

function generateSignedUrl(resourceId: string): string {
  const sig = require("crypto")
    .createHmac("sha256", SECRET_KEY)
    .update(resourceId)
    .digest("hex");
  return `/player/${encodeURIComponent(resourceId)}.ts?sig=${sig}`;
}

function verifySignedUrl(resourceId: string, sig: string): boolean {
  const expectedSig = require("crypto")
    .createHmac("sha256", SECRET_KEY)
    .update(resourceId)
    .digest("hex");
  return sig === expectedSig;
}

interface CacheRecord {
  baseUrl: string;
  segments: Map<number, string>;
  subpath?: string;
  masterUrl?: string;
}

const cache = new NodeCache({ stdTTL: 30, checkperiod: 10 });

// ── Segment read-ahead ────────────────────────────────────────────────────────
// When a segment is served, the next one is prefetched in the background so the
// browser's next request is answered from memory instead of paying the full
// portal round-trip — the main cause of stutter through the proxy.
const segmentPrefetch = new NodeCache({ stdTTL: 30, checkperiod: 10, useClones: false });

type PrefetchedSegment = { data: Buffer; contentType: string } | undefined;

function prefetchNextSegment(cmd: string, nextSeq: number, record: CacheRecord): void {
  const segPath = record.segments.get(nextSeq);
  if (!segPath) return;
  const key = `${cmd}<_>${nextSeq}`;
  if (segmentPrefetch.has(key)) return;
  const url = new URL(segPath, record.baseUrl).href;
  const promise: Promise<PrefetchedSegment> = axios
    .get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 10_000 })
    .then((res) => ({
      data: Buffer.from(res.data as any),
      contentType: String(res.headers["content-type"] || "video/mp2t"),
    }))
    .catch(() => undefined);
  segmentPrefetch.set(key, promise);
}

const pendingCommands = new Map<string, Promise<void>>();

async function populateCache(cmd: string): Promise<void> {
  if (pendingCommands.has(cmd)) {
    await pendingCommands.get(cmd);
    return;
  }

  const initCache = async () => {
    const masterUrl = await cmdPlayerV2(cmd);
    if (!masterUrl) throw new Error("Stream Not Found");

    const masterRes = await axios.get(masterUrl, {
      headers: { "User-Agent": "VLC/3.0.18" },
      timeout: 5000
    });

    const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);
    const lines = masterRes.data.split("\n");

    let subpath = lines.find(
      (l: string) => l.includes(".m3u8") && !l.startsWith("#"),
    );

    if (!subpath) throw new Error("No Sub-playlist found in Master");

    const subUrl = new URL(subpath, baseUrl).href;
    const mediaRes = await axios.get(subUrl, {
      headers: { "User-Agent": "VLC/3.0.18" },
    });

    const finalBaseUrl = subUrl.substring(0, subUrl.lastIndexOf("/") + 1);

    const seqMatch = mediaRes.data.match(sequenceRegex);
    let currentSeq = seqMatch ? parseInt(seqMatch[1], 10) : 0;

    const segments = new Map<number, string>();
    mediaRes.data.split("\n").forEach((line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;

      segments.set(currentSeq, trimmed);
      currentSeq++;
    });

    logger.info(
      `Successfully cached ${segments.size} segments. Start Seq: ${seqMatch ? seqMatch[1] : 0}`,
    );
    cache.set(cmd, { baseUrl: finalBaseUrl, segments, subpath, masterUrl } as CacheRecord);
  };

  const promise = initCache().finally(() => {
    pendingCommands.delete(cmd);
  });

  pendingCommands.set(cmd, promise);
  await promise;
}

async function handleProxy(cmd: string, play: string | undefined, h: any) {
  try {
    // Optionally auto-detect HEVC and transcode for clients that can't decode it
    if (LIVE_TRANSCODE_ENABLED) {
      const codec = await detectCodec(cmd);
      if (["hevc", "h265"].includes(codec.toLowerCase())) {
        const sessionId = await ensureTranscodeSession(cmd);
        if (!sessionId) return h.response("Transcoder failed to start").code(503);
        const playlist = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\n/live-hls/${sessionId}/playlist.m3u8`;
        return h.response(playlist).type("application/vnd.apple.mpegurl");
      }
    }

    if (!cache.get(cmd)) {
      await populateCache(cmd);
    }
    const record: CacheRecord | undefined = cache.get(cmd);
    if (!record) {
      return h.response("Stream Not Found").code(404);
    }

    const fetchPlaylist = async (url: string, isSubpath: boolean = false) => {
      const res = await axios.get(url, { validateStatus: () => true });

      if (!isSubpath && [301, 302, 403].includes(res.status)) {
        const newMasterUrl = await cmdPlayerV2(cmd);
        logger.info(`Refreshed Master URL: ${newMasterUrl}`);

        if (newMasterUrl) {
          const newBaseUrl = newMasterUrl.substring(
            0,
            newMasterUrl.lastIndexOf("/") + 1,
          );
          if (record) {
            record.baseUrl = newBaseUrl;
            record.masterUrl = newMasterUrl;
            cache.set(cmd, record as CacheRecord);
          }
          return await axios.get(newMasterUrl, { validateStatus: () => true });
        }
      }
      if (res.status < 200 || res.status >= 300 || !res.data) {
        return h
          .response({ error: `Upstream Error ${res.status}` })
          .code(res.status);
      }
      return res;
    };

    if (play === "1" && record.subpath) {
      const subUrl = new URL(record.subpath, record.baseUrl).href;
      let res = await fetchPlaylist(subUrl, true);

      if ((res as any).isBoom) return res;

      if (!res.data || res.status === 403) {
        const newMasterUrl = await cmdPlayerV2(cmd);
        if (!newMasterUrl)
          return h.response({ error: "Stream Not Found" }).code(404);

        const newBaseUrl = newMasterUrl.substring(
          0,
          newMasterUrl.lastIndexOf("/") + 1,
        );
        const refreshedRes = await axios.get(newMasterUrl, {
          validateStatus: () => true,
        });

        if (
          refreshedRes.status < 200 ||
          refreshedRes.status >= 300 ||
          !refreshedRes.data
        ) {
          return h
            .response({ error: `Upstream Error ${refreshedRes.status}` })
            .code(refreshedRes.status);
        }

        record.baseUrl = newBaseUrl;
        record.subpath = (refreshedRes as AxiosResponse).data
          .split("\n")
          .find((line: string) => line.match(".m3u8"));

        if (!record.subpath) {
          return h.response({ error: "No valid subpath found" }).code(404);
        }

        const subUrl = new URL(record.subpath, record.baseUrl).href;
        res = await fetchPlaylist(subUrl, true);
        cache.set(cmd, record as CacheRecord);
      }

      const seqMatch = (res as AxiosResponse).data.match(sequenceRegex);
      let currentSeq = seqMatch ? parseInt(seqMatch[1], 10) : 0;

      const lines = (res as AxiosResponse).data.split("\n");
      const modifiedLines = lines.map((line: string) => {
        if (line.startsWith("#") || line.trim() === "") return line;
        if (line.match(".m3u8")) return line;

        const resourceId = `${cmd}<_>${currentSeq}`;
        record.segments.set(currentSeq, line);
        currentSeq++;

        return generateSignedUrl(resourceId);
      });

      cache.set(cmd, record as CacheRecord);

      return h
        .response(modifiedLines.join("\n"))
        .type("application/vnd.apple.mpegurl");
    } else {
      // Reuse the master URL resolved during populateCache — a second
      // create_link round-trip to the portal doubles startup latency.
      const masterUrl = record.masterUrl || await cmdPlayerV2(cmd);
      if (!masterUrl)
        return h.response({ error: "Stream Not Found" }).code(404);
      const res = await fetchPlaylist(masterUrl);
      if ((res as any).isBoom) return res;

      const seqMatch = (res as AxiosResponse).data.match(sequenceRegex);
      let currentSeq = seqMatch ? parseInt(seqMatch[1], 10) : 0;

      const lines = (res as AxiosResponse).data.split("\n");
      const modifiedLines = lines.map((line: string) => {
        if (line.startsWith("#") || line.trim() === "") return line;

        if (line.match(".m3u8")) {
          record.subpath = line;
          cache.set(cmd, record as CacheRecord);
          return `/live.m3u8?cmd=${encodeURIComponent(cmd)}&play=1&proxy=1`;
        }

        const resourceId = `${cmd}<_>${currentSeq}`;
        record.segments.set(currentSeq, line);
        currentSeq++;

        return generateSignedUrl(resourceId);
      });

      cache.set(cmd, record as CacheRecord);
      return h
        .response(modifiedLines.join("\n"))
        .type("application/vnd.apple.mpegurl");
    }
  } catch (error: any) {
    const message = error.message || String(error);
    logger.error(`Error: ${(error as Error)?.stack ?? error}`);

    if (axios.isAxiosError(error) && error.response) {
      return h
        .response({ error: "Upstream Error" })
        .code(error.response.status);
    }

    if (message.includes("Stream Not Found") || message.includes("404")) {
      return h.response({ error: "Stream Not Found" }).code(404);
    }

    return h.response({ error: "Failed to generate URL" }).code(500);
  }
}

async function handleNonProxy(cmd: string, h: ResponseToolkit<ReqRefDefaults>) {
  try {
    const redirectedUrl = await cmdPlayerV2(cmd);
    if (redirectedUrl) {
      return h.redirect(redirectedUrl).code(302);
    }
    return h.response({ error: "Unable to fetch stream [Non Proxy]" }).code(400);
  } catch (err) {
    logger.error(`Non-proxy error: ${err}`);
    return h.response({ error: "Stream fetch failed" }).code(500);
  }
}

export const liveRoutes: ServerRoute[] = [
  // ── Transcoded live HLS playlist ───────────────────────────────────────────
  {
    method: "GET",
    path: "/live-hls/{sessionId}/playlist.m3u8",
    handler: (request, h) => {
      const { sessionId } = request.params as { sessionId: string };
      const session = transcodeSessions.get(sessionId);
      if (!session) return h.response("Session not found").code(404);
      session.lastAccess = Date.now();
      const playlistPath = path.join(process.cwd(), "temp", "live-transcode", sessionId, "playlist.m3u8");
      if (!fs.existsSync(playlistPath)) return h.response("Playlist not ready").code(503);
      // Rewrite bare segment filenames to full server paths
      let content = fs.readFileSync(playlistPath, "utf-8");
      content = content.replace(/^(\d+\.ts)$/gm, `/live-hls/${sessionId}/$1`);
      return h.response(content)
        .type("application/vnd.apple.mpegurl")
        .header("Cache-Control", "no-cache")
        .header("Access-Control-Allow-Origin", "*");
    },
  },
  // ── Transcoded live HLS segments ───────────────────────────────────────────
  {
    method: "GET",
    path: "/live-hls/{sessionId}/{segment}.ts",
    handler: (request, h) => {
      const { sessionId, segment } = request.params as { sessionId: string; segment: string };
      const session = transcodeSessions.get(sessionId);
      if (!session) return h.response("Session not found").code(404);
      session.lastAccess = Date.now();
      const segPath = path.join(process.cwd(), "temp", "live-transcode", sessionId, `${segment}.ts`);
      if (!fs.existsSync(segPath)) return h.response("Segment not found").code(404);
      return h.file(segPath)
        .type("video/mp2t")
        .header("Cache-Control", "no-cache")
        .header("Access-Control-Allow-Origin", "*");
    },
  },
  {
    method: "GET",
    path: "/live.m3u8",
    handler: async (request, h) => {
      const { cmd, play, id, start_time, end_time, proxy: proxyParam } = request.query as {
        cmd?: string;
        play?: string;
        id?: string;
        start_time?: string;
        end_time?: string;
        proxy?: string;
      };
      if (!cmd) return h.response({ error: "Missing cmd parameter" }).code(400);
      if (id && initialConfig.providerType !== "xtream") {
        stalkerApi.setActiveChannel(id);
      }

      // proxy=1 forces proxying for browsers (they can't follow redirects to the
      // upstream portal — mixed content/CORS); proxy=0 forces a direct redirect.
      // Smart-TV webviews (Tizen/WebOS) are not CORS-bound and decode HLS natively,
      // so they get a direct redirect and stream from the portal without server load.
      const ua = String(request.headers["user-agent"] || "");
      const isSmartTv = /Tizen|SMART-TV|SmartTV|Web0S|WebOS/i.test(ua);
      const forceProxy = proxyParam === "1" && !isSmartTv;

      if (initialConfig.providerType === "xtream") {
        const useProxy = forceProxy || (initialConfig.proxy && proxyParam !== "0");
        if (useProxy) {
          const { liveStreamService } = await import("@/services/LiveStreamService");
          const { subpath } = request.query as { subpath?: string };
          const result = await liveStreamService.getPlaylist(cmd, play, subpath);
          if (typeof result === "string") {
            return h.response(result).type("application/vnd.apple.mpegurl");
          } else {
            return h.response({ error: result.error }).code(result.code);
          }
        } else {
          try {
            const { serverManager } = await import("@/serverManager");
            const redirectedUrl = await serverManager
              .getProvider()
              .getChannelLink(cmd)
              .then((res) => res.js.cmd);
            if (redirectedUrl) {
              return h.redirect(redirectedUrl).code(302);
            }
            return h.response({ error: "Unable to fetch stream [Non Proxy]" }).code(400);
          } catch (err: any) {
            logger.error(`Non-proxy error: ${err.message || err}`);
            return h.response({ error: "Stream fetch failed" }).code(500);
          }
        }
      }

      if (start_time && end_time) {
        try {
          const redirectedUrl = await cmdPlayerV2(cmd, Number(start_time), Number(end_time));
          if (redirectedUrl) {
            return h.redirect(redirectedUrl).code(302);
          }
          return h.response({ error: "Unable to fetch catchup stream" }).code(400);
        } catch (err) {
          logger.error(`Catchup stream error: ${err}`);
          return h.response({ error: "Catchup stream fetch failed" }).code(500);
        }
      }

      const useProxy = forceProxy || (initialConfig.proxy && proxyParam !== "0");
      if (useProxy) return handleProxy(cmd, play, h);
      return handleNonProxy(cmd, h);
    },
  },
  {
    method: "GET",
    path: "/player/{resourceId}",
    handler: async (request, h) => {
      try {
        let { resourceId } = request.params as { resourceId: string };
        const { sig } = request.query as { sig?: string; exp?: string };

        if (!resourceId || !sig) {
          return h.response("Missing signature parameters").code(400);
        }

        if (resourceId.endsWith(".ts")) {
          resourceId = resourceId.slice(0, -3);
        }

        if (initialConfig.providerType === "xtream") {
          const { liveStreamService } = await import("@/services/LiveStreamService");
          try {
            const streamResponse = await liveStreamService.getSegment(resourceId, sig, request.headers);
            const response = h
              .response(streamResponse.data)
              .code(streamResponse.status)
              .type(streamResponse.headers["content-type"] || "application/octet-stream");

            ["content-length", "accept-ranges", "content-range"].forEach(
              (header) => {
                if (streamResponse.headers[header]) {
                  response.header(header, streamResponse.headers[header]);
                }
              },
            );
            return response;
          } catch (err: any) {
            logger.error(`[Player] Xtream Segment fetch error: ${err.message || err}`);
            return h.response(err.message || "Segment fetch failed").code(err.response?.status || 502);
          }
        }

        if (!verifySignedUrl(resourceId, sig)) {
          return h.response("Invalid or expired signature").code(403);
        }

        const parts = resourceId.split("<_>");
        if (parts.length !== 2) {
          return h.response("Invalid resource ID format").code(400);
        }
        const seqStr = parts.pop();
        const cmd = parts.join("<_>");
        const seqId = Number(seqStr);

        if (isNaN(seqId)) {
          return h.response("Invalid sequence ID").code(400);
        }

        let record: CacheRecord | undefined = cache.get(cmd);

        if (!record || !record.segments.has(seqId)) {
          try {
            logger.info(
              `Segment ${seqId} missing in cache for ${cmd}. Refreshing...`,
            );
            await populateCache(cmd);
            record = cache.get(cmd);
          } catch (err) {
            logger.error(`Failed to refresh cache for ${cmd}: ${err}`);
          }
        }

        if (!record || !record.segments.has(seqId)) {
          const keys = record ? Array.from(record.segments.keys()) : [];
          const min = keys.length ? Math.min(...keys) : 0;
          const max = keys.length ? Math.max(...keys) : 0;

          logger.warn(
            `Sequence Out of Range: Requested ${seqId}, Available ${min} to ${max}`,
          );
          return h.response("Segment not found").code(404);
        }

        const segmentPath = record.segments.get(seqId);
        if (!segmentPath) return h.response("Segment path invalid").code(404);

        // Kick off read-ahead for the following segment
        prefetchNextSegment(cmd, seqId + 1, record);

        // Serve from the read-ahead cache when possible (skip for Range requests)
        if (!request.headers.range) {
          const key = `${cmd}<_>${seqId}`;
          const pending = segmentPrefetch.get<Promise<PrefetchedSegment>>(key);
          if (pending) {
            const pre = await pending;
            if (pre) {
              segmentPrefetch.del(key);
              return h
                .response(pre.data)
                .type(pre.contentType)
                .header("content-length", String(pre.data.length));
            }
          }
        }

        const segmentUrl = new URL(segmentPath, record.baseUrl).href;

        try {
          return await new Promise((resolve, reject) => {
            const parsedUrl = new URL(segmentUrl);
            const isHttps = parsedUrl.protocol === "https:";
            const client = isHttps ? https : http;

            const agent = isHttps ? httpsAgent : httpAgent;

            const headers: Record<string, string> = {};

            ["range", "accept", "accept-encoding"].forEach((header) => {
              if (request.headers[header]) {
                headers[header] = request.headers[header] as string;
              }
            });

            const options: RequestOptions = {
              method: "GET",
              hostname: parsedUrl.hostname,
              port: parsedUrl.port || (isHttps ? "443" : "80"),
              path: parsedUrl.pathname + parsedUrl.search,
              headers,
              agent,
            };

            const req = client.request(options, (res) => {
              if (![200, 206].includes(res.statusCode || 0)) {
                res.resume();
                return reject(
                  new Error(
                    `Failed to fetch segment: Upstream ${res.statusCode}`,
                  ),
                );
              }

              const response = h
                .response(res)
                .code(res.statusCode || 200)
                .type(
                  res.headers["content-type"] || "application/octet-stream",
                );

              ["content-length", "accept-ranges", "content-range"].forEach(
                (header) => {
                  if (res.headers[header]) {
                    response.header(header, res.headers[header] as string);
                  }
                },
              );

              resolve(response);
            });

            req.setTimeout(10000, () => {
              req.destroy();
              reject(new Error("Stream request timeout"));
            });

            req.on("error", (err) => {
              logger.error(`[Player] HTTP stream error: ${err}`);
              reject(new Error("Stream connection failed"));
            });

            req.end();
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`[Player] Error fetching segment: ${message}`);
          return h
            .response(`[Player] Error fetching segment: ${message}`)
            .code(502);
        }
      } catch (err: any) {
        logger.error({ err }, "[Player] Detailed Error");
        logger.error(`[Player] Error fetching segment: ${err.message || err}`);

        return h
          .response({
            error: "Internal Server Error",
            details: err.message || "Unknown error occurred",
          })
          .code(500);
      }
    },
  },
];
