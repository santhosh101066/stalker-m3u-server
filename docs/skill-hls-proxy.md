# HLS Transcode Proxy — Skill Reference

FFmpeg-based transcode proxy for VOD and series content. Implemented in `src/routes/hls.ts` (commit `b65523d`).

---

## What It Does

Transcodes any streamable URL into an HLS playlist with `.ts` segments. Useful for:
- Players that can't handle the portal's native stream format
- Seeking in non-seekable containers
- Selecting specific audio tracks from multi-language streams

**Requires FFmpeg** installed (`ffmpeg` + `ffprobe` on PATH). Included in the Docker image.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/media/info?url=` | Probe URL — returns `{ duration, audio[], subtitles[] }` |
| `GET` | `/api/media/hls/master.m3u8?url=` | Master HLS playlist listing all audio tracks |
| `GET` | `/api/media/hls/session/{sessionId}/{file}` | Individual media playlist or `.ts` segment |
| `GET` | `/api/media/subtitle?url=&index=` | Extract and serve a subtitle track |

---

## Architecture

### 1. Probe (`/api/media/info`)
- Runs `ffprobe` on the URL
- Returns `duration`, `audio` tracks (index, codec, language, title), `subtitle` tracks
- Result cached in `node-cache` for 6 hours (`metadataCache`)

### 2. Master Playlist (`/api/media/hls/master.m3u8`)
- Builds an HLS master playlist from probe results
- Each audio track → `#EXT-X-MEDIA` group + `playlist_audio_{N}.m3u8` URI
- A default video-only variant is always included

### 3. Sessions (`/api/media/hls/session/{sessionId}/...`)
- `sessionId` is a hash of the source URL
- Media playlists are VOD-type with timestamp-encoded segment URIs: `seg_video_0.ts?start=0.000`
- Segment duration: **6 seconds** (`SEGMENT_DURATION` constant)
- FFmpeg is spawned per session, writing `.ts` files to `temp/hls/{sessionId}/`

### 4. Seeking
- Seek is encoded in the segment URI `?start=N.NNN` query param
- Handler extracts `start`, passes `-ss N.NNN` to FFmpeg on restart
- Race-guard: `isRestarting` flag + debounce on `lastSeekTime` prevent parallel restart races

### 5. Subtitle Extraction
- `ffmpeg -map 0:s:{index} -f webvtt` pipes the track as WebVTT to the response

---

## Session Lifecycle

```
activeSessions: Map<sessionId, HLSSession>
```

Each `HLSSession` holds:
- `url` — source URL
- `process` — spawned FFmpeg `ChildProcess` (or null)
- `currentStartNumber` — absolute segment index FFmpeg started from
- `restartTargetSeg` — target segment index during a seek restart
- `lastAccess` — timestamp for idle detection
- `metadata` — probed `MediaMetadata`
- `isRestarting` — race guard flag
- `lastSeekTime` — debounce timestamp

### Cleanup watchdog
- Runs every 10 seconds
- Any session idle > 60 seconds: `SIGKILL` FFmpeg, `rm -rf temp/hls/{sessionId}/`, delete from map

---

## Temp File Layout

```
temp/hls/
  {sessionId}/
    seg_video_0.ts
    seg_video_1.ts
    ...
```

Files are cleaned up by the watchdog when the session goes idle.

---

## Key Files

- `src/routes/hls.ts` — full implementation
- `temp/hls/` — runtime temp dir (gitignored)