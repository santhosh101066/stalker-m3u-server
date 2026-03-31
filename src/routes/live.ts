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
}

const cache = new NodeCache({ stdTTL: 30, checkperiod: 10 });

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
    cache.set(cmd, { baseUrl: finalBaseUrl, segments, subpath } as CacheRecord);
  };

  const promise = initCache().finally(() => {
    pendingCommands.delete(cmd);
  });

  pendingCommands.set(cmd, promise);
  await promise;
}

async function handleNonProxy(cmd: string, h: ResponseToolkit<ReqRefDefaults>) {
  try {
    const redirectedUrl = await cmdPlayerV2(cmd);
    if (redirectedUrl) {
      return h.redirect(redirectedUrl).code(302);
    }
    return h
      .response({ error: "Unable to fetch stream [Non Proxy]" })
      .code(400);
  } catch (err) {
    logger.error(`Non-proxy error: ${err}`);
    return h.response({ error: "Stream fetch failed" }).code(500);
  }
}

async function handleProxy(cmd: string, play: string | undefined, h: any) {
  try {
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
      const masterUrl = await cmdPlayerV2(cmd);
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
          return `/live.m3u8?cmd=${encodeURIComponent(cmd)}&play=1`;
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

export const liveRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/live.m3u8",
    handler: async (request, h) => {
      const { cmd, play, id } = request.query as {
        cmd?: string;
        play?: string;
        id?: string;
      };
      if (!cmd) return h.response({ error: "Missing cmd parameter" }).code(400);
      if (id) {
        stalkerApi.setActiveChannel(id);
      }
      if (initialConfig.proxy) return handleProxy(cmd, play, h);
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
        console.error("[Player] Detailed Error:", err);
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
