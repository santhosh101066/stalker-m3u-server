import {
  ArrayData,
  Channel,
  Data,
  GenerationKind,
  generationKindNames,
  GenerationKindType,
  Genre,
  Programs,
} from "@/types/types";
import { fetchData } from "./fetch";
import { initialConfig } from "@/config/server";

const generationKind = "iptv";

function getActionAndType(kind: GenerationKind) {
  switch (kind) {
    case generationKindNames[0]:
      return "type=itv&action=get_genres";
    case generationKindNames[1]:
      return "type=vod&action=get_categories";
    case generationKindNames[2]:
      return "type=series&action=get_categories";
  }
}
export async function generateGroup() {
  const response = await fetchData<ArrayData<Genre>>(
    "/server/load.php?" + getActionAndType(generationKind)
  );
  console.log(response);
  

  return (response.js ?? [])
    .filter((t) => t.title !== "All" && t.censored !== 1)
    .map(({ title }) => title);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function generateFilteredGroup() {
  const genres = await fetchData<ArrayData<Genre>>(
    "/server/load.php?type=itv&action=get_genres"
  );
  await delay(500);
  const allPrograms = await fetchData<Data<Programs<Channel>>>(
    "/server/load.php?type=itv&action=get_all_channels"
  );
  const channels = (allPrograms.js.data ?? [])
    .filter((channel) => {
      const genre = genres.js.find((r) => r.id === channel.tv_genre_id);
      return genre && initialConfig.groups.includes(genre.title);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const group: Record<
    string,
    {
      id: string;
      title: string;
      number: number;
      alias: string;
      censored: number;
      channels: Channel[];
    }
  > = {};
  group["All Channels"] = {
    title: "All Channels",
    channels,
    id: "0",
    number: 0,
    alias: "",
    censored: 0,
  };
  channels.forEach((channel, i) => {
    const genre = genres.js.find((r) => r.id === channel.tv_genre_id);
    channel.number = i;
    if (genre) {
      if (!group[genre.title]) {
        group[genre.title] = { ...genre, channels: [] };
      }
      group[genre.title].channels.push(channel);
    }
  });

  return group;
}
