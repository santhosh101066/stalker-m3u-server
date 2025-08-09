import { initialConfig } from "@/config/server";
import { ArrayData, Data, Genre, Programs, Video } from "@/types/types";
import { fetchData } from "@/utils/fetch";
import { generateGroup } from "@/utils/generateGroups";
import { ServerRoute } from "@hapi/hapi";

export const moviesRoute: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/images/{slug*}",
    handler: async (request, h) => {
      const slug: string = request.params.slug;
      return h.redirect(
        `http://${initialConfig.hostname}:${initialConfig.port}/${slug}`
      );
    },
  },
  {
    method: "GET",
    path: "/api/movies/{slug*}",
    handler: async (request, h) => {
      const slug: string = request.params.slug || "";
      const {
        page = "1",
        movieId,
        seasonId = "0",
        episodeId = "0",
        videoId,
      } = request.query as {
        page?: string;
        movieId?: string;
        seasonId?: string;
        episodeId?: string;
        videoId?: string;
      };

      // If videoId is present, get streaming link
      if (videoId) {
        const videoData = await fetchData<Data<Programs<Video>>>(
          "/server/load.php?type=vod&action=create_link&force_ch_link_check=0&disable_ad=0&download=1&forced_stop_range=&cmd=" +
            encodeURIComponent(`/media/file_${slug}`)
        );
        return videoData.js;
      }

      // If movieId is present, fetch specific video
      if (movieId) {
        const movieList = await fetchData<Data<Programs<Video>>>(
          `/server/load.php?type=vod&action=get_ordered_list&category=${encodeURIComponent(
            slug
          )}&genre=*&p=${page}&sortby=added&movie_id=${movieId}&season_id=${seasonId}&episode_id=${episodeId}&sortby=added`,
          true
        );
        return movieList.js;
      }

      // If no slug, return categories
      if (!slug) {
        const category = await fetchData<ArrayData<Genre>>(
          "/server/load.php?type=vod&action=get_categories"
        );
        return category.js.filter((c) => c.censored == 0);
      }

      // Default: return list by category slug
      const list = await fetchData<Data<Programs<Video>>>(
        `/server/load.php?type=vod&action=get_ordered_list&category=${encodeURIComponent(
          slug
        )}&genre=*&p=${page}&sortby=added&limit=50`,
        true
      );
      return list.js;
    },
  },
  {
    method: "GET",
    path: "/api/search",
    handler: async (request, h) => {
      const {
        search = "",
        page = 1,
        movieId = "",
        seasonId = "0",
        episodeId = "0",
      } = request.query;

      const list = await fetchData<Data<Programs<Video>>>(
        `/server/load.php?type=vod&action=get_ordered_list&search=${search}&p=${page}&sortby=added&movie_id=${movieId}&season_id=${seasonId}&episode_id=${episodeId}&`
      );
      return list.js;
    },
  },
  {
    method: "GET",
    path: "/api/play/{slug*}",
    handler: async (request, h) => {
      const slug: string = request.params.slug;
      const series: string = request.query.series ?? "";

      const catagory = await fetchData(
        "/server/load.php?type=vod&action=create_link&force_ch_link_check=0&disable_ad=0&download=0&forced_stop_range=&series=" +
          series +
          "&cmd=" +
          encodeURIComponent("/media/file_" + slug + ".mpg")
      );
      //   const catagory = await fetchData("/storage/rest.php");
      return catagory;
    },
  },
];
