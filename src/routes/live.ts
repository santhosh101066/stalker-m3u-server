import { cmdPlayer } from "@/utils/cmdPlayer";
import { ServerRoute } from "@hapi/hapi";

export const liveRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/live",
    handler: async (request, h) => {
      const url = await cmdPlayer(request.query.cmd);
      return h.redirect(url).code(302);
    },
  },
];
