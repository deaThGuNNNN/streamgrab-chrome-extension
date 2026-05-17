# StreamGrab — High-Performance Video Downloader (Manifest V3)

StreamGrab is an advanced, custom-engineered Google Chrome extension built in compliance with Manifest V3 (MV3). It enables users to capture and download direct video files (`.mp4`, `.webm`) as well as compile HTTP Live Streaming (`.m3u8` HLS) streams directly into unified `.ts` transport stream files entirely on the client side in the browser. 

Equipped with a concurrent fetching engine, multi-worker segment scheduler, and cryptographic AES-128 decryption, StreamGrab bypasses complex CDN referrer/origin barriers to stitch fragmented streams seamlessly.

---

## 🛠️ Architecture & Technical Features

*   **Asynchronous Parallel Fetching Pool**: StreamGrab utilizes a concurrent worker pool to fetch up to 4 stream chunks simultaneously, maximizing browser bandwidth and drastically reducing compile times compared to standard sequential downloaders.
*   **On-the-Fly AES-128 Decryption**: Intercepts encrypted HLS streams, resolves their keys securely, and decrypts the segment payloads in the browser sandbox using the native Web Crypto API (`AES-128-CBC`).
*   **In-Memory Byte Assembly**: Progressively stitches decrypted video chunks together into a unified `.ts` (MPEG-TS) transport stream, downloading it via the Chrome Downloads API without relying on external servers.
*   **Deep XHR and Fetch Interceptors**: Injects a custom interceptor script directly into the page context to monitor real-time network payloads, capturing media playlist files before they are loaded by players.
*   **Glassmorphic Premium UI**: Features a beautiful modern layout using vanilla CSS frosted-glass indicators, custom progress bars, interactive modal players, and a dynamic download manager.

---

## 🚀 How to Install (Developer Mode)

To run StreamGrab locally in Google Chrome:

1.  Clone this repository to your local machine:
    ```bash
    git clone https://github.com/deaThGuNNNN/streamgrab-chrome-extension.git
    ```
2.  Open Google Chrome and navigate to:
    `chrome://extensions/`
3.  In the top-right corner of the Extensions dashboard, toggle **Developer Mode** to **ON**.
4.  In the top-left corner, click the **Load unpacked** button.
5.  Select the extension root directory (the folder containing `manifest.json`).
6.  Pin **StreamGrab** to your Chrome toolbar by clicking the extensions puzzle piece icon 🧩.
7.  Refresh any video-playing page to allow interceptors to attach, and start downloading!


---

## 📂 File Architecture

*   `manifest.json` — Declares extension parameters, required permissions, and service worker scripts under Manifest V3 rules.
*   `background.js` — The extension's background service worker, listening to network request headers to catalog media streams.
*   `content.js` — Acts as a bridge between the DOM context, page frames, and the main extension process.
*   `inject.js` — Core XHR and Fetch interceptor injected directly into the window context to capture playlist manifests.
*   `popup.html` / `popup.css` / `popup.js` — The premium, interactive interface containing the active downloads monitor, preview player, and user controls.
*   `generate_icons.py` — A helpful Python automation utility to render vector graphics into multi-size raster assets.
