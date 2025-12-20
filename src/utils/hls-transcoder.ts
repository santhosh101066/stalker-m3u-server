import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { probeMedia } from './probe';

interface StreamSession {
    process: ChildProcess;
    lastAccess: number;
    cmd: string;
    sessionId?: string;
}

class HlsTranscoder {
    private activeStreams: Map<string, StreamSession> = new Map();
    private tempDir: string;
    private cleanupInterval: NodeJS.Timeout;

    constructor() {
        this.tempDir = path.join(process.cwd(), 'temp', 'live');
        // Clean up all temp files on startup
        this.cleanupAll();

        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }

        // Run cleanup every 30 seconds
        this.cleanupInterval = setInterval(() => this.cleanup(), 30000);
    }

    private cleanupAll() {
        if (fs.existsSync(this.tempDir)) {
            try {
                console.log('[HLS] Cleaning up all temp files on startup...');
                fs.rmSync(this.tempDir, { recursive: true, force: true });
            } catch (error) {
                console.error('[HLS] Error cleaning up temp dir:', error);
            }
        }
    }

    public async startStream(cmd: string, inputUrl: string, sessionId?: string, startTime?: number): Promise<string> {
        // Create a unique key for this stream session
        // If sessionId is provided, append it to cmd. This allows multiple users to watch the same content at different times.
        const streamKey = sessionId ? `${cmd}_${sessionId}` : cmd;
        const safeCmd = encodeURIComponent(streamKey);
        const streamDir = path.join(this.tempDir, safeCmd);
        const playlistPath = path.join(streamDir, 'index.m3u8');

        if (this.activeStreams.has(streamKey)) {
            this.activeStreams.get(streamKey)!.lastAccess = Date.now();
            return `/api/stream/${safeCmd}/index.m3u8`;
        }

        // Clean up any leftover files for this cmd
        if (fs.existsSync(streamDir)) {
            await fs.promises.rm(streamDir, { recursive: true, force: true });
        }
        fs.mkdirSync(streamDir, { recursive: true });

        // Stop other streams for the same session
        if (sessionId) {
            for (const [key, session] of this.activeStreams.entries()) {
                if (session.sessionId === sessionId && key !== streamKey) {
                    console.log(`[HLS] Stopping previous stream ${key} for session ${sessionId}`);
                    this.stopStream(key);
                }
            }
        }

        console.log(`[HLS] Starting transcoding for ${streamKey} (Start: ${startTime || 0}s)`);

        const ffmpegArgs = [
            '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            '-reconnect', '1',
            '-reconnect_at_eof', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '2',
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
            '-i', inputUrl,
            '-map', '0:v',
            '-map', '0:a?',
            '-map', '0:s?',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-ar', '44100',
            '-ac', '2',
            '-b:a', '128k',
            '-f', 'hls',
            '-hls_time', '10', // 10 second segments
            '-hls_list_size', '5', // Keep 5 segments in playlist for live
            '-hls_flags', 'delete_segments', // Delete old segments
            '-hls_segment_filename', path.join(streamDir, 'segment_%03d.ts'),
            playlistPath
        ];

        // Inject seeking before input if startTime is provided
        if (startTime && startTime > 0) {
            ffmpegArgs.unshift('-ss', startTime.toString());
        }

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);

        ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString();
            if (msg.includes('Error') || msg.includes('fail') || msg.includes('Invalid') || msg.includes('403') || msg.includes('404')) {
                console.log(`[FFmpeg ${streamKey}] ${msg}`);
                if (msg.includes('404 Not Found') || msg.includes('403 Forbidden')) {
                    console.log(`[HLS] Critical error detected for ${streamKey}, stopping stream.`);
                    this.stopStream(streamKey);
                }
            }
        });

        ffmpeg.on('close', (code) => {
            console.log(`[HLS] FFmpeg process for ${streamKey} exited with code ${code}`);
            if (this.activeStreams.has(streamKey)) {
                this.activeStreams.delete(streamKey);
            }
        });

        this.activeStreams.set(streamKey, {
            process: ffmpeg,
            lastAccess: Date.now(),
            cmd: streamKey,
            sessionId: sessionId
        });

        // Wait for the playlist to be created before returning
        return new Promise((resolve, reject) => {
            const checkInterval = setInterval(() => {
                if (fs.existsSync(playlistPath)) {
                    const stats = fs.statSync(playlistPath);
                    if (stats.size > 0) {
                        clearInterval(checkInterval);
                        resolve(`/api/stream/${safeCmd}/index.m3u8`);
                    }
                }
                // Check if process died
                if (ffmpeg.exitCode !== null) {
                    clearInterval(checkInterval);
                    reject(new Error('FFmpeg process exited before creating playlist'));
                }
            }, 500);

            // Timeout after 15 seconds
            setTimeout(() => {
                clearInterval(checkInterval);
                if (!fs.existsSync(playlistPath)) {
                    this.stopStream(streamKey);
                    reject(new Error('Timeout waiting for playlist generation'));
                }
            }, 15000);
        });
    }

    public updateActivity(cmd: string) {
        // cmd here might be the streamKey (encoded in URL)
        // We need to decode it to match the map key
        const decodedCmd = decodeURIComponent(cmd);
        if (this.activeStreams.has(decodedCmd)) {
            this.activeStreams.get(decodedCmd)!.lastAccess = Date.now();
        }
    }

    public stopStream(cmd: string) {
        const session = this.activeStreams.get(cmd);
        if (session) {
            console.log(`[HLS] Stopping stream ${cmd}`);
            session.process.kill();
            this.activeStreams.delete(cmd);

            const safeCmd = encodeURIComponent(cmd);
            const streamDir = path.join(this.tempDir, safeCmd);
            // Delay deletion slightly to ensure process release
            setTimeout(() => {
                fs.promises.rm(streamDir, { recursive: true, force: true }).catch(err => console.error(`[HLS] Failed to clean dir ${streamDir}`, err));
            }, 1000);
        }
    }

    private cleanup() {
        const now = Date.now();
        const TIMEOUT = 1 * 60 * 1000; // 1 minute

        for (const [cmd, session] of this.activeStreams.entries()) {
            if (now - session.lastAccess > TIMEOUT) {
                console.log(`[HLS] Stream ${cmd} inactive for > 1 min, cleaning up.`);
                this.stopStream(cmd);
            }
        }
    }

    public getStreamDir(cmd: string): string {
        // cmd comes from URL param, so it might be encoded or not.
        // But getStreamDir is usually called with the raw param from Hapi.
        // We ensure we look for the directory matching the streamKey.
        // If cmd is already encoded, we might double encode if we are not careful,
        // but here we assume 'cmd' is the raw streamKey.
        return path.join(this.tempDir, encodeURIComponent(cmd));
    }
    public async startVODStream(cmd: string, inputUrl: string, sessionId: string, startTime: number = 0): Promise<string> {
        const streamKey = `${cmd}_${sessionId}`;
        const safeCmd = encodeURIComponent(streamKey);
        const streamDir = path.join(this.tempDir, safeCmd);
        const masterPlaylistPath = path.join(streamDir, 'index.m3u8');

        if (this.activeStreams.has(streamKey)) {
            this.activeStreams.get(streamKey)!.lastAccess = Date.now();
            return `/api/stream/${safeCmd}/index.m3u8`;
        }

        // Clean up
        if (fs.existsSync(streamDir)) {
            await fs.promises.rm(streamDir, { recursive: true, force: true });
        }
        fs.mkdirSync(streamDir, { recursive: true });

        console.log(`[HLS-VOD] Probing ${inputUrl}`);
        let probeData;
        try {
            probeData = await probeMedia(inputUrl);
        } catch (e) {
            console.error(`[HLS-VOD] Probe failed: ${e}`);
            throw e;
        }

        const audioStreams = probeData.streams.filter(s => s.codec_type === 'audio');
        console.log(`[HLS-VOD] Found ${audioStreams.length} audio streams`);

        const ffmpegArgs = [
            '-i', inputUrl,
            '-y',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-c:a', 'aac',
            '-ar', '44100',
            '-ac', '2',
            '-b:a', '128k',
            '-sn', // Disable subtitles for now
            '-f', 'hls',
            '-hls_time', '10',
            '-hls_list_size', '0',
            '-hls_flags', 'delete_segments',
            '-master_pl_name', 'index.m3u8',
            '-hls_segment_filename', path.join(streamDir, 'stream_%v_data%03d.ts'),
        ];

        // Map Video
        ffmpegArgs.push('-map', '0:v:0');

        // Map Audio Streams
        audioStreams.forEach((s, i) => {
            ffmpegArgs.push('-map', `0:a:${i}`);
        });

        // Construct var_stream_map
        let varStreamMap = `v:0,agroup:audio,name:video`;
        audioStreams.forEach((s, i) => {
            const lang = s.tags?.language || s.tags?.LANG || `aud${i}`;
            const name = s.tags?.title || s.tags?.handler_name || `Audio ${i + 1}`;
            const safeLang = lang.replace(/[^a-zA-Z0-9]/g, '').substr(0, 3) || 'und';
            const safeName = name.replace(/[^a-zA-Z0-9 ]/g, '') || `Audio ${i + 1}`;

            varStreamMap += ` a:${i},agroup:audio,name:"${safeName}",language:${safeLang}`;
        });

        ffmpegArgs.push('-var_stream_map', varStreamMap);

        // Output variant stream pattern
        ffmpegArgs.push(path.join(streamDir, 'stream_%v.m3u8'));

        // Inject seeking
        if (startTime && startTime > 0) {
            ffmpegArgs.unshift('-ss', startTime.toString());
        }

        console.log(`[HLS-VOD] Starting transcoding for ${streamKey}`);

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);

        ffmpeg.stderr.on('data', (data) => {
            // console.log(`[FFmpeg VOD] ${data}`);
        });

        ffmpeg.on('close', (code) => {
            console.log(`[HLS-VOD] Process exited with code ${code}`);
            if (this.activeStreams.has(streamKey)) {
                this.activeStreams.delete(streamKey);
            }
        });

        this.activeStreams.set(streamKey, {
            process: ffmpeg,
            lastAccess: Date.now(),
            cmd: streamKey
        });

        return new Promise((resolve, reject) => {
            const checkInterval = setInterval(() => {
                if (fs.existsSync(masterPlaylistPath)) {
                    clearInterval(checkInterval);
                    resolve(`/api/stream/${safeCmd}/index.m3u8`);
                }
                if (ffmpeg.exitCode !== null) {
                    clearInterval(checkInterval);
                    reject(new Error('FFmpeg process exited before creating playlist'));
                }
            }, 500);

            setTimeout(() => {
                clearInterval(checkInterval);
                if (!fs.existsSync(masterPlaylistPath)) {
                    this.stopStream(streamKey);
                    reject(new Error('Timeout waiting for playlist'));
                }
            }, 20000);
        });
    }
}

export const hlsTranscoder = new HlsTranscoder();
