import {
  ArrayData,
  Channel,
  Data,
  Genre,
  M3U,
  M3ULine,
  Programs,
} from "@/types/types";
import { fetchData } from "./fetch";
import { config } from "@/config/server";

const groups = ["TAMIL", "TAMIL | 24/7"];

function channelToM3u(channel: Channel, group: string): M3ULine {
  return {
    title: `TV - ${group}`,
    name: channel.name.replaceAll(",", "").replaceAll(" - ", "-"),
    header: `#EXTINF:-1 tvg-id="${channel.id}" tvg-name="${channel.name
      .replaceAll(",", "")
      .replaceAll(" - ", "-")}" tvg-logo="${decodeURI(
      channel.logo
    )}" group-title="TV - ${group}",${channel.name
      .replaceAll(",", "")
      .replaceAll(" - ", "-")}`,
    command: `http://192.168.0.108:3000/live?cmd=${encodeURIComponent(
      channel.cmd
    )}`,
  };
}

export async function getM3u() {
  const genres = await fetchData<ArrayData<Genre>>(
    "/server/load.php?type=itv&action=get_genres"
  );
  const allPrograms = await fetchData<Data<Programs<Channel>>>(
    "/server/load.php?type=itv&action=get_all_channels"
  );

  const m3u = (allPrograms.js.data ?? [])
    .filter((channel) => {
      const genre = genres.js.find((r) => r.id === channel.tv_genre_id);
      return genre && groups.includes(genre.title);
    })
    .map((channel) => {
      const genre = genres.js.find((r) => r.id === channel.tv_genre_id)!;
      return channelToM3u(channel, genre.title);
    })
    .sort(
      (a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name)
    );

  return new M3U(m3u).print(config);
}
