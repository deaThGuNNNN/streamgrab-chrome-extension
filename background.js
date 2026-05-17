// background.js - StreamGrab Background Service Worker

// Active tab video storage: tabId -> array of video objects
const tabVideos = {};

// Clean up video storage when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabVideos[tabId];
});

// Clean up video storage when tabs are updated/refreshed
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    // Keep list until page fully reloads, but refresh on fresh navigate
    delete tabVideos[tabId];
    updateBadge(tabId, 0);
  }
});

// Monitor network responses to capture media file streams and payloads
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const tabId = details.tabId;
    if (tabId < 0) return;

    const url = details.url;
    // Exclude extensions internal pages
    if (url.startsWith('chrome-extension://') || url.startsWith('chrome://')) return;

    let contentType = '';
    let contentLength = 0;

    if (details.responseHeaders) {
      for (const header of details.responseHeaders) {
        const name = header.name.toLowerCase();
        if (name === 'content-type') {
          contentType = header.value.toLowerCase();
        } else if (name === 'content-length') {
          contentLength = parseInt(header.value, 10) || 0;
        }
      }
    }

    // Identify if the request represents a stream or static video format
    const isVideoExtension = /\.(mp4|webm|mkv|avi|mov|m4v|m3u8|mpd|ts)(\?|$)/i.test(url);
    const isVideoMime = contentType.startsWith('video/') ||
                        contentType === 'application/x-mpegurl' ||
                        contentType === 'application/vnd.apple.mpegurl' ||
                        contentType === 'application/dash+xml';

    if (isVideoExtension || isVideoMime) {
      addDetectedVideo(tabId, {
        url: url,
        contentType: contentType,
        size: contentLength,
        type: determineVideoType(url, contentType),
        title: parseFileName(url),
        source: 'Network Sniffer',
        detectedAt: Date.now()
      });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Listen for messages from the popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTabId = sender.tab ? sender.tab.id : null;

  switch (message.action) {
    case 'videoDetected':
      // Sent by content scripts (DOM search or fetch/XHR overrides)
      if (senderTabId) {
        addDetectedVideo(senderTabId, {
          url: message.video.url,
          contentType: message.video.contentType || '',
          size: 0, // Injected elements usually don't have sizes immediately available
          type: determineVideoType(message.video.url, message.video.contentType || ''),
          title: message.video.title || parseFileName(message.video.url),
          source: 'DOM Scan / API Interceptor',
          detectedAt: Date.now()
        });
      }
      sendResponse({ status: 'ok' });
      break;

    case 'getVideos':
      // Requested by popup
      const activeTabId = message.tabId;
      const videos = tabVideos[activeTabId] || [];
      sendResponse({ videos: videos });
      break;

    case 'clearVideos':
      const targetTabId = message.tabId;
      tabVideos[targetTabId] = [];
      updateBadge(targetTabId, 0);
      sendResponse({ status: 'cleared' });
      break;

    case 'download':
      // Triggers chrome download flow
      chrome.downloads.download({
        url: message.url,
        filename: message.filename || 'downloaded_video.mp4',
        saveAs: true
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId: downloadId });
        }
      });
      return true; // Keep response channel open for async callback
  }
});

// Helper: Categorize video extension types
function determineVideoType(url, mimeType) {
  if (url.includes('.m3u8') || mimeType === 'application/x-mpegurl' || mimeType === 'application/vnd.apple.mpegurl') {
    return 'HLS Stream (M3U8)';
  }
  if (url.includes('.mpd') || mimeType === 'application/dash+xml') {
    return 'DASH Stream';
  }
  if (url.includes('.webm') || mimeType.includes('webm')) {
    return 'WEBM';
  }
  if (url.includes('.ts')) {
    return 'TS Chunk';
  }
  return 'MP4';
}

// Helper: Parse human readable file names from URLs
function parseFileName(url) {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    const segments = path.split('/');
    let lastSegment = segments[segments.length - 1];

    if (!lastSegment || lastSegment.trim() === '') {
      lastSegment = 'captured_media';
    }

    // Remove file extension if present to make title cleaner
    lastSegment = lastSegment.replace(/\.(mp4|webm|mkv|avi|mov|m4v|m3u8|mpd|ts)$/i, '');
    
    // Decode URI component to clean up spaces/characters
    return decodeURIComponent(lastSegment).substring(0, 50);
  } catch (e) {
    return 'captured_media';
  }
}

// Helper: Safely insert a video to a tab's list, ensuring deduplication
function addDetectedVideo(tabId, video) {
  if (!tabVideos[tabId]) {
    tabVideos[tabId] = [];
  }

  // Deduplicate by URL
  const exists = tabVideos[tabId].some(v => v.url === video.url);
  if (!exists) {
    tabVideos[tabId].push(video);
    // Sort so recent additions appear first
    tabVideos[tabId].sort((a, b) => b.detectedAt - a.detectedAt);
    
    // Keep max 50 items per tab to conserve memory
    if (tabVideos[tabId].length > 50) {
      tabVideos[tabId].pop();
    }
    
    updateBadge(tabId, tabVideos[tabId].length);
  }
}

// Helper: Update extension badge for tab
function updateBadge(tabId, count) {
  if (count > 0) {
    chrome.action.setBadgeText({ tabId: tabId, text: count.toString() });
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#8b5cf6' }); // Premium violet
  } else {
    chrome.action.setBadgeText({ tabId: tabId, text: '' });
  }
}
