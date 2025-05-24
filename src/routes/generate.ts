import { generateGroup } from "@/utils/generateGroups";
import { ServerRoute } from "@hapi/hapi";

export const generateGroupRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/groups",
    handler: async (request, h) => {
      const catagory = await generateGroup();
      return catagory;
    },
  },
];
