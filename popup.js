// popup.js - Interactive Controller for StreamGrab Downloader

let activeTabId = null;
let activeTabDomain = '';
let detectedVideosList = [];
let downloadPoller = null;

// Initialize popup on open
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // 1. Fetch active tab metadata
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      activeTabId = tab.id;
      try {
        const urlObj = new URL(tab.url);
        activeTabDomain = urlObj.hostname;
        document.getElementById('currentDomain').textContent = activeTabDomain;
      } catch (err) {
        activeTabDomain = 'Unknown Page';
        document.getElementById('currentDomain').textContent = 'Webpage';
      }
    }

    // 2. Load detected videos from background thread
    refreshVideoLogs();

    // 3. Set up event listeners
    initEventListeners();

    // 4. Start active downloads monitor
    startDownloadsMonitor();

    // 5. Listen for HLS compile events sent by content.js
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === 'downloadHlsProgress') {
        const btn = document.querySelector(`.hls-download-btn[data-url="${message.url}"]`);
        if (btn) {
          btn.disabled = true;
          btn.style.opacity = '0.85';
          updateButtonProgress(btn, message.text, message.percent);
        }
      } else if (message.action === 'downloadHlsSuccess') {
        const btn = document.querySelector(`.hls-download-btn[data-url="${message.url}"]`);
        if (btn) {
          btn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3" width="12" height="12" style="margin-right: 4px;">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span style="color:#10b981;">Saved TS!</span>
          `;
          btn.style.borderColor = '#10b981';
          btn.disabled = false;
          btn.style.opacity = '1';
          setTimeout(() => {
            btn.innerHTML = `
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
              Download TS Video
            `;
            btn.style.borderColor = '';
            refreshVideoLogs();
          }, 3000);
        }
      } else if (message.action === 'downloadHlsFailed') {
        const btn = document.querySelector(`.hls-download-btn[data-url="${message.url}"]`);
        if (btn) {
          btn.innerHTML = `<span style="color: #ef4444;">Failed - Use CLI</span>`;
          btn.disabled = false;
          btn.style.opacity = '1';
          setTimeout(() => {
            btn.innerHTML = `
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
              Download TS Video
            `;
            btn.style.borderColor = '';
          }, 4000);
        }
      }
    });
  } catch (err) {
    console.error('[StreamGrab] Initialization error:', err);
    setupMockDataForDevelopment(); // Fallback for outside-extension previewing
  }
});

// Load the tab's intercepted videos from background service worker
function refreshVideoLogs() {
  if (!activeTabId) return;

  chrome.runtime.sendMessage({ action: 'getVideos', tabId: activeTabId }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('Background communication failed:', chrome.runtime.lastError);
      return;
    }

    if (response && response.videos) {
      detectedVideosList = response.videos;
      renderVideoList();
    }
  });
}

// Render video card decks
function renderVideoList() {
  const container = document.getElementById('videoListContainer');
  const emptyState = document.getElementById('emptyState');
  const detectedCount = document.getElementById('detectedCount');
  
  // Retrieve filters
  const searchQuery = document.getElementById('videoSearch').value.toLowerCase().trim();
  const hideChunks = document.getElementById('hideChunksToggle').checked;

  // Filter video list
  let filtered = detectedVideosList.filter(video => {
    // Search filter
    const matchesSearch = video.title.toLowerCase().includes(searchQuery) || video.url.toLowerCase().includes(searchQuery);
    
    // TS Chunks filter
    const isTSChunk = video.url.includes('.ts') || video.type === 'TS Chunk';
    const passesTSFilter = !(hideChunks && isTSChunk);

    return matchesSearch && passesTSFilter;
  });

  // Sort by size descending (largest file first) so the user gets the best video at the very top without scrolling
  filtered.sort((a, b) => {
    const sizeA = Number(a.size) || 0;
    const sizeB = Number(b.size) || 0;
    return sizeB - sizeA;
  });

  // Update footer statistics
  detectedCount.textContent = filtered.length;

  // Clean list container (keep empty state if needed)
  const cards = container.querySelectorAll('.video-card');
  cards.forEach(card => card.remove());

  if (filtered.length === 0) {
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';

  // Build and insert cards
  filtered.forEach(video => {
    const card = document.createElement('div');
    card.className = 'video-card';
    
    const formattedSize = video.size > 0 ? formatByteSize(video.size) : 'Unknown Size';
    const isStream = video.type.includes('Stream') || video.type.includes('M3U8') || video.type.includes('DASH');
    
    // Type-specific badge CSS classes
    let badgeClass = 'badge-mp4';
    if (video.type.includes('HLS')) badgeClass = 'badge-hls';
    else if (video.type.includes('WEBM')) badgeClass = 'badge-webm';
    else if (video.type.includes('DASH')) badgeClass = 'badge-dash';
    else if (video.type.includes('TS')) badgeClass = 'badge-ts';

    // Build inner card HTML
    let cardHTML = `
      <div class="card-header-row">
        <div class="card-title-block">
          <div class="card-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</div>
          <div class="card-meta-text">Source: ${escapeHtml(video.source)}</div>
        </div>
        <div class="type-badge ${badgeClass}">${video.type}</div>
      </div>
      <div class="card-header-row" style="align-items: center; margin-top: 4px;">
        <span class="card-size">${formattedSize}</span>
      </div>
    `;

    // Add FFmpeg command prompt for streams
    if (isStream) {
      const escapedUrl = video.url;
      const cleanTitle = video.title.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
      const ffmpegCommand = `ffmpeg -i "${escapedUrl}" -c copy -bsf:a aac_adtstoasc "${cleanTitle}.mp4"`;

      cardHTML += `
        <div class="ffmpeg-container">
          <div class="ffmpeg-title">FFmpeg Download Command</div>
          <div class="ffmpeg-command-box">
            <code title="${escapeHtml(ffmpegCommand)}">${escapeHtml(ffmpegCommand)}</code>
            <button class="copy-icon-btn copy-cmd-btn" data-clipboard="${escapeHtml(ffmpegCommand)}" title="Copy CLI Command">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6M12 2v4"/></svg>
            </button>
          </div>
        </div>
      `;
    }

    // Actions panel
    cardHTML += `
      <div class="card-actions" style="flex-direction: column; gap: 6px;">
    `;

    const isHlsStream = video.type.includes('HLS') || video.url.includes('.m3u8');

    if (isHlsStream) {
      // HLS streams get direct browser compiler button!
      cardHTML += `
        <div style="display: flex; gap: 8px; width: 100%;">
          <button class="action-btn-primary hls-download-btn" data-url="${escapeHtml(video.url)}" data-filename="${escapeHtml(video.title)}" style="flex: 2;" title="Downloads stream as a .ts file. Plays in VLC and uploads perfectly to standard video platforms.">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
            Download TS Video
          </button>
      `;
    } else if (isStream) {
      // General stream fallback (e.g. DASH)
      cardHTML += `
        <div style="display: flex; gap: 8px; width: 100%;">
          <button class="action-btn-primary copy-url-btn" data-url="${escapeHtml(video.url)}" style="flex: 2;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>
            Copy Stream Link
          </button>
      `;
    } else {
      // Static MP4s get direct download trigger
      cardHTML += `
        <div style="display: flex; gap: 8px; width: 100%;">
          <button class="action-btn-primary download-btn" data-url="${escapeHtml(video.url)}" data-filename="${escapeHtml(video.title)}" style="flex: 2;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
            Download Direct
          </button>
      `;
    }

    // Share "Preview" (except chunk files)
    if (video.type !== 'TS Chunk') {
      cardHTML += `
        <button class="action-btn-secondary preview-btn" data-url="${escapeHtml(video.url)}" data-title="${escapeHtml(video.title)}" data-type="${video.type}" style="flex: 1;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
          Preview
        </button>
      `;
    }

    // All links get Copy Link action
    cardHTML += `
        <button class="action-btn-secondary copy-url-btn" data-url="${escapeHtml(video.url)}" title="Copy Direct URL" style="flex: 1;">
          Copy Link
        </button>
      </div>
    `;

    // Add VLC & platform compliance note for HLS streams
    if (isHlsStream) {
      cardHTML += `
        <div style="font-size: 10px; color: var(--text-muted); margin-top: 4px; display: flex; align-items: flex-start; gap: 6px; padding: 6px 10px; background: rgba(168, 85, 247, 0.04); border-radius: 8px; border: 1px solid rgba(168, 85, 247, 0.1); line-height: 1.4;">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--color-purple)" stroke-width="2.5" width="12" height="12" style="flex-shrink: 0; margin-top: 1px;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          <span>Stitched in-browser as a <strong>.ts stream</strong>. Compatible with most creator upload platforms! Plays locally in <strong>VLC Media Player</strong> (QuickTime limits TS playback).</span>
        </div>
      `;
    }

    cardHTML += `
      </div>
    `;

    card.innerHTML = cardHTML;
    container.appendChild(card);
  });

  // Attach card-level event listeners
  attachCardEvents();
}

// Bind button clicks in dynamic card decks
function attachCardEvents() {
  // 1. Direct download triggers
  document.querySelectorAll('.download-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const url = btn.getAttribute('data-url');
      let title = btn.getAttribute('data-filename') || 'captured_video';
      
      // Enforce proper extension
      if (!title.toLowerCase().endsWith('.mp4') && !title.toLowerCase().endsWith('.webm')) {
        title += '.mp4';
      }

      chrome.runtime.sendMessage({
        action: 'download',
        url: url,
        filename: title
      }, (res) => {
        if (res && res.success) {
          // Switch to downloads tab to view progress
          switchTab('downloads-tab');
        } else {
          alert('Download failed: ' + (res ? res.error : 'Unknown boundary'));
        }
      });
    });
  });

  // 2. Clipboard link copy triggers
  document.querySelectorAll('.copy-url-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const url = btn.getAttribute('data-url');
      copyTextToClipboard(url, btn, 'Copied URL!');
    });
  });

  // 3. Clipboard CLI commands triggers
  document.querySelectorAll('.copy-cmd-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const cmd = btn.getAttribute('data-clipboard');
      copyTextToClipboard(cmd, btn, 'Copied CMD!');
    });
  });

  // 4. Modal player preview triggers
  document.querySelectorAll('.preview-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const url = btn.getAttribute('data-url');
      const title = btn.getAttribute('data-title');
      const type = btn.getAttribute('data-type');
      openPreviewModal(url, title, type);
    });
  });

  // 5. Direct HLS client-side downloader (Delegated to tab content script)
  document.querySelectorAll('.hls-download-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const url = btn.getAttribute('data-url');
      const filename = btn.getAttribute('data-filename') || 'captured_stream';
      
      btn.disabled = true;
      btn.style.opacity = '0.8';
      updateButtonProgress(btn, 'Connecting tab...', 0);
      
      chrome.tabs.sendMessage(activeTabId, {
        action: 'downloadHlsStream',
        url: url,
        title: filename
      }, (res) => {
        if (chrome.runtime.lastError) {
          console.warn('Tab HLS delegation failed:', chrome.runtime.lastError);
          btn.innerHTML = `<span style="color: #ef4444;">Reload Page!</span>`;
          btn.disabled = false;
          btn.style.opacity = '1';
          setTimeout(() => {
            btn.innerHTML = `
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
              Download TS Video
            `;
          }, 4000);
        }
      });
    });
  });
}

// Set up structural navigation, filter binds, and inputs
function initEventListeners() {
  // Navigation Tabs toggle
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchTab(tabId);
    });
  });

  // Realtime Search filtering
  document.getElementById('videoSearch').addEventListener('input', () => {
    renderVideoList();
  });

  // TS segments hide/reveal toggle
  document.getElementById('hideChunksToggle').addEventListener('change', () => {
    renderVideoList();
  });

  // Clear tab video logs list
  document.getElementById('clearListBtn').addEventListener('click', () => {
    if (!activeTabId) return;
    chrome.runtime.sendMessage({ action: 'clearVideos', tabId: activeTabId }, () => {
      detectedVideosList = [];
      renderVideoList();
    });
  });

  // Preview player modal closer
  document.getElementById('closeModalBtn').addEventListener('click', closePreviewModal);
  document.getElementById('previewModal').addEventListener('click', (e) => {
    if (e.target.id === 'previewModal') closePreviewModal();
  });
}

// Perform structural tabs sliding
function switchTab(panelId) {
  // Toggle nav buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    if (btn.getAttribute('data-tab') === panelId) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Toggle body panels
  document.querySelectorAll('.tab-panel').forEach(panel => {
    if (panel.id === panelId) {
      panel.classList.add('active');
    } else {
      panel.classList.remove('active');
    }
  });
}

// Start polling for active downloads
function startDownloadsMonitor() {
  if (downloadPoller) clearInterval(downloadPoller);
  
  // Poll Chrome Downloads database every second to get progress updates
  downloadPoller = setInterval(updateActiveDownloadsView, 1000);
  updateActiveDownloadsView(); // Trigger once immediately
}

// Query chrome active downloads progress and render
function updateActiveDownloadsView() {
  if (typeof chrome.downloads === 'undefined') return;

  // Search active downloading items
  chrome.downloads.search({ state: 'in_progress' }, (inProgressItems) => {
    const badge = document.getElementById('activeDownloadsCount');
    const container = document.getElementById('downloadsContainer');

    if (inProgressItems && inProgressItems.length > 0) {
      // Update sidebar badge
      badge.textContent = inProgressItems.length;
      badge.style.display = 'inline-block';

      // Keep static header but clear content for re-render
      container.innerHTML = '<h4>Active Downloads</h4>';

      inProgressItems.forEach(item => {
        const card = document.createElement('div');
        card.className = 'download-task-card';

        // Calculate progress percentage
        let percent = 0;
        if (item.totalBytes > 0) {
          percent = Math.round((item.bytesReceived / item.totalBytes) * 100);
        }

        const sizeStr = formatByteSize(item.bytesReceived) + ' / ' + (item.totalBytes > 0 ? formatByteSize(item.totalBytes) : 'Unknown');
        const filename = item.filename ? item.filename.split('/').pop() : 'video_download.mp4';

        card.innerHTML = `
          <div class="task-info">
            <span class="task-title" title="${escapeHtml(filename)}">${escapeHtml(filename)}</span>
            <span class="task-status">${percent}%</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width: ${percent}%;"></div>
          </div>
          <div class="task-info" style="margin-top: 4px;">
            <span style="font-size: 10px; color: var(--text-muted);">${sizeStr}</span>
            <span style="font-size: 10px; color: var(--text-muted);">${formatSpeed(item.bytesReceived)}</span>
          </div>
        `;
        container.appendChild(card);
      });
    } else {
      // No active downloading items, search completed ones for visual log or show empty state
      badge.style.display = 'none';

      chrome.downloads.search({ limit: 4, orderBy: ['-startTime'] }, (recentItems) => {
        if (recentItems && recentItems.length > 0) {
          container.innerHTML = '<h4 style="margin-bottom: 8px;">Recent Downloads</h4>';
          recentItems.forEach(item => {
            const card = document.createElement('div');
            card.className = 'download-task-card';
            
            const filename = item.filename ? item.filename.split('/').pop() : 'downloaded_file.mp4';
            let statusClass = 'complete';
            let statusText = 'Completed';
            
            if (item.state === 'interrupted') {
              statusClass = 'error';
              statusText = 'Interrupted';
            }

            card.innerHTML = `
              <div class="task-info">
                <span class="task-title" title="${escapeHtml(filename)}">${escapeHtml(filename)}</span>
                <span class="task-status ${statusClass}">${statusText}</span>
              </div>
              <div class="task-info" style="margin-top: 4px; font-size: 10px; color: var(--text-muted);">
                <span>Size: ${formatByteSize(item.fileSize)}</span>
                <a href="#" class="open-file-link" data-id="${item.id}" style="color: var(--color-purple); text-decoration: none;">Show in folder</a>
              </div>
            `;
            container.appendChild(card);
          });

          // Bind open file actions
          container.querySelectorAll('.open-file-link').forEach(link => {
            link.addEventListener('click', (e) => {
              e.preventDefault();
              const id = parseInt(link.getAttribute('data-id'), 10);
              chrome.downloads.show(id);
            });
          });
        } else {
          // Empty State fallback
          container.innerHTML = `
            <div class="empty-state">
              <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
              </svg>
              <h3>No active downloads</h3>
              <p>Initiate a download from the "Detected" panel to track its progress here.</p>
            </div>
          `;
        }
      });
    }
  });
}

// Launch custom video player modal preview
function openPreviewModal(url, title, type) {
  const modal = document.getElementById('previewModal');
  const videoPlayer = document.getElementById('previewPlayer');
  const errorMsg = document.getElementById('previewFallbackMsg');
  const modalTitle = document.getElementById('previewTitle');
  const downloadBtn = document.getElementById('modalDownloadBtn');

  modalTitle.textContent = `Preview: ${title}`;
  modal.classList.add('active');

  // HLS stream links can't play natively inside standard HTML5 video players in Chrome
  const isStream = type.includes('Stream') || type.includes('M3U8') || type.includes('DASH');
  
  if (isStream) {
    videoPlayer.style.display = 'none';
    errorMsg.style.display = 'block';
    
    // Make modal download button copy stream link
    downloadBtn.innerHTML = 'Copy Stream Link';
    downloadBtn.onclick = () => {
      copyTextToClipboard(url, downloadBtn, 'Link Copied!');
    };
  } else {
    videoPlayer.style.display = 'block';
    errorMsg.style.display = 'none';
    videoPlayer.src = url;
    videoPlayer.load();
    videoPlayer.play().catch(() => {
      console.log('Autoplay blocked by browser policy');
    });

    // Make modal download button execute download
    downloadBtn.innerHTML = 'Download Video';
    downloadBtn.onclick = () => {
      chrome.downloads.download({
        url: url,
        filename: title.replace(/[^a-zA-Z0-9._-]/g, '_') + '.mp4',
        saveAs: true
      });
      closePreviewModal();
      switchTab('downloads-tab');
    };
  }
}

// Terminate video player and clear elements
function closePreviewModal() {
  const modal = document.getElementById('previewModal');
  const videoPlayer = document.getElementById('previewPlayer');
  
  videoPlayer.pause();
  videoPlayer.src = '';
  modal.classList.remove('active');
}

// Utility: Clean strings for insertion
function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, function(m) { return map[m]; });
}

// Utility: Format size metrics
function formatByteSize(bytes) {
  if (!bytes || bytes === 0) return 'Unknown Size';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Utility: Fake speed display
function formatSpeed(bytesReceived) {
  // Returns a pseudo bandwidth speed indicator
  return 'Downloading...';
}

// Utility: Clipboard manager with hover feedback animation
function copyTextToClipboard(text, btnElement, successText) {
  const originalHtml = btnElement.innerHTML;
  
  navigator.clipboard.writeText(text).then(() => {
    btnElement.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3" width="12" height="12" style="margin-right: 4px;">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <span style="color:#10b981;">${successText}</span>
    `;
    btnElement.style.borderColor = '#10b981';
    
    setTimeout(() => {
      btnElement.innerHTML = originalHtml;
      btnElement.style.borderColor = '';
    }, 2000);
  }).catch(err => {
    alert('Failed to copy link: ' + err);
  });
}

