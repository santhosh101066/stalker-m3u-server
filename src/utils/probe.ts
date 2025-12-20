import { spawn } from 'child_process';

export interface StreamInfo {
    index: number;
    codec_type: 'video' | 'audio' | 'subtitle';
    codec_name: string;
    tags?: Record<string, string>;
    channels?: number;
}

export interface ProbeResult {
    streams: StreamInfo[];
    format: any;
}

export async function probeMedia(url: string): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            url
        ]);

        let stdout = '';

        ffprobe.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        ffprobe.on('close', (code) => {
            if (code === 0) {
                try {
                    const data = JSON.parse(stdout);
                    resolve(data);
                } catch (e) {
                    reject(new Error('Failed to parse ffprobe output'));
                }
            } else {
                reject(new Error(`ffprobe exited with code ${code}`));
            }
        });

        ffprobe.on('error', (err) => {
            reject(err);
        });
    });
}
