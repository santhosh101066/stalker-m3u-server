import {
  ArrayData,
  Channel,
  Data,
  EPG_List,
  Genre,
  M3U,
  M3ULine,
  Programs,
} from "@/types/types";
import { fetchData } from "./fetch";
import { initialConfig } from "@/config/server";


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
    command: `http://192.168.0.102:3000/live.m3u8?cmd=${encodeURIComponent(
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
      return genre && initialConfig.groups.includes(genre.title);
    })
    .map((channel) => {
      const genre = genres.js.find((r) => r.id === channel.tv_genre_id)!;
      return channelToM3u(channel, genre.title);
    })
    .sort(
      (a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name)
    );

  return new M3U(m3u).print(initialConfig);
}

export async function getEPG() {
  const genres = await fetchData<ArrayData<Genre>>(
    "/server/load.php?type=itv&action=get_genres"
  );
  const allPrograms = await fetchData<Data<Programs<Channel>>>(
    "/server/load.php?type=itv&action=get_all_channels"
  );

  const channels = (allPrograms.js.data ?? []).filter((channel) => {
    const genre = genres.js.find((r) => r.id === channel.tv_genre_id);
    return genre && initialConfig.groups.includes(genre.title);
  });

  let xmltv = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xmltv += '<!DOCTYPE tv SYSTEM "xmltv.dtd">\n';
  xmltv += '<tv generator-info-name="Stalker M3U Server">\n';

  // Add channel definitions
  channels.forEach(channel => {
    xmltv += `  <channel id="${channel.id}">\n`;
    xmltv += `    <display-name>${channel.name}</display-name>\n`;
    xmltv += `    <icon src="${decodeURI(channel.logo)}"/>\n`;
    xmltv += `  </channel>\n`;
  });

  // Add programme data
  // Fetch first channel EPG sequentially
  if (channels.length > 0) {
    const firstChannel = channels[0];
    const firstEpg = await fetchData<ArrayData<EPG_List>>(
      `/server/load.php?type=epg&action=get_all_program_for_ch&ch_id=${firstChannel.id}`,
      false,
      {},
      "",
      initialConfig,
      false
    );
    
    if (firstEpg?.js) {
      firstEpg.js.forEach(program => {
        xmltv += `  <programme start="${formatTimestamp(program.start_timestamp)}" stop="${formatTimestamp(program.stop_timestamp)}" channel="${firstChannel.id}">\n`;
        xmltv += `    <title>${escapeXML(program.name)}</title>\n`;
        xmltv += `  </programme>\n`;
      });
    }
  }

  // Fetch remaining channels in parallel
  const remainingChannels = channels.slice(1);
  await Promise.all(
    remainingChannels.map(async (channel) => {
      try {
        const epg = await fetchData<ArrayData<EPG_List>>(
          `/server/load.php?type=epg&action=get_all_program_for_ch&ch_id=${channel.id}`,
          false,
          {},
          "",
          initialConfig,
          true
        );
        
        if (epg?.js) {
          epg.js.forEach(program => {
            xmltv += `  <programme start="${formatTimestamp(program.start_timestamp)}" stop="${formatTimestamp(program.stop_timestamp)}" channel="${channel.id}">\n`;
            xmltv += `    <title>${escapeXML(program.name)}</title>\n`;
            xmltv += `  </programme>\n`;
          });
        }
      } catch (error) {
        console.error(`Failed to fetch EPG data for channel ${channel.name}:`, error);
      }
    })
  );

  xmltv += '</tv>';
  return xmltv;
}
function formatTimestamp(timestamp: string): string {
    const date = new Date(parseInt(timestamp) * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
  
    const year = date.getUTCFullYear();
    const month = pad(date.getUTCMonth() + 1);
    const day = pad(date.getUTCDate());
    const hours = pad(date.getUTCHours());
    const minutes = pad(date.getUTCMinutes());
    const seconds = pad(date.getUTCSeconds());
  
    return `${year}${month}${day}${hours}${minutes}${seconds} +0000`;
  }

function escapeXML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
