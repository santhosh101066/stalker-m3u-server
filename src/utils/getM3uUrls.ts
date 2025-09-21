import {
  Channel,
  Genre,
  M3U,
  M3ULine,
} from "@/types/types";
import { initialConfig } from "@/config/server";
import { readJSON } from "./storage";
import { stalkerApi } from "./stalker";

function channelToM3u(channel: Channel, group: string, host: string): M3ULine {
  return {
    title: `TV - ${group}`,
    name: channel.name.replaceAll(",", "").replaceAll(" - ", "-"),
    header: `#EXTINF:-1 tvg-id="${channel.id}" tvg-name="${channel.name
      .replaceAll(",", "")
      .replaceAll(" - ", "-")}" tvg-logo="${channel.logo
        ? channel.logo.startsWith("http")
          ? channel.logo
          : decodeURI(
            `http://${initialConfig.hostname}:${initialConfig.port}${initialConfig.contextPath !== ""
              ? "/" + initialConfig.contextPath
              : ""
            }/misc/logos/320/${channel.logo}`
          )
        : ""
      }" group-title="TV - ${group}",${channel.name
        .replaceAll(",", "")
        .replaceAll(" - ", "-")}`,
    command: channel.cmd.includes(initialConfig.hostname)
      ? `http://${host}/portal/proxy?url=${encodeURIComponent(
        btoa(channel.cmd.split(" ").at(1) ?? "")
      )}`
      : `http://${host}/live.m3u8?cmd=${encodeURIComponent(channel.cmd)}`,
  };
}


export async function getPlaylistV2() {
  const genres = readJSON<Genre>("channel-groups.json");
  const allPrograms = await stalkerApi.getChannels();
  const m3u = (allPrograms.js.data ?? []).filter((channel) => {
    const genre = genres.find((r) => r.id === channel.tv_genre_id);
    return genre && initialConfig.groups.includes(genre.title);
  });
  return m3u;
}

export async function getM3uV2(host: string) {
  const genres = readJSON<Genre>("channel-groups.json");
  const allPrograms = readJSON<Channel>("channels.json");
  // const m3u = (allPrograms.js.data ?? []).filter((channel) => {
  //   const genre = genres.find((r) => r.id === channel.tv_genre_id);
  //   return genre && initialConfig.groups.includes(genre.title);
  // });

  const m3u = (allPrograms ?? [])
    .filter((channel) => {
      const genre = genres.find((r) => r.id === channel.tv_genre_id);
      return genre && initialConfig.groups.includes(genre.title);
    })
    .map((channel) => {
      const genre = genres.find((r) => r.id === channel.tv_genre_id)!;
      return channelToM3u(channel, genre.title, host);
    })
    .sort(
      (a, b) => a.title.localeCompare(b.title) || a.name.localeCompare(b.name)
    );

  return new M3U(m3u).print(initialConfig);
}


export async function getEPGV2() {
  const genres = readJSON<Genre>("channel-groups.json");
  const allPrograms = await stalkerApi.getChannels();
  const channels = (allPrograms.js.data ?? []).filter((channel) => {
    const genre = genres.find((r) => r.id === channel.tv_genre_id);
    return genre && initialConfig.groups.includes(genre.title);
  });

  let xmltv = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xmltv += '<!DOCTYPE tv SYSTEM "xmltv.dtd">\n';
  xmltv += '<tv generator-info-name="Stalker M3U Server">\n';

  // Add channel definitions
  channels.forEach((channel) => {
    xmltv += `  <channel id="${channel.id}">\n`;
    xmltv += `    <display-name>${channel.name}</display-name>\n`;
    xmltv += `    <icon src="${channel.logo
      ? decodeURI(
        `http://${initialConfig.hostname}:${initialConfig.port}${initialConfig.contextPath !== ""
          ? "/" + initialConfig.contextPath
          : ""
        }/misc/logos/320/${channel.logo}`
      )
      : ""
      }"/>\n`;
    xmltv += `  </channel>\n`;
  });

  // Add programme data for all channels in parallel
  await Promise.all(
    channels.map(async (channel) => {
      try {
        const epg = await stalkerApi.getEPG(channel.id);
        if (epg?.js) {
          epg.js.forEach((program) => {
            xmltv += `  <programme start="${formatTimestamp(
              program.start_timestamp
            )}" stop="${formatTimestamp(program.stop_timestamp)}" channel="${channel.id
              }">\n`;
            xmltv += `    <title>${escapeXML(program.name)}</title>\n`;
            xmltv += `  </programme>\n`;
          });
        }
      } catch (error) {
        console.error(
          `Failed to fetch EPG data for channel ${channel.name}:`,
          error
        );
      }
    })
  );

  xmltv += "</tv>";
  return xmltv;
}
function formatTimestamp(timestamp: string): string {
  const date = new Date(parseInt(timestamp) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");

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
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
