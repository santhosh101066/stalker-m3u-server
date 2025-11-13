import { cmdPlayerV2 } from "@/utils/cmdPlayer";
import axios, { AxiosError, AxiosResponse } from "axios";
import { ServerRoute } from "@hapi/hapi";
import http from "http";
import https, { RequestOptions } from "https";
import NodeCache from "node-cache";
import { appConfig, initialConfig } from "@/config/server";
import { ReqRefDefaults, ResponseToolkit } from "@hapi/hapi/lib/types";

const SECRET_KEY = appConfig.proxy.secretKey;



function generateSignedUrl(resourceId: string): string {
  const sig = require("crypto")
    .createHmac("sha256", SECRET_KEY)
    .update(resourceId)
    .digest("hex");
  return `/player/${encodeURIComponent(resourceId)}?sig=${sig}`;
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
  segments: string[];
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

  const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);

  const lines = res.data.split("\n");
  const segments: string[] = [];
  const modifiedLines = lines.map((line: string) => {
    if (line.startsWith("#") || line.trim() === "") {
      return line;
    }
    if (line.endsWith(".m3u8")) {
      // rewrite to re-enter /live.m3u8 route with cmd param
      return `/live.m3u8?cmd=${encodeURIComponent(
        cmd
      )}&subpath=${encodeURIComponent(line)}`;
    }
    // media segment line: store and generate signed url
    const resourceId = `${cmd}<_>${segments.length}`;
    segments.push(line);
    return generateSignedUrl(resourceId);
  });
  cache.set(cmd, { baseUrl, segments } as CacheRecord);
  return modifiedLines.join("\n");
}

