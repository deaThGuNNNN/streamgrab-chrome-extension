// content.js - StreamGrab DOM Scanner & Injector Bridge

// Inject page-level network sniffer (inject.js) into the host page context
try {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
} catch (e) {
  console.error('[StreamGrab] Injection failed:', e);
}

// Receive video detection notifications from page context interceptor (inject.js)
window.addEventListener('StreamGrab_VideoDetected', (event) => {
  if (event.detail && event.detail.url) {
    chrome.runtime.sendMessage({
      action: 'videoDetected',
      video: {
        url: event.detail.url,
        contentType: event.detail.contentType || '',
        title: document.title || 'Page Video',
        pageUrl: window.location.href
      }
    });
  }
});

// Scan DOM for video structures
function scanDOMForVideos() {
  // 1. Scan standard HTML5 video elements
  const videoElements = document.querySelectorAll('video');
  videoElements.forEach((video) => {
    // Check direct src attribute
    if (video.src && !video.src.startsWith('blob:')) {
      reportVideo(video.src);
    }
    
    // Check child source elements
    const sources = video.querySelectorAll('source');
    sources.forEach((src) => {
      if (src.src && !src.src.startsWith('blob:')) {
        reportVideo(src.src, src.type);
      }
    });
  });

  // 2. Scan anchor tags pointing to video files
  const anchorElements = document.querySelectorAll('a[href]');
  anchorElements.forEach((anchor) => {
    const href = anchor.href;
    if (/\.(mp4|webm|mkv|avi|mov|m4v|m3u8)(\?|$)/i.test(href)) {
      reportVideo(href, '', anchor.innerText || 'Download Link');
    }
  });

  // 3. Scan iframe elements (embedded players) for sources
  const iframeElements = document.querySelectorAll('iframe');
  iframeElements.forEach((iframe) => {
    try {
      const src = iframe.src;
      // If it contains a video extension or is an embed from a known video provider
      if (src && (/\.(mp4|webm|m3u8)(\?|$)/i.test(src) || src.includes('embed') || src.includes('player'))) {
        // Send embed link so user can open/inspect it
        reportVideo(src, '', `Embedded Player (${new URL(src).hostname})`);
      }
    } catch(e) {
      // Cross-origin iframe accesses are blocked, ignore
    }
  });
}

// Helper: send detected video back to background.js
function reportVideo(url, mimeType = '', customTitle = '') {
  // Ensure the URL is absolute
  let absoluteUrl = url;
  try {
    absoluteUrl = new URL(url, window.location.href).href;
  } catch (e) {
    return; // Invalid URL
  }

  // Avoid reporting data URLs or script URLs
  if (absoluteUrl.startsWith('data:') || absoluteUrl.startsWith('javascript:')) return;

  chrome.runtime.sendMessage({
    action: 'videoDetected',
    video: {
      url: absoluteUrl,
      contentType: mimeType,
      title: customTitle || document.title || 'Page Video',
      pageUrl: window.location.href
    }
  });
}

// Run scans on load and listen to DOM mutation events
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDOMScanner);
} else {
  initDOMScanner();
}

function initDOMScanner() {
  scanDOMForVideos();
  
  // Set up mutation observer to catch dynamically added videos (e.g. infinite scroll or sliders)
  const observer = new MutationObserver((mutations) => {
    scanDOMForVideos();
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Periodically re-scan as a backup
  setInterval(scanDOMForVideos, 5000);
}

// -------------------------------------------------------------
// ⚡ Delegated HLS Downloader and Decrypter Engine (Tab Origin Context)
// -------------------------------------------------------------

// Listen for download requests dispatched from popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'downloadHlsStream') {
    const { url, title } = message;
    executeHLSDownload(url, title);
    sendResponse({ success: true, status: 'started' });
  }
});

// Helper: resolve relative URLs relative to baseUrl
function resolveUrl(baseUrl, relativeUrl) {
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch (e) {
    return relativeUrl;
  }
}

