// [X Media DL] inject.js
// Runs in the PAGE context (injected via <script src=chrome.runtime.getURL(...)>, never inline)
// to intercept X's internal GraphQL/API responses and pull out media (image/video/gif) info
// that isn't otherwise present in the DOM (e.g. MP4 variant URLs for videos).
//
// Communicates results back to content.js via window.postMessage, since page-context scripts
// cannot use chrome.* APIs directly.

(function () {
  const LOG_PREFIX = '[X Media DL]';
  const SOURCE = 'xmediadl';

  function postMedia(tweetId, mediaList) {
    try {
      window.postMessage(
        { source: SOURCE, type: 'media-data', tweetId, mediaList },
        window.location.origin
      );
    } catch (e) {
      console.error(LOG_PREFIX, 'inject.js: failed to postMessage media data', e);
    }
  }

  function postVideoUrl(videoId, url) {
    try {
      window.postMessage(
        { source: SOURCE, type: 'video-url', videoId, url },
        window.location.origin
      );
    } catch (e) {
      // Ignore postMessage failures for media URLs; they're just one lookup source.
    }
  }

  // ---------- Tweet/media JSON discovery ----------

  // Pull the first non-empty media array found at any of the common locations.
  // Covers legacy (extended_entities/entities.media) and flatter shapes the new
  // x-web client might return (media, mediaEntities).
  function findMediaArray(node) {
    const candidates = [
      node.extended_entities,
      node.entities,
      node.extendedEntities,
      node.mediaEntities,
      node.media
    ];
    for (const c of candidates) {
      const arr = c && (Array.isArray(c) ? c : c.media);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    }
    return null;
  }

  // Recursively walk a parsed JSON response looking for tweet objects that carry
  // both an id and a media array (X's API/GraphQL responses nest tweets deeply
  // and inconsistently, so a generic recursive walk is the most robust approach).
  function walkForMedia(node, seen) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walkForMedia(item, seen);
      return;
    }

    const tweetId = node.id_str || node.rest_id || (typeof node.id === 'string' && /^\d{5,}$/.test(node.id) ? node.id : null);
    const media = findMediaArray(node);
    if (tweetId && media) {
      // Only report media entries that look like actual media objects.
      const real = media.filter(
        (m) => m && typeof m === 'object' && (m.media_url_https || m.media_url || m.url || m.video_info || m.videoInfo || m.type)
      );
      if (real.length > 0) {
        try {
          postMedia(tweetId, real);
        } catch (e) {
          console.error(LOG_PREFIX, 'inject.js: error processing media for tweet', tweetId, e);
        }
      }
    }

    for (const key in node) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        walkForMedia(node[key], seen);
      }
    }
  }

  function handleJsonResponse(json) {
    try {
      walkForMedia(json, new WeakSet());
    } catch (e) {
      console.error(LOG_PREFIX, 'inject.js: failed to parse/walk JSON response', e);
    }
  }

  // ---------- Video stream URL capture ----------
  // The new x-web player renders <video src="blob:..."> via MediaSource, so no
  // direct URL exists in the DOM. The underlying requests still flow through the
  // network layer though, so capture every video.twimg.com URL we see and key it
  // by the numeric video id it shares with the pbs.twimg.com poster URL
  // (amplify_video_thumb/<id> <-> amplify_video/<id>, ext_tw_video_thumb/<id> <->
  // ext_tw_video/<id>). content.js matches them via the video's poster attribute.
  const VIDEO_ID_RE = /\/(amplify_video|ext_tw_video)\/(\d+)\//;
  const reportedVideoUrls = new Set();

  function reportVideoUrl(rawUrl) {
    try {
      const m = String(rawUrl).match(VIDEO_ID_RE);
      if (!m || reportedVideoUrls.has(rawUrl)) return;
      reportedVideoUrls.add(rawUrl);
      postVideoUrl(m[2], rawUrl);
    } catch (e) {
      // best-effort only
    }
  }

  // Resource timing catches media fetches that bypass window.fetch/XMLHttpRequest
  // (e.g. native MSE pipelines). Sweep periodically - entries are cheap to scan.
  function sweepResourceEntries() {
    try {
      for (const e of performance.getEntriesByType('resource')) {
        if (typeof e.name === 'string' && e.name.includes('video.twimg.com')) {
          reportVideoUrl(e.name);
        }
      }
    } catch (e) {
      // Resource timing unavailable; hooks below still cover fetch/XHR.
    }
  }

  // ---------- Bootstrap / embedded data ----------
  // The new x-web client is server-rendered and ships tweet data inside the page
  // (window.__INITIAL_DATA__ per community reports; older builds used
  // window.__INITIAL_STATE__). Walk whatever is present, and re-check shortly
  // after load in case it is assigned asynchronously.
  function walkEmbeddedData() {
    for (const key of ['__INITIAL_DATA__', '__INITIAL_STATE__']) {
      const data = window[key];
      if (data && typeof data === 'object') handleJsonResponse(data);
    }
  }

  // ---------- Network hooks ----------

  function isApiUrl(url) {
    return (
      url.includes('/graphql') ||
      url.includes('/i/api') ||
      url.includes('api.x.com') ||
      url.includes('api.twitter.com')
    );
  }

  function checkUrl(url) {
    if (!url) return;
    if (url.includes('video.twimg.com')) reportVideoUrl(url);
    return isApiUrl(url);
  }

  // --- Patch fetch ---
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const result = originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (checkUrl(url)) {
        result
          .then((res) => res.clone().json())
          .then((json) => handleJsonResponse(json))
          .catch(() => {
            /* not JSON or already consumed; ignore silently, not an error */
          });
      }
    } catch (e) {
      console.error(LOG_PREFIX, 'inject.js: fetch hook error', e);
    }
    return result;
  };

  // --- Patch XMLHttpRequest ---
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xmdl_url = url;
    try {
      if (typeof url === 'string' && url.includes('video.twimg.com')) reportVideoUrl(url);
    } catch (e) {
      // best-effort only
    }
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const url = this.__xmdl_url || '';
      if (isApiUrl(url)) {
        this.addEventListener('load', function () {
          try {
            const json = JSON.parse(this.responseText);
            handleJsonResponse(json);
          } catch (e) {
            // Response wasn't JSON (or was empty) - not necessarily an error.
          }
        });
      }
    } catch (e) {
      console.error(LOG_PREFIX, 'inject.js: XHR hook error', e);
    }
    return originalSend.apply(this, args);
  };

  // --- Kick off ---
  walkEmbeddedData();
  sweepResourceEntries();
  setInterval(sweepResourceEntries, 4000);
  setTimeout(walkEmbeddedData, 2000);
  window.addEventListener('load', walkEmbeddedData);

  console.log(LOG_PREFIX, 'inject.js loaded: intercepting API responses and video URLs');
})();
