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
import { streamRoutes } from "./routes/stream";
import { vodRoutes } from "./routes/vod";
import { socketService } from "./services/SocketService";

import { initDB } from "./db";
import { migrateToProfiles, loadActiveProfileFromDB } from "./config/server";
import { logger } from "./utils/logger";

const init = async () => {
  await initDB();

  await migrateToProfiles();

  await loadActiveProfileFromDB();

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
  server.route(streamRoutes);
  server.route(vodRoutes);

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
    logger.info(
      request.info.remoteAddress +
        ": " +
        request.method.toUpperCase() +
        " " +
        request.path +
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
  // backgroundJobService.start();

  logger.info(`Server running at: ${server.info.uri}`);
};

process.on("unhandledRejection", (err) => {
  logger.error(`Unhandled rejection: ${err}`);
  process.exit(1);
});

init();