async function handleNonProxy(cmd: string, h: ResponseToolkit<ReqRefDefaults>) {
  try {
    // First try the "redirected" URL
    const redirectedUrl = await cmdPlayerV2(cmd);
    if (redirectedUrl) {
      return h
        .redirect(redirectedUrl)
        .code(302);
    }
    return h.response({ error: "Unable to fetch stream [Non Proxy]" }).code(400);
  } catch (err) {
    console.error("Non-proxy error:", err);
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
        // Refresh master URL and retry
        const newMasterUrl = await cmdPlayerV2(cmd);
        if (newMasterUrl) {
          // Update cache baseUrl so future segments work
          const newBaseUrl = newMasterUrl.substring(
            0,
            newMasterUrl.lastIndexOf("/") + 1
          );
          if (record) {
            record.baseUrl = newBaseUrl;
            cache.set(cmd, record as CacheRecord);
          }

          // Retry playlist fetch with updated URL
          const refreshed = await axios.get(newMasterUrl, {
            validateStatus: () => true,
          });
          return refreshed;
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
      // Fetch sub-playlist

      const subUrl = new URL(record.subpath, record.baseUrl).href;

      let res = await fetchPlaylist(subUrl, true);
      if ((res as any).isBoom) return res; // Early return if error response;
      if (!res.data) {
        const newMasterUrl = await cmdPlayerV2(cmd);
        if (!newMasterUrl) {
          return h.response({ error: "Stream Not Found" }).code(404);
        }
        const newBaseUrl = newMasterUrl.substring(
          0,
          newMasterUrl.lastIndexOf("/") + 1
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

        cache.set(cmd, record as CacheRecord);
        if (!record.subpath) {
          return h
            .response({ error: "No valid subpath found in new master URL" })
            .code(404);
        }
        const subUrl = new URL(record.subpath, record.baseUrl).href;
        res = await fetchPlaylist(subUrl, true);
      }

      const lines = (res as AxiosResponse).data.split("\n");
      const modifiedLines = lines.map((line: string) => {
        if (line.startsWith("#") || line.trim() === "") return line;
        // Do not rewrite .m3u8 lines in subpath playlists
        if (line.match(".m3u8")) {
          return line;
        }
        const resourceId = `${cmd}<_>${record.segments.length}`;
        record.segments.push(line);
        cache.set(cmd, record as CacheRecord);
        return generateSignedUrl(resourceId);
      });

      return h
        .response(modifiedLines.join("\n"))
        .type("application/vnd.apple.mpegurl");
    } else {
      // Fetch master playlist
      const masterUrl = await cmdPlayerV2(cmd);
      const res = await fetchPlaylist(masterUrl);
      if ((res as any).isBoom) return res; // Early return if error response

      const lines = (res as AxiosResponse).data.split("\n");
      const modifiedLines = lines.map((line: string) => {
        if (line.startsWith("#") || line.trim() === "") return line;
        if (line.match(".m3u8")) {
          record.subpath = line;
          cache.set(cmd, record as CacheRecord);
          return `/live.m3u8?cmd=${encodeURIComponent(cmd)}&play=1`;
        }
        const resourceId = `${cmd}<_>${record.segments.length}`;
        record.segments.push(line);
        cache.set(cmd, record as CacheRecord);
        return generateSignedUrl(resourceId);
      });

      return h
        .response(modifiedLines.join("\n"))
        .type("application/vnd.apple.mpegurl");
    }
  } catch (error) {
    console.error("Error:", (error as Error)?.stack ?? error);
    return h.response({ error: "Failed to generate URL" }).code(500);
  }
}

export const liveRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/live.m3u8",
    handler: async (request, h) => {
      const { cmd, play } = request.query as {
        cmd?: string;
        play?: string;
      };
      if (!cmd) {
        return h.response({ error: "Missing cmd parameter" }).code(400);
      }

      if (initialConfig.proxy) {
        return handleProxy(cmd, play, h);
      }

      return handleNonProxy(cmd, h);
    },
  },
  {
    method: "GET",
    path: "/player/{resourceId}",
    handler: async (request, h) => {
      try {
        const { resourceId } = request.params as { resourceId: string };

        const { sig } = request.query as { sig?: string; exp?: string };
        if (!resourceId || !sig) {
          return h.response("Missing signature parameters").code(400);
        }
        if (!verifySignedUrl(resourceId, sig)) {
          return h.response("Invalid or expired signature").code(403);
        }
        const [cmd, indexStr] = resourceId.split("<_>");
        const index = Number(indexStr);
        let record: CacheRecord | undefined = cache.get(cmd);
        if (!record || !record.segments[index]) {
          // repopulate cache and retry once
          try {
            await populateCache(cmd);
            record = cache.get(cmd);
          } catch (err) {
            console.error(err);

            return h.response("Failed to populate cache").code(500);
          }
          if (!record || !record.segments[index]) {
            return h.response("Segment not found").code(404);
          }
        }
        const segmentPath = record.segments[index];
        const segmentUrl = new URL(segmentPath, record.baseUrl).href;
        try {
          return new Promise((resolve, reject) => {
            const parsedUrl = new URL(segmentUrl);
            const client = parsedUrl.protocol === "https:" ? https : http;
            const headers: Record<string, string> = {};
            ["range", "user-agent", "accept", "accept-encoding"].forEach(
              (header) => {
                if (request.headers[header]) {
                  headers[header] = request.headers[header] as string;
                }
              }
            );
            const options: RequestOptions = {
              method: "GET",
              hostname: parsedUrl.hostname,
              port:
                parsedUrl.port ||
                (parsedUrl.protocol === "https:" ? "443" : "80"),
              path: parsedUrl.pathname + parsedUrl.search,
              headers,
            };
            const req = client.request(options, (res) => {
              if (![200, 206].includes(res.statusCode || 0)) {
                return reject(
                  new Error(`Failed to fetch segment: ${res.statusCode}`)
                );
              }
              const response = h
                .response(res)
                .code(res.statusCode || 200)
                .type(
                  res.headers["content-type"] || "application/octet-stream"
                );
              [
                "content-length",
                "accept-ranges",
                "content-range",
                "transfer-encoding",
              ].forEach((header) => {
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
              console.error("[Player] HTTP stream error:", err);
              reject(new Error("Stream connection failed"));
            });
            req.end();
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[Player] Error fetching segment:", message);
          return h.response(message).code(500);
        }
      } catch (err) {
        console.error("[Player] Error fetching segment:", err);
      }
    },
  },
];