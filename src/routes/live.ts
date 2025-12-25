import { cmdPlayerV2 } from "@/utils/cmdPlayer";
import axios, { AxiosError, AxiosResponse } from "axios";
import { ServerRoute } from "@hapi/hapi";
import { http, https } from "follow-redirects";
import { RequestOptions } from "https"; // Type import only
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

// CHANGED: segments is now a Map to hold SequenceID -> URL
interface CacheRecord {
  baseUrl: string;
  segments: Map<number, string>;
  subpath?: string;
}

const cache = new NodeCache({ stdTTL: 600, checkperiod: 60 });

const pendingCommands = new Map<string, Promise<string | null>>();

async function populateCache(cmd: string): Promise<string> {
  if (pendingCommands.has(cmd)) {
    const result = await pendingCommands.get(cmd)!;
    if (result === null) {
      throw new Error("Stream Not Found");
    }
    return result;
  }

  const promise = cmdPlayerV2(cmd);
  pendingCommands.set(cmd, promise);

  const masterUrl = await promise.finally(() => {
    pendingCommands.delete(cmd);
  });

  if (!masterUrl) {
    throw new Error("Stream Not Found");
  }

  const res = await axios.get(masterUrl);
  logger.info(`Master URL fetched: ${masterUrl}`);


  const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);

  // CHANGED: Extract Media Sequence
  const seqMatch = res.data.match(sequenceRegex);
  let currentSeq = seqMatch ? parseInt(seqMatch[1], 10) : 0;

  const lines = res.data.split("\n");
  const segments = new Map<number, string>();

  const modifiedLines = lines.map((line: string) => {
    if (line.startsWith("#") || line.trim() === "") {
      return line;
    }
    if (line.endsWith(".m3u8")) {
      return `/live.m3u8?cmd=${encodeURIComponent(
        cmd
      )}&subpath=${encodeURIComponent(line)}`;
    }

    // CHANGED: Use sequence number for Resource ID
    const resourceId = `${cmd}<_>${currentSeq}`;
    segments.set(currentSeq, line);
    currentSeq++; // Increment for next segment

    return generateSignedUrl(resourceId);
  });

  cache.set(cmd, { baseUrl, segments } as CacheRecord);
  return modifiedLines.join("\n");
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
            newMasterUrl.lastIndexOf("/") + 1
          );
          if (record) {
            record.baseUrl = newBaseUrl;
            cache.set(cmd, record as CacheRecord);
          }
          return await axios.get(newMasterUrl, { validateStatus: () => true });
        }
      }
      if (res.status < 200 || res.status >= 300 || !res.data) {
        return h.response({ error: `Upstream Error ${res.status}` }).code(res.status);
      }      
      return res;
    };

    if (play === "1" && record.subpath) {
      const subUrl = new URL(record.subpath, record.baseUrl).href;
      let res = await fetchPlaylist(subUrl, true);

      if ((res as any).isBoom) return res;

      if (!res.data || res.status === 403) {
        // Retry logic for empty data (master url refresh)...
        const newMasterUrl = await cmdPlayerV2(cmd);
        if (!newMasterUrl) return h.response({ error: "Stream Not Found" }).code(404);

        const newBaseUrl = newMasterUrl.substring(0, newMasterUrl.lastIndexOf("/") + 1);
        const refreshedRes = await axios.get(newMasterUrl, { validateStatus: () => true });

        if (refreshedRes.status < 200 || refreshedRes.status >= 300 || !refreshedRes.data) {
          return h.response({ error: `Upstream Error ${refreshedRes.status}` }).code(refreshedRes.status);
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

      // CHANGED: Extract Media Sequence for subpath
      const seqMatch = (res as AxiosResponse).data.match(sequenceRegex);
      let currentSeq = seqMatch ? parseInt(seqMatch[1], 10) : 0;

      const lines = (res as AxiosResponse).data.split("\n");
      const modifiedLines = lines.map((line: string) => {
        if (line.startsWith("#") || line.trim() === "") return line;
        if (line.match(".m3u8")) return line;

        // CHANGED: Use sequence number
        const resourceId = `${cmd}<_>${currentSeq}`;
        record.segments.set(currentSeq, line);
        currentSeq++;

        return generateSignedUrl(resourceId);
      });

      // Update cache with new segments
      cache.set(cmd, record as CacheRecord);

      return h.response(modifiedLines.join("\n")).type("application/vnd.apple.mpegurl");

    } else {
      // Fetch master playlist logic
      const masterUrl = await cmdPlayerV2(cmd);
      const res = await fetchPlaylist(masterUrl);
      if ((res as any).isBoom) return res;

      // CHANGED: Extract Media Sequence for master
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

        // CHANGED: Use sequence number
        const resourceId = `${cmd}<_>${currentSeq}`;
        record.segments.set(currentSeq, line);
        currentSeq++;

        return generateSignedUrl(resourceId);
      });

      cache.set(cmd, record as CacheRecord);
      return h.response(modifiedLines.join("\n")).type("application/vnd.apple.mpegurl");
    }
  } catch (error) {
    logger.error(`Error: ${(error as Error)?.stack ?? error}`);
    return h.response({ error: "Failed to generate URL" }).code(500);
  }
}

