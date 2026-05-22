import { PassThrough } from "stream";
import { httpClient } from "@/utils/httpClient";
import { logger } from "@/utils/logger";

interface Segment {
  url: string;
  sequence: number;
}

function parsePlaylist(body: string, baseUrl: string): {
  segments: Segment[];
  targetDuration: number;
  isEnd: boolean;
} {
  const lines = body.split("\n").map((l) => l.trim());
  const segments: Segment[] = [];
  let targetDuration = 6;
  let isEnd = false;
  let seq = 0;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = parseInt(line.slice(22));
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      seq = parseInt(line.slice(22));
    } else if (line === "#EXT-X-ENDLIST") {
      isEnd = true;
    } else if (line && !line.startsWith("#")) {
      segments.push({ url: new URL(line, baseUrl).href, sequence: seq++ });
    }
  }

  return { segments, targetDuration, isEnd };
}

function wait(ms: number, stopped: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      if (stopped()) { clearInterval(tick); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(tick); resolve(); }, ms);
  });
}

export function startHlsTsProxy(
  variantUrl: string,
  refreshVariantUrl: () => Promise<string>,
): PassThrough {
  const output = new PassThrough();
  let stopped = false;

  output.on("close", () => { stopped = true; });
  output.on("error", () => { stopped = true; });

  (async () => {
    let lastSequence = -1;
    let currentVariantUrl = variantUrl;

    logger.info(`[TsProxy] Starting stream`);

    while (!stopped) {
      try {
        const playlistRes = await httpClient.get<string>(currentVariantUrl, {
          responseType: "text",
          headers: { "User-Agent": "VLC/3.0.16 LibVLC/3.0.16" },
        });

        const { segments, targetDuration, isEnd } = parsePlaylist(playlistRes.data, currentVariantUrl);

        if (lastSequence === -1) {
          // Start near live edge — skip all but last 3 segments to minimise initial buffering
          lastSequence = segments.length > 3
            ? segments[segments.length - 4].sequence
            : (segments[0]?.sequence ?? 1) - 1;
        }

        const newSegments = segments.filter((s) => s.sequence > lastSequence);

        for (const seg of newSegments) {
          if (stopped) break;
          try {
            const segRes = await httpClient.get<ArrayBuffer>(seg.url, {
              responseType: "arraybuffer",
              headers: { "User-Agent": "VLC/3.0.16 LibVLC/3.0.16" },
            });
            if (!output.writableEnded) {
              output.write(Buffer.from(segRes.data));
            }
            lastSequence = seg.sequence;
            logger.info(`[TsProxy] Piped seg ${seg.sequence} (${(segRes.data as ArrayBuffer).byteLength} bytes)`);
          } catch (segErr: any) {
            logger.error(`[TsProxy] Segment ${seg.sequence} error: ${segErr.message}`);
            if (segErr.response?.status === 403) {
              logger.info("[TsProxy] Token expired on segment, refreshing...");
              try { currentVariantUrl = await refreshVariantUrl(); } catch { stopped = true; }
              break;
            }
          }
        }

        if (isEnd || stopped) break;

        await wait(Math.max(targetDuration * 500, 1000), () => stopped);

      } catch (err: any) {
        logger.error(`[TsProxy] Playlist error: ${err.message}`);
        if (err.response?.status === 403) {
          logger.info("[TsProxy] Token expired on playlist, refreshing...");
          try { currentVariantUrl = await refreshVariantUrl(); } catch { break; }
        } else {
          await wait(2000, () => stopped);
        }
      }
    }

    if (!output.writableEnded) output.end();
    logger.info("[TsProxy] Stream ended");
  })();

  return output;
}
