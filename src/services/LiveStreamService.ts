import { httpClient } from "@/utils/httpClient";
import { appConfig } from "@/config/server";
import { serverManager } from "@/serverManager";
import NodeCache from "node-cache";
import { AxiosResponse } from "axios";
import crypto from "crypto";
import { logger } from "@/utils/logger";

interface CacheRecord {
    baseUrl: string;
    segments: Map<number, string>;
    subpath?: string;
    subpathRedirects?: Map<string, string>;
    variantBaseUrl?: string;
}

export class LiveStreamService {
    private cache: NodeCache;
    private pendingCommands: Map<string, Promise<string | null>>;
    private secretKey: string;
    private sequenceRegex = /#EXT-X-MEDIA-SEQUENCE:(\d+)/;

    constructor() {
        this.cache = new NodeCache({ stdTTL: 600, checkperiod: 60 });
        this.pendingCommands = new Map();
        this.secretKey = appConfig.proxy.secretKey;
    }

    public generateSignedUrl(resourceId: string): string {
        const sig = crypto
            .createHmac("sha256", this.secretKey)
            .update(resourceId)
            .digest("hex");
        return `/player/${encodeURIComponent(resourceId)}.ts?sig=${sig}`;
    }

    public verifySignedUrl(resourceId: string, sig: string): boolean {
        const expectedSig = crypto
            .createHmac("sha256", this.secretKey)
            .update(resourceId)
            .digest("hex");
        return sig === expectedSig;
    }

    private async populateCache(cmd: string): Promise<string> {
        if (this.pendingCommands.has(cmd)) {
            const result = await this.pendingCommands.get(cmd)!;
            if (result === null) {
                throw new Error("Stream Not Found");
            }
            return result;
        }

        const promise = serverManager.getProvider().getChannelLink(cmd).then(res => res.js.cmd);
        this.pendingCommands.set(cmd, promise);

        const masterUrl = await promise.finally(() => {
            this.pendingCommands.delete(cmd);
        });

        if (!masterUrl) {
            throw new Error("Stream Not Found");
        }

        const res = await httpClient.get(masterUrl);

        if (res.status >= 400) {
            throw new Error(`Upstream Error ${res.status}`);
        }

        // Use the final URL after redirects to determine the base URL
        const finalUrl = res.request?.res?.responseUrl || masterUrl;
        const baseUrl = finalUrl.substring(0, finalUrl.lastIndexOf("/") + 1);

        const seqMatch = res.data.match(this.sequenceRegex);
        let currentSeq = seqMatch ? parseInt(seqMatch[1], 10) : 0;

        const lines = res.data.split("\n");
        const segments = new Map<number, string>();

        const modifiedLines = lines.map((line: string) => {
            if (line.startsWith("#") || line.trim() === "") {
                return line;
            }
            if (line.endsWith(".m3u8")) {
                return `/live.m3u8?cmd=${encodeURIComponent(cmd)}&play=1&subpath=${encodeURIComponent(line)}`;
            }

            const resourceId = `${cmd}<_>${currentSeq}`;
            segments.set(currentSeq, line);
            currentSeq++;

            return this.generateSignedUrl(resourceId);
        });

        this.cache.set(cmd, { baseUrl, segments } as CacheRecord);
        return modifiedLines.join("\n");
    }

