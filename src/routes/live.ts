import { cmdPlayerV2 } from "@/utils/cmdPlayer";
import axios, { AxiosError, AxiosResponse } from "axios";
import { ServerRoute } from "@hapi/hapi";
import http from "http";
import https, { RequestOptions } from "https";
import NodeCache from "node-cache";
import { appConfig, initialConfig } from "@/config/server";
import { ReqRefDefaults, ResponseToolkit } from "@hapi/hapi/lib/types";
import { stalkerApi } from "@/utils/stalker";

const SECRET_KEY = appConfig.proxy.secretKey;
const sequenceRegex = /#EXT-X-MEDIA-SEQUENCE:(\d+)/;

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
  console.log(masterUrl);
  

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
        const newMasterUrl = await cmdPlayerV2(cmd);
        console.log(newMasterUrl);
        
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

      if (!res.data) {
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
    console.error("Error:", (error as Error)?.stack ?? error);
    return h.response({ error: "Failed to generate URL" }).code(500);
  }
}

export const liveRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/live.m3u8",
    handler: async (request, h) => {
      const { cmd, play, id } = request.query as { cmd?: string; play?: string; id?: string};
      if (!cmd) return h.response({ error: "Missing cmd parameter" }).code(400);
      if(id){
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
        const { resourceId } = request.params as { resourceId: string };
        const { sig } = request.query as { sig?: string; exp?: string };
        
        if (!resourceId || !sig) return h.response("Missing signature parameters").code(400);
        if (!verifySignedUrl(resourceId, sig)) return h.response("Invalid or expired signature").code(403);
        
        const [cmd, seqStr] = resourceId.split("<_>");
        const seqId = Number(seqStr); // This is now the specific sequence number

        let record: CacheRecord | undefined = cache.get(cmd);
        
        // CHANGED: Look up by Map key (seqId) instead of array index
        if (!record || !record.segments.has(seqId)) {
          try {
            await populateCache(cmd);
            record = cache.get(cmd);
          } catch (err) {
            console.error(err);
            return h.response("Failed to populate cache").code(500);
          }
          if (!record || !record.segments.has(seqId)) {
            return h.response("Segment not found").code(404);
          }
        }

        // CHANGED: Retrieve from Map
        const segmentPath = record.segments.get(seqId);
        if (!segmentPath) return h.response("Segment path invalid").code(404);

        const segmentUrl = new URL(segmentPath, record.baseUrl).href;
        
        try {
          return new Promise((resolve, reject) => {
            const parsedUrl = new URL(segmentUrl);
            const client = parsedUrl.protocol === "https:" ? https : http;
            const headers: Record<string, string> = {};
            
            ["range", "user-agent", "accept", "accept-encoding"].forEach((header) => {
              if (request.headers[header]) {
                headers[header] = request.headers[header] as string;
              }
            });

            const options: RequestOptions = {
              method: "GET",
              hostname: parsedUrl.hostname,
              port: parsedUrl.port || (parsedUrl.protocol === "https:" ? "443" : "80"),
              path: parsedUrl.pathname + parsedUrl.search,
              headers,
            };

            const req = client.request(options, (res) => {
              if (![200, 206].includes(res.statusCode || 0)) {
                return reject(new Error(`Failed to fetch segment: ${res.statusCode}`));
              }
              
              const response = h.response(res).code(res.statusCode || 200)
                .type(res.headers["content-type"] || "application/octet-stream");
                
              ["content-length", "accept-ranges", "content-range", "transfer-encoding"].forEach((header) => {
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