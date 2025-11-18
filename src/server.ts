import { initialConfig, serverConfig } from "@/config/server";
import { playlistRoutes } from "./routes/playlist";
import { liveRoutes } from "./routes/live";
import { configRoutes } from "./routes/config";
import Hapi from "@hapi/hapi";
import Inert from "@hapi/inert";
import { serverManager } from "./serverManager";
import { stalkerV2 } from "./routes/stalkerV2";
import path from "path";
import { proxy } from "./routes/proxy";
import { stalkerApi } from "./utils/stalker";
import { portalProxy } from "./routes/portalProxy";

const init = async () => {
  // Register routes
  const server = Hapi.server({
    ...serverConfig,
  });

  serverManager.setServer(server);
  await server.register(Inert);
  server.route(playlistRoutes);
  server.route(liveRoutes);
  server.route(configRoutes);
  server.route(stalkerV2);
  server.route(proxy);
  server.route(portalProxy);

  server.route({
    method: "GET",
    path: "/{param*}", // Match all routes
    handler: (request, h) => {
      const filePath = path.join(
        process.cwd(),
        "public",
        request.params.param || ""
      );

      // Serve index.html for unknown files (browser routing)
      if (
        !filePath.endsWith(".js") &&
        !filePath.endsWith(".css") &&
        !filePath.endsWith(".png") &&
        !filePath.endsWith(".jpg") &&
        !filePath.endsWith(".ico") &&
        !filePath.endsWith(".svg")
      ) {
        return h.file(path.join(process.cwd(), "public", "index.html"));
      }

      return h.file(filePath);
    },
  });

  server.events.on("response", function (request) {
    console.log(
      ["debug"],
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
            (request.response as any).output.statusCode)
    );
  });

  await server.start();

  // async function scheduleTokenFetcher() {
  //   try {
  //     if (initialConfig.tokens.length < 350) {
  //       const tokenResponse = await stalkerApi.fetchNewToken();
  //       stalkerApi.addToken(tokenResponse.token);
  //       console.log(
  //         `Fetched new token: ${tokenResponse.token}. Total tokens: ${initialConfig.tokens.length}`
  //       );
  //     }
  //   } catch (err) {
  //     console.error("Error fetching new token:", err);
  //   }

  //   // Adjust next run interval based on token count
  //   const nextInterval = initialConfig.tokens.length < 100 ?  1 * 60 * 1000 :  5 * 60 * 1000;

  //   setTimeout(scheduleTokenFetcher, nextInterval);
  // }

  // scheduleTokenFetcher();
  console.log(`Server running at: ${server.info.uri}`);
};

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  process.exit(1);
});

init();