    public async getPlaylist(cmd: string, play: string | undefined, subpathQuery?: string): Promise<string | { error: string, code: number }> {
        logger.info(`[LiveStreamService] getPlaylist called for cmd=${cmd} play=${play} subpath=${subpathQuery}`);
        try {
            if (!this.cache.get(cmd)) {
                await this.populateCache(cmd);
            }
            const record: CacheRecord | undefined = this.cache.get(cmd);
            if (!record) {
                return { error: "Stream Not Found", code: 404 };
            }

            const fetchPlaylist = async (url: string, isSubpath: boolean = false) => {
                const res = await httpClient.get(url);

                if (!isSubpath && [301, 302, 403].includes(res.status)) {
                    const newMasterUrl = await serverManager.getProvider().getChannelLink(cmd).then(res => res.js.cmd);

                    if (newMasterUrl) {
                        const refreshedRes = await httpClient.get(newMasterUrl);

                        // Use final URL from refreshed response
                        const finalUrl = refreshedRes.request?.res?.responseUrl || newMasterUrl;
                        const newBaseUrl = finalUrl.substring(0, finalUrl.lastIndexOf("/") + 1);

                        if (record) {
                            record.baseUrl = newBaseUrl;
                            this.cache.set(cmd, record as CacheRecord);
                        }
                        return refreshedRes;
                    }
                }
                return res;
            };

            let subpath = subpathQuery || record.subpath;

            // Check for cached redirect for this subpath (handling expired tokens)
            if (subpath && record.subpathRedirects && record.subpathRedirects.has(subpath)) {
                subpath = record.subpathRedirects.get(subpath);
            }

            if (play === "1" && subpath) {
                logger.info(`[LiveStreamService] Fetching media playlist for subpath: ${subpath}`);
                const subUrl = new URL(subpath, record.baseUrl).href;
                let res = await fetchPlaylist(subUrl, true);

                if (res.status < 200 || res.status >= 300 || !res.data) {
                    logger.warn(`[LiveStreamService] Subpath fetch failed (status ${res.status}). Refreshing master URL...`);
                    // Retry logic for empty data (master url refresh)...
                    const newMasterUrl = await serverManager.getProvider().getChannelLink(cmd).then(res => res.js.cmd);
                    if (!newMasterUrl) return { error: "Stream Not Found", code: 404 };

                    const refreshedRes = await httpClient.get(newMasterUrl);

                    // Use final URL from refreshed response
                    const finalUrl = refreshedRes.request?.res?.responseUrl || newMasterUrl;
                    const newBaseUrl = finalUrl.substring(0, finalUrl.lastIndexOf("/") + 1);

                    if (refreshedRes.status < 200 || refreshedRes.status >= 300 || !refreshedRes.data) {
                        return { error: `Upstream Error ${refreshedRes.status}`, code: refreshedRes.status };
                    }

                    record.baseUrl = newBaseUrl;

                    // Parse new master playlist to find correct new subpath (with new token)
                    const lines = refreshedRes.data.split('\n');
                    let newSubpath = '';

                    // Try to match the filename from the old subpath
                    const oldFilename = subpath.split('?')[0].split('/').pop();

                    for (const line of lines) {
                        if (line.trim().endsWith('.m3u8')) {
                            if (!newSubpath) newSubpath = line.trim(); // Default to first found
                            if (oldFilename && line.includes(oldFilename)) {
                                newSubpath = line.trim();
                                break; // Found exact match
                            }
                        }
                    }

                    // Store the redirect so future requests with the old subpath use the new one
                    if (!record.subpathRedirects) {
                        record.subpathRedirects = new Map();
                    }
                    if (subpathQuery) { // Only map if we have an original key
                        record.subpathRedirects.set(subpathQuery, newSubpath || subpath);
                    }

                    const subUrl = new URL(newSubpath || subpath, record.baseUrl).href;
                    res = await fetchPlaylist(subUrl, true);
                    this.cache.set(cmd, record as CacheRecord);
                }

                // Update variantBaseUrl from the actual response URL
                const finalVariantUrl = res.request?.res?.responseUrl || res.config?.url;
                if (finalVariantUrl) {
                    record.variantBaseUrl = finalVariantUrl.substring(0, finalVariantUrl.lastIndexOf("/") + 1);
                }

                const seqMatch = (res as AxiosResponse).data.match(this.sequenceRegex);
                let currentSeq = seqMatch ? parseInt(seqMatch[1], 10) : 0;

                const lines = (res as AxiosResponse).data.split("\n");
                const modifiedLines = lines.map((line: string) => {
                    if (line.startsWith("#") || line.trim() === "") return line;
                    if (line.match(".m3u8")) return line;

                    const resourceId = `${cmd}<_>${currentSeq}`;
                    record.segments.set(currentSeq, line);
                    currentSeq++;

                    return this.generateSignedUrl(resourceId);
                });

                this.cache.set(cmd, record as CacheRecord);
                const output = modifiedLines.join("\n");
                logger.info(`[LiveStreamService] Generated media playlist (first 5 lines):\n${modifiedLines.slice(0, 5).join("\n")}`);

                if (output.includes("#EXT-X-STREAM-INF")) {
                    logger.warn("[LiveStreamService] WARNING: Returned content looks like a Master Playlist but play=1 was requested!");
                }

                return output;

            } else {
                logger.info(`[LiveStreamService] Returning master playlist for ${cmd} (play=${play})`);
                const masterUrl = await serverManager.getProvider().getChannelLink(cmd).then(res => res.js.cmd);
                const res = await fetchPlaylist(masterUrl);

                if (res.status < 200 || res.status >= 300) {
                    return { error: `Upstream Error ${res.status}`, code: res.status };
                }

                const seqMatch = (res as AxiosResponse).data.match(this.sequenceRegex);
                let currentSeq = seqMatch ? parseInt(seqMatch[1], 10) : 0;

                const lines = (res as AxiosResponse).data.split("\n");
                const modifiedLines = lines.map((line: string) => {
                    if (line.trim() === "") return line;

                    if (line.startsWith("#EXT-X-MEDIA:")) {
                        return line.replace(/URI="([^"]+)"/, (match, uri) => {
                            const newUri = `/live.m3u8?cmd=${encodeURIComponent(cmd)}&play=1&subpath=${encodeURIComponent(uri)}`;
                            return `URI="${newUri}"`;
                        });
                    }

                    if (line.startsWith("#")) return line;

                    if (line.match(".m3u8")) {
                        return `/live.m3u8?cmd=${encodeURIComponent(cmd)}&play=1&subpath=${encodeURIComponent(line)}`;
                    }

                    const resourceId = `${cmd}<_>${currentSeq}`;
                    record.segments.set(currentSeq, line);
                    currentSeq++;

                    return this.generateSignedUrl(resourceId);
                });

