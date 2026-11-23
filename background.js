// [X Media DL] background.js
// MV3 service worker. Receives download requests from content.js and triggers
// chrome.downloads.download() for each media item.

const LOG_PREFIX = '[X Media DL]';

function sanitizeFolder(folder) {
  if (!folder || typeof folder !== 'string') return 'XMediaDownloader';
  return folder.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/^\/+|\/+$/g, '') || 'XMediaDownloader';
}

function downloadOne(item, folder) {
  return new Promise((resolve) => {
    try {
      const safeFolder = sanitizeFolder(folder);
      const filename = `${safeFolder}/${item.filename}`;
      chrome.downloads.download(
        {
          url: item.url,
          filename,
          conflictAction: 'uniquify',
          saveAs: false,
        },
        (downloadId) => {
          if (chrome.runtime.lastError || downloadId === undefined) {
            console.error(
              LOG_PREFIX,
              'background.js: chrome.downloads.download failed for',
              item.url,
              chrome.runtime.lastError && chrome.runtime.lastError.message
            );
            resolve({ ok: false, item, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
          } else {
            resolve({ ok: true, item, downloadId });
          }
        }
      );
    } catch (e) {
      console.error(LOG_PREFIX, 'background.js: unexpected error triggering download for', item, e);
      resolve({ ok: false, item, error: String(e) });
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'xmdl-download') return false;

  const items = Array.isArray(message.items) ? message.items : [];
  const folder = message.folder;

  if (items.length === 0) {
    console.error(LOG_PREFIX, 'background.js: received download request with no items');
    sendResponse({ ok: false, error: 'No media items provided' });
    return true;
  }

  Promise.all(items.map((item) => downloadOne(item, folder)))
    .then((results) => {
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        console.error(LOG_PREFIX, 'background.js: some downloads failed', failed);
        sendResponse({ ok: failed.length < results.length, error: `${failed.length}/${results.length} downloads failed` });
      } else {
        sendResponse({ ok: true, count: results.length });
      }
    })
    .catch((e) => {
      console.error(LOG_PREFIX, 'background.js: unexpected error in download batch', e);
      sendResponse({ ok: false, error: String(e) });
    });

  return true; // keep sendResponse alive for async work
});

console.log(LOG_PREFIX, 'background.js service worker started');
