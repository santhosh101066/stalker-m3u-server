<p align="center">
  <img src="public/stalker-logo.svg" alt="Stalker Server Logo" width="200" />
</p>

<h1 align="center">Stalker Middleware Server</h1>

<p align="center">
  A robust Node.js backend for proxying Stalker/Xtream Codes credentials, generating M3U playlists, 
  and handling real-time signaling for the Stalker VOD ecosystem.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20-green?style=for-the-badge&logo=nodedotjs" />
  <img src="https://img.shields.io/badge/Docker-Enabled-blue?style=for-the-badge&logo=docker" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue?style=for-the-badge&logo=typescript" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" />
</p>

---

## ✨ Features

- 🔄 **Smart Proxy**: Securely proxies video streams, hiding upstream credentials from the client.
- 📋 **Playlist Generation**: Dynamically converts Stalker portal content into standard M3U playlists.
- 📺 **EPG Support**: Parses and serves Electronic Program Guides (EPG) for live channels.
- 🔌 **Real-time Signaling**: Socket.io server for handling device casting and remote control commands.
- 🐳 **Docker Ready**: Fully containerized for easy deployment on Raspberry Pi or any Linux server.

## 🚀 Quick Start

### Prerequisites
- Node.js (v18+)
- Docker (for deployment)

### Installation

1.  **Clone the repository**
    ```bash
    git clone https://github.com/yourusername/stalker-m3u-server.git
    cd stalker-m3u-server
    ```

2.  **Install dependencies**
    ```bash
    npm install
    ```

3.  **Configure Environment**
    ```bash
    cp .env.example .env
    ```
    Edit `.env` to configure your deployment target:
    ```ini
    REMOTE_HOST=your_raspberry_pi_ip
    REMOTE_USER=pi
    REMOTE_DIR=~/stalker-server
    ```

4.  **Run Development Server**
    ```bash
    npm run dev
    ```

## 🛠️ Deployment

We use a consolidated `deploy.sh` script to manage the Docker lifecycle on your remote host.

### Full Deployment
Builds the Docker image, saves it, transfers it to the remote host, and restarts the container.
```bash
./deploy.sh
```

### Management Commands
- **Restart Container**:
  ```bash
  ./deploy.sh restart
  ```
- **View Logs**:
  ```bash
  ./deploy.sh logs
  ```

## 📡 API Endpoints

- `GET /api/playlist/m3u`: Generate M3U playlist for authenticated user.
- `GET /api/epg`: Retrieve EPG data.
- `GET /live/*`: Proxy endpoint for live streams.
- `GET /movie/*`: Proxy endpoint for VOD content.

## ⚠️ Disclaimer

This server acts as a **middleware proxy only**. It does not host, provide, or distribute any media content or playlists. It is designed to interface with existing, user-provided Stalker or Xtream Codes portals. Users are solely responsible for ensuring they have the legal right to access the content they configure.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