export const liveRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/live.m3u8",
    handler: async (request, h) => {
      const { cmd, play, id } = request.query as { cmd?: string; play?: string; id?: string };
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

        // Strip .ts extension if present
        if (resourceId.endsWith(".ts")) {
          resourceId = resourceId.slice(0, -3);
        }

        if (!verifySignedUrl(resourceId, sig)) {
          return h.response("Invalid or expired signature").code(403);
        }

        // 2. Safer parsing logic
        const parts = resourceId.split("<_>");
        if (parts.length !== 2) {
          return h.response("Invalid resource ID format").code(400);
        }
        const [cmd, seqStr] = parts;
        const seqId = Number(seqStr);

        if (isNaN(seqId)) {
          return h.response("Invalid sequence ID").code(400);
        }

        let record: CacheRecord | undefined = cache.get(cmd);

        // Look up by Map key (seqId)
        if (!record || !record.segments.has(seqId)) {
          try {
            await populateCache(cmd);
            record = cache.get(cmd);
          } catch (err) {
            console.error(err);
            // Allow main error handler to catch this
            throw err;
          }
          if (!record || !record.segments.has(seqId)) {
            return h.response("Segment not found").code(404);
          }
        }

        const segmentPath = record.segments.get(seqId);
        if (!segmentPath) return h.response("Segment path invalid").code(404);

        const segmentUrl = new URL(segmentPath, record.baseUrl).href;

        // 3. Proxy Logic
        try {
          return await new Promise((resolve, reject) => {
            const parsedUrl = new URL(segmentUrl);
            const isHttps = parsedUrl.protocol === "https:";
            const client = isHttps ? https : http;

            // Select the keep-alive agent
            const agent = isHttps ? httpsAgent : httpAgent;

            const headers: Record<string, string> = {};

            // Forward specific request headers (EXCLUDING user-agent)
            ["range", "accept", "accept-encoding"].forEach((header) => {
              if (request.headers[header]) {
                headers[header] = request.headers[header] as string;
              }
            });

            // Force VLC User-Agent as requested
            headers["User-Agent"] = "VLC/3.0.18 LibVLC/3.0.18";

            const options: RequestOptions = {
              method: "GET",
              hostname: parsedUrl.hostname,
              port: parsedUrl.port || (isHttps ? "443" : "80"),
              path: parsedUrl.pathname + parsedUrl.search,
              headers,
              agent, // Use the persistent agent
            };

            const req = client.request(options, (res) => {
              // Handle upstream errors (e.g., 404 from the source CDN)
              if (![200, 206].includes(res.statusCode || 0)) {
                // Consume data to free memory if we aren't using it
                res.resume();
                return reject(new Error(`Failed to fetch segment: Upstream ${res.statusCode}`));
              }

              const response = h.response(res)
                .code(res.statusCode || 200)
                .type(res.headers["content-type"] || "application/octet-stream");

              // 4. Forward response headers safely
              // REMOVED 'transfer-encoding' to avoid protocol conflicts
              ["content-length", "accept-ranges", "content-range"].forEach((header) => {
                if (res.headers[header]) {
                  response.header(header, res.headers[header] as string);
                }
              });

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
          return h.response(`[Player] Error fetching segment: ${message}`).code(502); // 502 Bad Gateway is more appropriate here
        }

      } catch (err: any) {
        console.error("[Player] Detailed Error:", err);
        logger.error(`[Player] Error fetching segment: ${err.message || err}`);

        return h.response({
          error: "Internal Server Error",
          details: err.message || "Unknown error occurred"
        }).code(500);
      }
    },
  },
];