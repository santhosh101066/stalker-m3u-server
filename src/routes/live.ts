import { cmdPlayer } from "@/utils/cmdPlayer";
import axios, { AxiosError, AxiosResponse } from "axios";
import {
  Request,
  ResponseToolkit,
  ResponseObject,
  ServerRoute,
} from "@hapi/hapi";
import { from, firstValueFrom } from "rxjs";
import http from "http";
import https from "https";
import { initialConfig } from "@/config/server";

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
        if (!initialConfig.proxy) {
          const url = await cmdPlayer(cmd);
          return h.redirect(url).code(302);
        }

        let url: string | undefined;

        if (channels[cmd]) {
          try {
            const res = await axios.head(channels[cmd]);
            url = channels[cmd];
          } catch (error) {
            console.log(
              "\x1b[31m%s\x1b[0m",
              `[URL Validation] Invalid cached URL: ${channels[cmd]}`
            );
            delete channels[cmd];
            // if (axios.isAxiosError(error) && error.response) {
            //   return h.response({ error: "Invalid cached URL" }).code(error.response.status);
            // }
          }
        }

        if (!url) {
          try {
            url = await cmdPlayer(cmd);
            if (!url) return h.response("Stream Not Found").code(404);
            channels[cmd] = url;
          } catch (error) {
            if (axios.isAxiosError(error) && error.response) {
              return h
                .response({ error: "Failed to generate URL" })
                .code(error.response.status);
            }
            throw error;
          }
        }

        try {
          let response: AxiosResponse<string> = await axios.get(url, {
            maxRedirects: 0,
            validateStatus: (status) => [200, 301, 302, 206].includes(status),
          });

          if ([301, 302].includes(response.status)) {
            const location = response.headers.location;
            if (location) {
              const redirectUrl = new URL(location, url).href;
              console.log(`[M3U8] Redirect to: ${redirectUrl}`);
              url = redirectUrl;
              channels[cmd] = url;
              // Fetch the actual content after getting redirect
              response = await axios.get(url);
            }
          }

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
          if (axios.isAxiosError(error) && error.response) {
            return h
              .response({ error: "Failed to fetch stream" })
              .code(error.response.status);
          }
          throw error;
        }
      } catch (error) {
        console.log("Error:", (error as Error).message);
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
        h: ResponseToolkit
      ): Promise<ResponseObject> {
        const { cmd } = request.params;

        if (!channelsUrls[cmd]?.baseUrl) {
          try {
            await axios.get(
              `http://${request.info.host}/live.m3u8?cmd=${encodeURIComponent(
                cmd
              )}`
            );
          } catch (error) {
            console.error(
              "[Player] Error fetching initial stream:",
              (error as Error).message
            );
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

          const req = client.request(options, async (res) => {
            console.log(`[Player] Upstream status: ${res.statusCode}`);

            if (![200, 206, 301, 302].includes(res.statusCode || 0)) {
              console.log(`[Player] Bad upstream status: ${res.statusCode}`);
              delete channelsUrls[cmd];
              return reject(h.response("Stream failed").code(500));
            }

            if ([301, 302].includes(res.statusCode || 0)) {
              const location = res.headers.location;
              if (location) {
                const redirectUrl = new URL(location, upstreamUrl).href;
                console.log(`[Player] Redirect to: ${redirectUrl}`);
                channelsUrls[cmd] = {
                  baseUrl: redirectUrl.substring(
                    0,
                    redirectUrl.lastIndexOf("/") + 1
                  ),
                  paths: channelsUrls[cmd].paths,
                };
              }
            }

            const response = h
              .response(res)
              .code(res.statusCode || 200)
              .type(res.headers["content-type"] || "application/octet-stream");

            // Forward relevant headers from upstream
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
        console.error("[Player] Proxy error");
        return h.response("Stream failed").code(500);
      }
    },
  },
];
