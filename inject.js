// inject.js - Page-level Fetch and XHR Interceptor for StreamGrab
(function() {
  // Prevent double injection
  if (window.__streamGrabInjected) return;
  window.__streamGrabInjected = true;

  // Set of captured URLs to prevent thrashing DOM events
  const capturedUrls = new Set();

  // Helper: Verify if a URL represents a stream or static media file
  function isMediaResource(url, contentType) {
    if (!url || typeof url !== 'string') return false;

    // Check by file extension (ignoring query strings)
    const isExtension = /\.(mp4|webm|mkv|avi|mov|m4v|m3u8|mpd|ts)(\?|$)/i.test(url);
    
    // Check by content-type if available
    let isMime = false;
    if (contentType && typeof contentType === 'string') {
      const mime = contentType.toLowerCase();
      isMime = mime.startsWith('video/') ||
               mime === 'application/x-mpegurl' ||
               mime === 'application/vnd.apple.mpegurl' ||
               mime === 'application/dash+xml';
    }

    return isExtension || isMime;
  }

  // Helper: Safely notify content.js via custom DOM Event
  function dispatchDetectedVideo(url, contentType = '') {
    if (capturedUrls.has(url)) return; // Already reported in this page session
    capturedUrls.add(url);

    // Limit set size to avoid memory leaks
    if (capturedUrls.size > 200) {
      const firstKey = capturedUrls.values().next().value;
      capturedUrls.delete(firstKey);
    }

    // Format absolute URL
    let absoluteUrl = url;
    try {
      absoluteUrl = new URL(url, window.location.href).href;
    } catch(e) {}

    const event = new CustomEvent('StreamGrab_VideoDetected', {
      detail: { url: absoluteUrl, contentType: contentType }
    });
    window.dispatchEvent(event);
  }

  // Intercept Fetch API requests
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    let url = '';
    if (args[0]) {
      if (typeof args[0] === 'string') {
        url = args[0];
      } else if (args[0] instanceof Request) {
        url = args[0].url;
      } else if (args[0] instanceof URL) {
        url = args[0].href;
      }
    }

    try {
      const response = await originalFetch.apply(this, args);
      const contentType = response.headers.get('content-type') || '';
      
      if (isMediaResource(url, contentType)) {
        dispatchDetectedVideo(url, contentType);
      }
      return response;
    } catch (err) {
      // If fetch fails or was intercepted, proceed transparently
      if (isMediaResource(url, '')) {
        dispatchDetectedVideo(url, '');
      }
      throw err;
    }
  };

  // Intercept XMLHttpRequest (AJAX) requests
  const originalXHROpen = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._requestUrl = url;
    
    // Add event listener to capture headers once the request finishes
    this.addEventListener('readystatechange', function() {
      if (this.readyState === 2) { // HEADERS_RECEIVED
        try {
          const contentType = this.getResponseHeader('content-type') || '';
          if (isMediaResource(this._requestUrl, contentType)) {
            dispatchDetectedVideo(this._requestUrl, contentType);
          }
        } catch(e) {
          // Ignore header retrieval errors (e.g. security boundaries)
        }
      }
    });

    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  // Handle media dynamic source changes in video tags directly in page context
  // This helps intercept elements dynamically attached before content.js scanned the DOM
  function overrideHTML5VideoSrc() {
    const videoProto = HTMLVideoElement.prototype;
    const originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    
    if (originalSrcDescriptor && originalSrcDescriptor.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        set: function(val) {
          if (val && typeof val === 'string' && !val.startsWith('blob:')) {
            dispatchDetectedVideo(val);
          }
          return originalSrcDescriptor.set.call(this, val);
        },
        get: function() {
          return originalSrcDescriptor.get.call(this);
        }
      });
    }
  }

  try {
    overrideHTML5VideoSrc();
  } catch(e) {
    // Fail silently if HTMLMediaElement override fails in strict mode environments
  }
})();
