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

  // Recursively walk a parsed JSON response looking for "legacy" tweet objects that carry
  // both an id_str and extended_entities.media (X's GraphQL/REST responses nest tweets deeply
  // and inconsistently, so a generic recursive walk is the most robust approach).
  function walkForMedia(node, seen) {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walkForMedia(item, seen);
      return;
    }

    const hasId = typeof node.id_str === 'string';
    const ee = node.extended_entities || node.entities;
    if (hasId && ee && Array.isArray(ee.media)) {
      try {
        postMedia(node.id_str, ee.media);
      } catch (e) {
        console.error(LOG_PREFIX, 'inject.js: error processing media for tweet', node.id_str, e);
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

  // --- Patch fetch ---
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const result = originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (url.includes('/graphql/') || url.includes('/i/api/')) {
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
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      const url = this.__xmdl_url || '';
      if (url.includes('/graphql/') || url.includes('/i/api/')) {
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

  console.log(LOG_PREFIX, 'inject.js loaded: intercepting GraphQL/API responses for media URLs');
})();
