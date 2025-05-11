import { cmdPlayer } from "@/utils/cmdPlayer";
import axios, { AxiosResponse } from "axios";
import { ServerRoute } from "@hapi/hapi";
import http from "http";
import https from "https";
import { from, timer, firstValueFrom } from "rxjs";
import { retry, catchError } from "rxjs/operators";

const channels: Record<string, string> = {};

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
  try {
    const response = await axios.head(url);
    return response.status === 200;
  } catch {
    return false;
  }
}

export const liveRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/live",
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

        const baseUrl =
          `/player/${encodeURIComponent(cmd)}/` +
          url.substring(0, url.lastIndexOf("/") + 1);

        const modifiedBody = response.data
          .split("\n")
          .map((line) => {
            if (line.startsWith("#") || line.trim() === "") return line;
            return baseUrl + line;
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
      const { cmd } = request.params;
      const upstreamUrl =
        request.params.params +
        "?" +
        new URLSearchParams(request.query).toString();
      const rangeHeader = request.headers["range"];

      console.log(`[Player] Incoming request for: ${upstreamUrl}`);
      if (rangeHeader) {
        console.log(`[Player] Range header: ${rangeHeader}`);
      }

      return new Promise((resolve, reject) => {
        const parsedUrl = new URL(upstreamUrl);
        const client = parsedUrl.protocol === "https:" ? https : http;

        const options: RequestOptions = {
          method: "GET",
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname + parsedUrl.search,
          headers: {},
        };

        if (rangeHeader) {
          options.headers["Range"] = rangeHeader;
        }

        const req = client.request(options, (res) => {
          console.log(
            `[Player] Upstream server responded with status: ${res.statusCode}`
          );

          if (res.statusCode !== 200 && res.statusCode !== 206) {
            console.log(
              `[Player] Redirecting to /live due to upstream status ${res.statusCode}`
            );
            return resolve(h.redirect(`/live?cmd=${encodeURIComponent(cmd)}`));
          }

          const response = h
            .response(res)
            .code(res.statusCode || 200)
            .type(res.headers["content-type"] || "application/octet-stream");

          if (res.headers["content-length"]) {
            response.header("Content-Length", res.headers["content-length"]);
          }

          if (res.headers["accept-ranges"]) {
            response.header("Accept-Ranges", res.headers["accept-ranges"]);
          }

          response.header("Cache-Control", "no-cache");

          resolve(response);
        });

        req.on("error", (err) => {
          console.error("[Player] HTTP stream error:", err);
          reject(h.response("Stream failed").code(500));
        });

        req.end();
      });
    },
  },
];
