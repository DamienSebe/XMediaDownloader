// [X Media DL] background.js
// MV3 service worker. Receives download requests from content.js and triggers
// chrome.downloads.download() for each media item.

const LOG_PREFIX = '[X Media DL]';

function sanitizeFolder(folder) {
  if (!folder || typeof folder !== 'string') return 'XMediaDownloader';
  return folder.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/^\/+|\/+$/g, '') || 'XMediaDownloader';
}

// X's new player streams fMP4/DASH: ~1KB "init segment" .mp4s (ftyp+moov only, no
// mdat) share the video's URL space and are not standalone-playable. Before
// downloading a candidate we range-probe it and require proof of real media
// content: a moov box together with mdat (or a file far larger than an init
// segment). Bare fMP4 fragments (styp/moof, no moov) are rejected too.
const PROBE_BYTES = 16 * 1024;
const MIN_MEDIA_BYTES = 32 * 1024;

function containsAscii(buf, s) {
  const n = s.length;
  outer: for (let i = 0; i + n <= buf.length; i++) {
    for (let j = 0; j < n; j++) if (buf[i + j] !== s.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

async function readPrefix(res, max) {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.length;
    }
  } finally {
    try { await reader.cancel(); } catch (e) { /* ignore */ }
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function probePlayable(url) {
  const res = await fetch(url, {
    headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
    credentials: 'omit',
    redirect: 'follow',
  });
  if (!res.ok && res.status !== 206) return false;
  const tm = (res.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
  let total = tm ? Number(tm[1]) : Number(res.headers.get('content-length') || 0);
  const buf = await readPrefix(res, PROBE_BYTES);
  if (!total) total = buf.length;

  const hasMoov = containsAscii(buf, 'moov');
  const hasMdat = containsAscii(buf, 'mdat');
  const hasFrag = containsAscii(buf, 'styp') || containsAscii(buf, 'moof') || containsAscii(buf, 'sidx');
  if (hasMoov && (hasMdat || total > MIN_MEDIA_BYTES)) return true;
  if (hasFrag && !hasMoov) return false;
  if (hasMdat && total > MIN_MEDIA_BYTES) return true; // mdat-first (non-faststart) MP4
  return false;
}

// Returns the first candidate URL that passes the probe, or falls back to the
// first candidate when every probe failed on the network (don't block downloads
// just because validation couldn't run).
async function resolveDownloadUrl(item) {
  const candidates = Array.isArray(item.candidates) && item.candidates.length > 0
    ? item.candidates
    : [item.url];
  let sawProbeError = false;
  for (const url of candidates) {
    if (!url) continue;
    try {
      if (await probePlayable(url)) return url;
      console.warn(LOG_PREFIX, 'background.js: candidate rejected (init segment/fragment, not playable)', url);
    } catch (e) {
      sawProbeError = true;
      console.error(LOG_PREFIX, 'background.js: probe request failed for', url, e);
    }
  }
  if (sawProbeError) return candidates.find(Boolean) || null;
  return null;
}

async function downloadOne(item, folder) {
  try {
    // Only probe video candidates; photos have no `candidates` and skip this.
    const url = Array.isArray(item.candidates) ? await resolveDownloadUrl(item) : item.url;
    if (!url) {
      console.error(LOG_PREFIX, 'background.js: no playable candidate for', item.filename, item.candidates);
      return { ok: false, item, error: 'No playable MP4 candidate (only init segments/fragments found)' };
    }
    const safeFolder = sanitizeFolder(folder);
    const filename = `${safeFolder}/${item.filename}`;
    return await new Promise((resolve) => {
      chrome.downloads.download(
        {
          url,
          filename,
          conflictAction: 'uniquify',
          saveAs: false,
        },
        (downloadId) => {
          if (chrome.runtime.lastError || downloadId === undefined) {
            console.error(
              LOG_PREFIX,
              'background.js: chrome.downloads.download failed for',
              url,
              chrome.runtime.lastError && chrome.runtime.lastError.message
            );
            resolve({ ok: false, item, error: chrome.runtime.lastError && chrome.runtime.lastError.message });
          } else {
            resolve({ ok: true, item, downloadId });
          }
        }
      );
    });
  } catch (e) {
    console.error(LOG_PREFIX, 'background.js: unexpected error triggering download for', item, e);
    return { ok: false, item, error: String(e) };
  }
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