// Mock logs to inspect designs during browser mock review
function setupMockDataForDevelopment() {
  document.getElementById('currentDomain').textContent = 'example-video-site.com';
  detectedVideosList = [
    {
      url: 'https://example.com/assets/promotional_video.mp4',
      contentType: 'video/mp4',
      size: 24500000,
      type: 'MP4',
      title: 'creator_promo_clip_hd',
      source: 'Network Sniffer',
      detectedAt: Date.now() - 5000
    },
    {
      url: 'https://cdn.example.com/streams/live_presentation/playlist.m3u8',
      contentType: 'application/vnd.apple.mpegurl',
      size: 0,
      type: 'HLS Stream (M3U8)',
      title: 'creator_vlog_leak_m3u8_stream',
      source: 'API Interceptor',
      detectedAt: Date.now() - 30000
    },
    {
      url: 'https://example.com/assets/vertical_reel_1080.webm',
      contentType: 'video/webm',
      size: 14200000,
      type: 'WEBM',
      title: 'subscriber_bonus_feed_vertical_hd',
      source: 'DOM Scan',
      detectedAt: Date.now() - 60000
    }
  ];
  renderVideoList();
}

// Utility: Update progress bar within button
function updateButtonProgress(btn, text, percentage) {
  btn.innerHTML = `
    <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${percentage}%; background: rgba(255, 255, 255, 0.2); transition: width 0.1s ease-out; pointer-events: none;"></div>
    <span style="position: relative; z-index: 10;">${text} (${percentage}%)</span>
  `;
}
