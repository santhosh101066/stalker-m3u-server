# Stalker M3U Server

## Project Description

This project appears to be a server designed to generate and manage M3U playlists, likely integrating with Stalker Middleware or similar IPTV portal systems. It provides various routes for generating playlists, handling live streams, media, and proxying requests.

## Features

- **M3U Playlist Generation:** Dynamically generates M3U playlists.
- **Live Stream Handling:** Routes for managing and serving live content.
- **Media Management:** Handles various media types.
- **Portal Proxy:** Functionality to proxy requests to a Stalker portal.
- **Configuration:** Customizable through `appConfig.json` and `src/config/server.ts`.
- **Web Interface:** A basic web interface served from the `public` directory.

## Technologies Used

- **TypeScript:** Primary language for server-side logic.
- **Node.js:** Runtime environment.
- **Express.js (inferred):** Likely used for routing and server management (based on `src/routes` and `src/server.ts`).
- **TSUP:** For bundling and compiling TypeScript.

## Setup and Installation

To set up the project locally, follow these steps:

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/stalker-m3u-server.git
    cd stalker-m3u-server
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Configure the server:**
    - Copy `config copy.json` to `appConfig.json` (if it doesn't exist) and update the necessary settings.
    - Review and modify `src/config/server.ts` for server-specific configurations.

4.  **Build the project:**
    ```bash
    npm run build # or tsup
    ```

5.  **Run the server:**
    ```bash
    npm start # or node dist/server.js
    ```
    Alternatively, you can use the provided `run.sh` script:
    ```bash
    ./run.sh
    ```

## Usage

Once the server is running, you can access its functionalities via the defined API routes and the web interface.

- **Web Interface:** Open your browser and navigate to `http://localhost:PORT` (replace `PORT` with the port configured in `appConfig.json` or `src/config/server.ts`).
- **API Endpoints:** Refer to the `src/routes` directory for available API endpoints like `/generate`, `/live`, `/media`, `/playlist`, `/portalProxy`, `/proxy`, and `/stalkerV2`.

## Configuration

- `appConfig.json`: Contains general application settings.
- `src/config/server.ts`: Contains server-specific configurations, such as port numbers, API keys, or other sensitive information.

## Project Structure

```
.gitignore
appConfig.json
commands
config copy.json
Dockerfile
package-lock.json
package.json
readme.md
run.sh
tsconfig.json
tsup.config.ts
.git/...
.mem/...
dist/...
node_modules/...
public/
│   index.html
│   stalker-vod-logo.svg
│   assets/
│       index-BBjfWDij.js
│       index-DT37Duqs.css
src/
    server.ts
    serverManager.ts
    .mem/...
    config/
    │   server.ts
    constants/
    │   common.ts
    │   timeouts.ts
    routes/
    │   config.ts
    │   generate.ts
    │   live.ts
    │   media.ts
    │   playlist.ts
    │   portalProxy.ts
    │   proxy.ts
    │   stalkerV2.ts
    types/
    │   types.ts
    utils/
        cmdPlayer.ts
        fetch.ts
        generateGroups.ts
        getM3uUrls.ts
        stalker.ts
        storage.ts
```