// Direct client-side HLS (.m3u8) downloader and compiler with AES-128 decryption support
async function executeHLSDownload(m3u8Url, videoTitle) {
  sendProgressUpdate(m3u8Url, 'Fetching index...', 0);

  try {
    // 1. Fetch playlist index
    let response = await fetch(m3u8Url);
    if (!response.ok) throw new Error('Failed to fetch stream index.');
    let text = await response.text();

    let mediaPlaylistUrl = m3u8Url;

    // 2. Check if master playlist containing variant qualities
    if (text.includes('#EXT-X-STREAM-INF')) {
      sendProgressUpdate(m3u8Url, 'Selecting quality...', 5);
      const lines = text.split('\n');
      let highestBandwidth = 0;
      let highestVariantUrl = '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF')) {
          const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/i);
          const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1], 10) : 0;
          
          let nextLine = '';
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].trim() && !lines[j].trim().startsWith('#')) {
              nextLine = lines[j].trim();
              break;
            }
          }

          if (nextLine && bandwidth > highestBandwidth) {
            highestBandwidth = bandwidth;
            highestVariantUrl = nextLine;
          }
        }
      }

      if (highestVariantUrl) {
        mediaPlaylistUrl = resolveUrl(m3u8Url, highestVariantUrl);
        response = await fetch(mediaPlaylistUrl);
        if (!response.ok) throw new Error('Failed to fetch media stream playlist.');
        text = await response.text();
      }
    }

    // 3. Extract segments and encryption keys
    sendProgressUpdate(m3u8Url, 'Parsing playlist...', 10);
    const lines = text.split('\n');
    const chunkUrls = [];
    
    let encryptionInfo = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-KEY:')) {
        // Parse AES-128 encryption keys
        const methodMatch = line.match(/METHOD=([^,\s]+)/i);
        const uriMatch = line.match(/URI="([^"]+)"/i);
        const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/i);

        if (methodMatch && methodMatch[1].toUpperCase() === 'AES-128' && uriMatch) {
          encryptionInfo = {
            method: 'AES-128',
            keyUrl: resolveUrl(mediaPlaylistUrl, uriMatch[1]),
            ivHex: ivMatch ? ivMatch[1] : null
          };
        }
      } else if (line && !line.startsWith('#')) {
        chunkUrls.push(resolveUrl(mediaPlaylistUrl, line));
      }
    }

    if (chunkUrls.length === 0) {
      throw new Error('No video chunks detected in playlist.');
    }

    // 4. Fetch decryption key if HLS is encrypted
    let cryptoKey = null;
    let baseIv = null;

    if (encryptionInfo) {
      sendProgressUpdate(m3u8Url, 'Decrypting stream key...', 12);
      try {
        const keyRes = await fetch(encryptionInfo.keyUrl);
        if (!keyRes.ok) throw new Error('Failed to download decryption key.');
        const keyBuffer = await keyRes.arrayBuffer();

        // Import raw key bytes into SubtleCrypto
        cryptoKey = await crypto.subtle.importKey(
          "raw",
          keyBuffer,
          { name: "AES-CBC" },
          false,
          ["decrypt"]
        );

        if (encryptionInfo.ivHex) {
          baseIv = hexToBytes(encryptionInfo.ivHex);
        }
      } catch (keyErr) {
        console.error('[StreamGrab] Key loading error:', keyErr);
        throw new Error('Protected AES stream key decryption failed.');
      }
    }

    // 5. Download and decrypt chunks concurrently
    sendProgressUpdate(m3u8Url, `Loading chunks: 0/${chunkUrls.length}`, 15);
    
    const chunkBuffers = new Array(chunkUrls.length);
    let downloadedCount = 0;
    const concurrency = 4; // Fetch 4 chunks at a time

    async function downloadWorker(urlsWithIndices) {
      for (const { url, index } of urlsWithIndices) {
        let success = false;
        let retries = 3;
        let segmentBuffer = null;

        while (!success && retries > 0) {
          try {
            const chunkRes = await fetch(url);
            if (!chunkRes.ok) throw new Error();
            segmentBuffer = await chunkRes.arrayBuffer();
            success = true;
          } catch (e) {
            retries--;
            if (retries === 0) {
              segmentBuffer = new ArrayBuffer(0); // empty fallback to prevent breaking sequence
            } else {
              await new Promise(r => setTimeout(r, 300));
            }
          }
        }

        // Decrypt segment if it is encrypted
        if (success && cryptoKey && segmentBuffer && segmentBuffer.byteLength > 0) {
          try {
            // Determine IV for this segment
            let iv = baseIv;
            if (!iv) {
              // Standard HLS: if no IV is specified, use segment index sequence as big-endian 16-byte block
              iv = new Uint8Array(16);
              const seq = index;
              iv[12] = (seq >> 24) & 0xff;
              iv[13] = (seq >> 16) & 0xff;
              iv[14] = (seq >> 8) & 0xff;
              iv[15] = seq & 0xff;
            }

            const decrypted = await crypto.subtle.decrypt(
              { name: "AES-CBC", iv: iv },
              cryptoKey,
              segmentBuffer
            );
            segmentBuffer = decrypted;
          } catch (decryptErr) {
            console.warn(`[StreamGrab] Decryption failed for chunk ${index}:`, decryptErr);
          }
        }

        chunkBuffers[index] = segmentBuffer;
        downloadedCount++;
        const percent = Math.min(92, Math.round(15 + (downloadedCount / chunkUrls.length) * 75));
        sendProgressUpdate(m3u8Url, `Loading: ${downloadedCount}/${chunkUrls.length}`, percent);
      }
    }

    // Allocate worker queues
    const queue = chunkUrls.map((url, index) => ({ url, index }));
    const workers = [];
    
    for (let w = 0; w < concurrency; w++) {
      const workerQueue = [];
      for (let i = w; i < queue.length; i += concurrency) {
        workerQueue.push(queue[i]);
      }
      workers.push(downloadWorker(workerQueue));
    }

    await Promise.all(workers);

    // 6. Merge all buffers
    sendProgressUpdate(m3u8Url, 'Compiling video...', 95);
    
    let totalLength = 0;
    for (const buf of chunkBuffers) {
      if (buf) totalLength += buf.byteLength;
    }

    if (totalLength === 0) {
      throw new Error('All segment chunks returned empty content. Bypassed segments.');
    }

    const mergedArray = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of chunkBuffers) {
      if (buf) {
        mergedArray.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
      }
    }

    // 7. Save compiled file directly
    sendProgressUpdate(m3u8Url, 'Saving Video...', 98);
    
    const videoBlob = new Blob([mergedArray], { type: 'video/mp2t' });
    const localBlobUrl = URL.createObjectURL(videoBlob);
    
    let cleanTitle = videoTitle.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 50);
    if (!cleanTitle.toLowerCase().endsWith('.ts')) {
      cleanTitle += '.ts';
    }

    // Delegate actual chrome download trigger back to background.js
    chrome.runtime.sendMessage({
      action: 'download',
      url: localBlobUrl,
      filename: cleanTitle
    }, (res) => {
      setTimeout(() => URL.revokeObjectURL(localBlobUrl), 20000);
      
      if (res && res.success) {
        chrome.runtime.sendMessage({ action: 'downloadHlsSuccess', url: m3u8Url });
      } else {
        chrome.runtime.sendMessage({ action: 'downloadHlsFailed', url: m3u8Url });
      }
    });

  } catch (err) {
    console.error('[StreamGrab] Direct HLS download failed inside tab:', err);
    chrome.runtime.sendMessage({ action: 'downloadHlsFailed', url: m3u8Url });
  }
}

// Helper: Send progress to popup
function sendProgressUpdate(url, text, percent) {
  chrome.runtime.sendMessage({
    action: 'downloadHlsProgress',
    url: url,
    text: text,
    percent: percent
  });
}

// Helper: Convert hex IV to Uint8Array
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let c = 0; c < hex.length; c += 2) {
    bytes[c / 2] = parseInt(hex.substr(c, 2), 16);
  }
  return bytes;
}
