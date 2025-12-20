import { ServerRoute } from "@hapi/hapi";
import path from "path";
import fs from "fs";
import { hlsTranscoder } from "@/utils/hls-transcoder";

export const streamRoutes: ServerRoute[] = [
    {
        method: "GET",
        path: "/api/stream/{cmd}/{filename}",
        handler: async (request, h) => {
            const { cmd, filename } = request.params;

            // Update activity timestamp to prevent premature cleanup
            hlsTranscoder.updateActivity(cmd);

            // We don't need to manually encode here because hlsTranscoder.getStreamDir
            // now handles the encoding internally.
            // Hapi decodes the URL param 'cmd', so we pass the raw 'cmd' to getStreamDir,
            // which will re-encode it to find the correct directory.
            const streamDir = hlsTranscoder.getStreamDir(cmd);
            const filePath = path.join(streamDir, filename);

            if (fs.existsSync(filePath)) {
                const response = h.file(filePath);

                if (filename.endsWith('.m3u8')) {
                    response.type('application/vnd.apple.mpegurl');
                } else if (filename.endsWith('.ts')) {
                    response.type('video/mp2t');
                }

                return response;
            }

            // Fallback: Try to start FFmpeg if it's index.m3u8 and not found
            if (filename === 'index.m3u8') {
                try {
                    console.log(`[StreamRoute] Auto-starting stream for ${cmd}`);
                    // cmd is the URL in this context
                    await hlsTranscoder.startStream(cmd, cmd);

                    if (fs.existsSync(filePath)) {
                        const response = h.file(filePath);
                        response.type('application/vnd.apple.mpegurl');
                        return response;
                    }
                } catch (error) {
                    console.error(`[StreamRoute] Failed to auto-start stream: ${error}`);
                }
            }

            return h.response('Not Found').code(404);
        },
    },
];
