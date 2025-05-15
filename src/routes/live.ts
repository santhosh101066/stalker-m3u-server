import { cmdPlayer } from "@/utils/cmdPlayer";
import axios, { AxiosResponse } from "axios";
import {
  Request,
  ResponseToolkit,
  ResponseObject,
  ServerRoute,
} from "@hapi/hapi";
import http from "http";
import https from "https";
import { from, timer, firstValueFrom } from "rxjs";
import { retry, catchError } from "rxjs/operators";

const channels: Record<string, string> = {};
const channelsUrls: Record<string, { baseUrl: string; paths: Array<string> }> =
  {};

interface RequestOptions {
  method: string;
  hostname: string;
  port: string;
  path: string;
  headers: Record<string, string>;
}

// Replace retryWithDelay function with retry config
const retryConfig = {
  count: 3,
  delay: (error: Error, retryCount: number) => {
    console.log(
      `Retry attempt ${retryCount} after ${
        1000 * Math.pow(2, retryCount - 1)
      }ms`
    );
    return timer(1000 * Math.pow(2, retryCount - 1));
  },
};

async function isUrlValid(url: string): Promise<boolean> {
  console.log("\x1b[33m%s\x1b[0m", `[URL Validation] Checking URL: ${url}`);
  try {
    const response = await axios.head(url);
    console.log("\x1b[32m%s\x1b[0m", `[URL Validation] URL is valid: ${url}`);
    return response.status === 200;
  } catch (error) {
    console.log("\x1b[31m%s\x1b[0m", `[URL Validation] URL is invalid: ${url}`);
    return false;
  }
}

export const liveRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/live.m3u8",
    handler: async (request, h) => {
      const { cmd } = request.query;

      if (!cmd) {
        return h.response({ error: "Invalid command" }).code(400);
      }

      try {
        let url: string | undefined;

        // First check if we have a cached URL and it's still valid
        if (channels[cmd]) {
          const isValid = await isUrlValid(channels[cmd]);
          if (isValid) {
            url = channels[cmd];
          } else {
            delete channels[cmd]; // Remove invalid URL from cache
          }
        }

        // If no valid cached URL, get new one from cmdPlayer
        if (!url) {
          url = await firstValueFrom(
            from(cmdPlayer(cmd)).pipe(
              retry(retryConfig),
              catchError((error) => {
                console.error("Failed after retries:", error);
                throw error;
              })
            )
          );
          channels[cmd] = url;
        }

        const response: AxiosResponse<string> = await firstValueFrom(
          from(axios.get(url)).pipe(
            retry(retryConfig),
            catchError((error) => {
              console.error("Failed to fetch stream after retries:", error);
              throw error;
            })
          )
        );

        const baseUrl = `/player/${encodeURIComponent(cmd)}/`;

        channelsUrls[cmd] = {
          baseUrl: url.substring(0, url.lastIndexOf("/") + 1),
          paths: [],
        };

        const modifiedBody = response.data
          .split("\n")
          .map((line, i) => {
            if (line.startsWith("#") || line.trim() === "") return line;
            channelsUrls[cmd].paths.push(line);
            return baseUrl + "?id=" + (channelsUrls[cmd].paths.length - 1);
          })
          .join("\n");

        return h.response(modifiedBody).type("application/vnd.apple.mpegurl");
      } catch (error) {
        console.error("Error with retries:", error);
        return h.response({ error: "Failed to generate URL" }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/player/{cmd}/{params*}",
    handler: async (request, h) => {
      async function proxyPlay(
        request: Request,
        h: ResponseToolkit,
        retries = 0
      ): Promise<ResponseObject> {
        const { cmd } = request.params;
        const MAX_RETRIES = 3;

        if (!channelsUrls[cmd]?.baseUrl) {
          try {
            await axios.get(
              `http://${request.info.host}/live.m3u8?cmd=${encodeURIComponent(cmd)}`
            );
          } catch (error) {
            console.error("[Player] Error fetching initial stream:", error);
            return h.response("Failed to initialize stream").code(500);
          }
        }

        const upstreamUrl =
          channelsUrls[cmd].baseUrl +
          (request.params.params
            ? request.params.params +
              "?" +
              new URLSearchParams(request.query).toString()
            : channelsUrls[cmd].paths[request.query.id]);

        console.log(`[Player] Incoming request for: ${upstreamUrl}`);

        return new Promise((resolve, reject) => {
          const parsedUrl = new URL(upstreamUrl);
          const client = parsedUrl.protocol === "https:" ? https : http;

          // Forward all relevant headers from client request
          const headers: Record<string, string> = {};
          ['range', 'user-agent', 'accept', 'accept-encoding'].forEach(header => {
            if (request.headers[header]) {
              headers[header] = request.headers[header] as string;
            }
          });

          const options: RequestOptions = {
            method: "GET",
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === "https:" ? "443" : "80"),
            path: parsedUrl.pathname + parsedUrl.search,
            headers
          };

          const req = client.request(options, async (res) => {
            console.log(`[Player] Upstream status: ${res.statusCode}`);

            if (res.statusCode !== 200 && res.statusCode !== 206) {
              console.log(`[Player] Bad upstream status: ${res.statusCode}`);
              
              // Clear cached URL to force refresh
              delete channelsUrls[cmd];

              if (retries < MAX_RETRIES) {
                console.log(`[Player] Retrying stream ${retries + 1}/${MAX_RETRIES}`);
                try {
                  // Add 1 second delay before retry
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  const result = await proxyPlay(request, h, retries + 1);
                  return resolve(result);
                } catch (err) {
                  return reject(err);
                }
              } else {
                return reject(h.response("Stream failed after max retries").code(500));
              }
            }

            const response = h
              .response(res)
              .code(res.statusCode || 200)
              .type(res.headers["content-type"] || "application/octet-stream");

            // Forward relevant headers from upstream
            ['content-length', 'accept-ranges', 'content-range'].forEach(header => {
              if (res.headers[header]) {
                response.header(header, res.headers[header] as string);
              }
            });

            response.header("Cache-Control", "no-cache");
            resolve(response);
          });

          req.setTimeout(10000, () => {
            req.destroy();
            reject(h.response("Stream request timeout").code(504));
          });

          req.on("error", (err) => {
            console.error("[Player] HTTP stream error:", err);
            reject(h.response("Stream connection failed").code(502));
          });

          req.end();
        });
      }

      try {
        return await proxyPlay(request, h);
      } catch (error) {
        console.error("[Player] Proxy error:", error);
        return h.response("Stream failed").code(500);
      }
    },
  },
];
