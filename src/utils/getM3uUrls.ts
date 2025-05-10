import { ArrayData, Channel, Data, Genre, M3U, M3ULine, Programs, Tvg } from "@/types/types";
import { fetchData } from "./fetch";

import { readFileSync, writeFileSync } from "fs";
import { READ_OPTIONS } from "@/constants/common";
import { config } from "@/config/server";

const tvgData: Tvg = JSON.parse(readFileSync('./tvg.json',{encoding:"utf-8",flag:"r"})) as Tvg;
const groups = ["TAMIL",
"TAMIL | 24/7"]
function removeAccent(str: string): string {
    return str.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function getTvgId(channel: Channel): string {
    let tvgId: string = '';

    for (const iterator of Object.entries(tvgData)) {
        if (!!iterator[1].find(term => removeAccent(channel.name.toLocaleLowerCase())
            .includes(removeAccent(term.toLocaleLowerCase())))) {
            tvgId = iterator[0];
            break;
        }
    }

    return tvgId;
}


function channelToM3u(channel: Channel, group: string): M3ULine {
    const lines: M3ULine = <M3ULine>{};

    // const tvgId: string = !!config.tvgIdPreFill ? getTvgId(channel) : '';

    lines.title = `TV - ${group}`;
    lines.name = channel.name
        // Special characters such as "-" and "," mess with the rendering of names
        .replaceAll(",", "")
        .replaceAll(" - ", "-");
    lines.header = `#EXTINF:-1 tvg-id="${channel.id}" tvg-name="${lines.name}" tvg-logo="${decodeURI(channel.logo)}" group-title="${lines.title}",${lines.name}`;
    lines.command = "http://192.168.0.108:3000/live?cmd="+encodeURIComponent(channel.cmd);

    return lines;
}

export async function getM3u(){
  const genres = (
    await fetchData<ArrayData<Genre>>(
      "/server/load.php?" + "type=itv&action=get_genres"
    )
  ).js;
  const m3u: M3ULine[] = [];
  const allPrograms = await fetchData<Data<Programs<Channel>>>(
    "/server/load.php?type=itv&action=get_all_channels"
  );

  allPrograms.js.data = allPrograms.js.data ?? [];

  for (const channel of allPrograms.js.data) {
    const genre: Genre = genres.find((r) => r.id === channel.tv_genre_id)!;

    if (!!genre && !!genre.title && groups.includes(genre.title)) {
        console.log(channel);
        
      m3u.push(channelToM3u(channel, genre.title));
    }
  }
  let sorting: (a: M3ULine, b: M3ULine) => number = (a, b) => {
    return a.title.localeCompare(b.title) || a.name.localeCompare(b.name);
  };

  return new M3U(m3u.sort(sorting)).print(config)

}

