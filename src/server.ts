import "dotenv/config";
import { initialConfig, serverConfig } from "@/config/server";
import { playlistRoutes } from "./routes/playlist";
import { liveRoutes } from "./routes/live";
import { configRoutes } from "./routes/config";
import { profileRoutes } from "./routes/profiles";
import Hapi from "@hapi/hapi";
import Inert from "@hapi/inert";
import { serverManager } from "./serverManager";
import { stalkerV2 } from "./routes/stalkerV2";
import path from "path";
import { proxy } from "./routes/proxy";
import { stalkerApi } from "./utils/stalker";
import { portalProxy } from "./routes/portalProxy";
import { xtreamRoutes } from "./routes/xtream";
import { vodRoutes } from "./routes/vod";
import { adminRoutes } from "./routes/contentmanager";
import { socketService } from "./services/SocketService";

import { initDB } from "./db";
import { migrateToProfiles, loadActiveProfileFromDB } from "./config/server";
import { loadPlaylistCache } from "./utils/getM3uUrls";
import { warmVodCache, warmSeriesCache, warmSeriesInfoCache, cleanupGenres } from "./routes/xtream";
import { generateStrmFiles } from "./utils/strmGenerator";
import { fetchAndCacheEpg, getEpgCache } from "./utils/epg";
import { logger } from "./utils/logger";

const init = async () => {
  await initDB();

  await migrateToProfiles();

  await loadActiveProfileFromDB();
  await loadPlaylistCache();

  const server = Hapi.server({
    ...serverConfig,
  });

  serverManager.setServer(server);

  server.route({
    method: "GET",
    path: "/",
    handler: (request, h) => {
      return h
        .file(path.join(process.cwd(), "public", "index.html"))
        .header(
          "Content-Security-Policy",
          "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
        );
    },
  });

  socketService.init(server.listener);

  await server.register(Inert);
  server.route(playlistRoutes);
  server.route(liveRoutes);
  server.route(configRoutes);
  server.route(profileRoutes);
  server.route(stalkerV2);
  server.route(proxy);
  server.route(portalProxy);
  server.route(xtreamRoutes);
  server.route(vodRoutes);
  server.route(adminRoutes);

  server.route({
    method: "GET",
    path: "/{param*}",
    handler: (request, h) => {
      const filePath = path.join(
        process.cwd(),
        "public",
        request.params.param || "",
      );

      if (
        !filePath.endsWith(".js") &&
        !filePath.endsWith(".css") &&
        !filePath.endsWith(".png") &&
        !filePath.endsWith(".jpg") &&
        !filePath.endsWith(".ico") &&
        !filePath.endsWith(".svg") &&
        !filePath.endsWith(".webmanifest")
      ) {
        return h
          .file(path.join(process.cwd(), "public", "index.html"))
          .header(
            "Content-Security-Policy",
            "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
          );
      }

      return h.file(filePath);
    },
  });

  server.events.on("response", function (request) {
    const qs = request.url.search || "";
    logger.info(
      request.info.remoteAddress +
        ": " +
        request.method.toUpperCase() +
        " " +
        request.path +
        qs +
        " --> " +
        (request.response &&
        typeof (request.response as any).statusCode === "number"
          ? (request.response as any).statusCode
          : request.response &&
            (request.response as any).output &&
            (request.response as any).output.statusCode),
    );
  });

  await server.start();

  const { backgroundJobService } =
    await import("./services/BackgroundJobService");
  backgroundJobService.start();

  logger.info(`Server running at: ${server.info.uri}`);

  // Warm xtream caches in background on startup, then cleanup stale genres
  Promise.all([
    warmVodCache().catch((e) => logger.error(`[warmVodCache] ${e}`)),
    warmSeriesCache().catch((e) => logger.error(`[warmSeriesCache] ${e}`)),
  ]).then(() => cleanupGenres().catch((e) => logger.error(`[cleanupGenres] ${e}`)))
    .then(() => warmSeriesInfoCache().catch((e) => logger.error(`[warmSeriesInfoCache] ${e}`)))
    .then(() => generateStrmFiles().catch((e) => logger.error(`[STRM] ${e}`)));

  // Fetch EPG on startup if cache is missing or stale
  getEpgCache().then((cache) => {
    if (!cache) {
      fetchAndCacheEpg().catch((e) => logger.error(`[EPG startup] ${e}`));
    }
  }).catch((e) => logger.error(`[EPG startup check] ${e}`));

  // Re-warm all xtream caches every 24 hours, then regenerate strm files
  setInterval(() => {
    Promise.all([
      warmVodCache().catch((e) => logger.error(`[warmVodCache interval] ${e}`)),
      warmSeriesCache().catch((e) => logger.error(`[warmSeriesCache interval] ${e}`)),
    ]).then(() => cleanupGenres().catch((e) => logger.error(`[cleanupGenres interval] ${e}`)))
      .then(() => warmSeriesInfoCache().catch((e) => logger.error(`[warmSeriesInfoCache interval] ${e}`)))
      .then(() => generateStrmFiles().catch((e) => logger.error(`[STRM interval] ${e}`)));
  }, 24 * 60 * 60 * 1000);
};

process.on("unhandledRejection", (err) => {
  logger.error(`Unhandled rejection: ${err}`);
  process.exit(1);
});

init();