                this.cache.set(cmd, record as CacheRecord);
                return modifiedLines.join("\n");
            }
        } catch (error: any) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`Error generating playlist: ${message}`);
            if (message.includes("Upstream Error")) {
                const code = parseInt(message.split(" ").pop() || "500");
                return { error: message, code: isNaN(code) ? 500 : code };
            }
            return { error: "Failed to generate URL", code: 500 };
        }
    }

    public async getSegment(resourceId: string, sig: string, headers: any): Promise<any> {
        if (!resourceId || !sig) throw new Error("Missing parameters");
        if (!this.verifySignedUrl(resourceId, sig)) throw new Error("Invalid signature");

        const [cmd, seqStr] = resourceId.split("<_>");
        const seqId = Number(seqStr);

        let record: CacheRecord | undefined = this.cache.get(cmd);

        if (!record || !record.segments.has(seqId)) {
            await this.populateCache(cmd);
            record = this.cache.get(cmd);
            if (!record || !record.segments.has(seqId)) {
                throw new Error("Segment not found");
            }
        }

        const segmentPath = record.segments.get(seqId);
        if (!segmentPath) throw new Error("Segment path invalid");

        // Use variantBaseUrl if available, otherwise fallback to baseUrl
        const baseUrl = record.variantBaseUrl || record.baseUrl;
        const segmentUrl = new URL(segmentPath, baseUrl).href;

        return await httpClient.get(segmentUrl, {
            responseType: 'stream',
            headers: {
                ...headers,
                host: undefined,
            }
        });
    }
}

export const liveStreamService = new LiveStreamService();
