// [X Media DL] content.js
// Injects a download button into each tweet's action bar and extracts media URLs
// from the DOM (images) and from JSON captured by inject.js (videos/GIFs, and images
// as a higher-confidence source).

(function () {
  const LOG_PREFIX = '[X Media DL]';
  const BTN_MARK = 'data-xmdl-injected';

  let enabled = true;
  let downloadFolder = 'XMediaDownloader';

  // tweetId -> array of raw media objects from GraphQL/API responses
  const tweetMediaCache = new Map();

  // ---------- Storage / enable-disable ----------

  function loadSettings() {
    try {
      chrome.storage.local.get(
        { xmdl_enabled: true, xmdl_folder: 'XMediaDownloader' },
        (res) => {
          enabled = res.xmdl_enabled;
          downloadFolder = res.xmdl_folder || 'XMediaDownloader';
          toggleAllButtons(enabled);
        }
      );
    } catch (e) {
      console.error(LOG_PREFIX, 'content.js: failed to load settings from storage', e);
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.xmdl_enabled) {
        enabled = changes.xmdl_enabled.newValue;
        toggleAllButtons(enabled);
      }
      if (changes.xmdl_folder) {
        downloadFolder = changes.xmdl_folder.newValue || 'XMediaDownloader';
      }
    });
  } catch (e) {
    console.error(LOG_PREFIX, 'content.js: failed to attach storage listener', e);
  }

  function toggleAllButtons(show) {
    document.querySelectorAll('.xmdl-btn').forEach((btn) => {
      btn.style.display = show ? '' : 'none';
    });
  }

  // ---------- Page-context script injection (CSP-safe: external file, not inline) ----------

  function injectPageScript() {
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('inject.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.error(LOG_PREFIX, 'content.js: failed to inject page-context script', e);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'xmediadl' || data.type !== 'media-data') return;
    if (!data.tweetId || !Array.isArray(data.mediaList)) return;
    tweetMediaCache.set(data.tweetId, data.mediaList);
  });

  // ---------- Media URL helpers ----------

  function upgradeImageUrl(src) {
    try {
      const url = new URL(src, window.location.href);
      if (!url.hostname.includes('twimg.com')) return src;
      const ext = (url.pathname.split('.').pop() || 'jpg').toLowerCase();
      const format = url.searchParams.get('format') || (ext === 'png' ? 'png' : 'jpg');
      url.searchParams.set('format', format);
      url.searchParams.set('name', 'orig');
      return url.toString();
    } catch (e) {
      console.error(LOG_PREFIX, 'content.js: failed to upgrade image URL', src, e);
      return src;
    }
  }

  function bestMp4Variant(videoInfo) {
    if (!videoInfo || !Array.isArray(videoInfo.variants)) return null;
    const mp4s = videoInfo.variants.filter((v) => v.content_type === 'video/mp4');
    if (mp4s.length === 0) return null;
    mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return mp4s[0];
  }

  function hasOnlyHls(videoInfo) {
    if (!videoInfo || !Array.isArray(videoInfo.variants)) return false;
    const hasHls = videoInfo.variants.some((v) => v.content_type === 'application/x-mpegURL');
    const hasMp4 = videoInfo.variants.some((v) => v.content_type === 'video/mp4');
    return hasHls && !hasMp4;
  }

  function extractTweetIdAndUser(article) {
    const link = article.querySelector('a[href*="/status/"] time')?.closest('a');
    if (!link) return null;
    const match = link.getAttribute('href')?.match(/\/([^/]+)\/status\/(\d+)/);
    if (!match) return null;
    return { username: match[1], tweetId: match[2] };
  }

  // Quote-tweets nest a second full tweet (with its own id/media) inside the outer tweet's
  // article. Collect every "status permalink" reference in DOM order (outer tweet first,
  // followed by any quoted tweet) so we can also look up the quoted tweet's cached media,
  // which is keyed by its own tweet ID in tweetMediaCache (see inject.js's walkForMedia).
  function extractAllTweetRefs(article) {
    const refs = [];
    const seen = new Set();
    article.querySelectorAll('a[href*="/status/"] time').forEach((time) => {
      const link = time.closest('a');
      if (!link) return;
      const match = link.getAttribute('href')?.match(/\/([^/]+)\/status\/(\d+)/);
      if (!match) return;
      const tweetId = match[2];
      if (seen.has(tweetId)) return;
      seen.add(tweetId);
      refs.push({ username: match[1], tweetId });
    });
    return refs;
  }

  // Build the list of downloadable media items for a tweet: [{ url, filename }]
  function getMediaForTweet(article, username, tweetId) {
    const items = [];
    const refs = extractAllTweetRefs(article);
    const refsToCheck = refs.length > 0 ? refs : [{ username, tweetId }];

    refsToCheck.forEach((ref) => {
      const cached = tweetMediaCache.get(ref.tweetId);
      if (!cached || cached.length === 0) return;

      cached.forEach((media, idx) => {
        const suffix = cached.length > 1 ? `_${idx + 1}` : '';
        if (media.type === 'photo') {
          const url = upgradeImageUrl(media.media_url_https || media.media_url);
          items.push({ url, filename: `${ref.username}_${ref.tweetId}${suffix}.jpg`, type: 'photo' });
        } else if (media.type === 'video' || media.type === 'animated_gif') {
          const best = bestMp4Variant(media.video_info);
          if (best) {
            items.push({ url: best.url, filename: `${ref.username}_${ref.tweetId}${suffix}.mp4`, type: media.type });
          } else if (hasOnlyHls(media.video_info)) {
            console.error(
              LOG_PREFIX,
              `content.js: tweet ${ref.tweetId} media #${idx + 1} is HLS-only (.m3u8), no MP4 rendition found.`,
              'Reconstructing MP4 from HLS segments is not implemented - this is a known open technical challenge.',
              media.video_info
            );
          } else {
            console.error(LOG_PREFIX, `content.js: tweet ${ref.tweetId} media #${idx + 1} has no usable video_info`, media);
          }
        }
      });
    });

    if (items.length > 0) return items;

    // DOM fallback (JSON not captured yet, e.g. race condition on first paint).
    console.error(
      LOG_PREFIX,
      `content.js: no cached JSON media found for tweet ${tweetId}; falling back to DOM scraping (images only, video will be skipped).`,
      'tweet refs checked:', refsToCheck,
      'cache keys available:', Array.from(tweetMediaCache.keys())
    );

    const imgs = article.querySelectorAll('img[src*="pbs.twimg.com/media"]');
    const seen = new Set();
    let idx = 0;
    imgs.forEach((img) => {
      const base = img.src.split('?')[0];
      if (seen.has(base)) return;
      seen.add(base);
      idx += 1;
      const suffix = imgs.length > 1 ? `_${idx}` : '';
      items.push({ url: upgradeImageUrl(img.src), filename: `${username}_${tweetId}${suffix}.jpg`, type: 'photo' });
    });

    if (items.length === 0) {
      console.error(LOG_PREFIX, `content.js: could not find any downloadable media (image or video) for tweet ${tweetId}`);
    }

    return items;
  }

  // ---------- Button injection ----------

  const DOWNLOAD_SVG = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d="M12 16.5l-6-6 1.41-1.41L11 12.67V3h2v9.67l3.59-3.58L18 10.5l-6 6zM5 19h14v2H5z"></path>
    </svg>`;

  function findActionBar(article) {
    const replyBtn = article.querySelector('[data-testid="reply"]');
    if (replyBtn) {
      const group = replyBtn.closest('[role="group"]');
      if (group) return group;
    }
    // Fallback: any role="group" inside the tweet that also contains a "like" button.
    const groups = article.querySelectorAll('[role="group"]');
    for (const g of groups) {
      if (g.querySelector('[data-testid="like"]') || g.querySelector('[data-testid="retweet"]')) {
        return g;
      }
    }
    return null;
  }

  function tweetHasMedia(article) {
    // Prefer stable structural containers - these exist as soon as the tweet mounts,
    // even before the lazily-loaded <img>/<video> src attributes are populated.
    if (article.querySelector('[data-testid="tweetPhoto"]')) return true;
    if (article.querySelector('[data-testid="videoPlayer"]')) return true;
    if (article.querySelector('[data-testid="videoComponent"]')) return true;
    if (article.querySelector('[data-testid="swipe-to-dismiss"]')) return true;
    // Fallbacks in case testids change.
    if (article.querySelector('img[src*="pbs.twimg.com/media"]')) return true;
    if (article.querySelector('img[src*="pbs.twimg.com"][src*="format="]')) return true;
    if (article.querySelector('video')) return true;
    return false;
  }

  function createButton(article) {
    const btn = document.createElement('div');
    btn.className = 'xmdl-btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('aria-label', 'Download media');
    btn.title = 'Download media (X Media Downloader)';
    btn.innerHTML = `<div class="xmdl-btn-inner">${DOWNLOAD_SVG}</div>`;
    if (!enabled) btn.style.display = 'none';

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleDownloadClick(article, btn);
    });

    return btn;
  }

  function setButtonState(btn, state) {
    // state: 'idle' | 'working' | 'done' | 'error'
    btn.classList.remove('xmdl-working', 'xmdl-done', 'xmdl-error');
    if (state === 'working') btn.classList.add('xmdl-working');
    if (state === 'done') btn.classList.add('xmdl-done');
    if (state === 'error') btn.classList.add('xmdl-error');
  }

  function sendDownloadItems(items, btn) {
    chrome.runtime.sendMessage(
      { type: 'xmdl-download', items, folder: downloadFolder },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error(LOG_PREFIX, 'content.js: message to background failed', chrome.runtime.lastError.message);
          setButtonState(btn, 'error');
          return;
        }
        if (response && response.ok) {
          setButtonState(btn, 'done');
          setTimeout(() => setButtonState(btn, 'idle'), 1500);
        } else {
          console.error(LOG_PREFIX, 'content.js: background reported download failure', response && response.error);
          setButtonState(btn, 'error');
        }
      }
    );
  }

  function handleDownloadClick(article, btn) {
    try {
      const ids = extractTweetIdAndUser(article);
      if (!ids) {
        console.error(LOG_PREFIX, 'content.js: could not determine tweet id/username for clicked tweet', article);
        setButtonState(btn, 'error');
        return;
      }
      const { username, tweetId } = ids;
      const items = getMediaForTweet(article, username, tweetId);

      if (items.length === 0) {
        setButtonState(btn, 'error');
        return;
      }

      setButtonState(btn, 'working');
      sendDownloadItems(items, btn);
    } catch (e) {
      console.error(LOG_PREFIX, 'content.js: unexpected error handling download click', e);
      setButtonState(btn, 'error');
    }
  }

  function injectButtonForTweet(article) {
    try {
      if (article.getAttribute(BTN_MARK) === '1') return;
      if (!tweetHasMedia(article)) return;

      const actionBar = findActionBar(article);
      if (!actionBar) {
        console.error(LOG_PREFIX, 'content.js: could not locate action bar for a media tweet, skipping button injection', article);
        return;
      }

      article.setAttribute(BTN_MARK, '1');
      const btn = createButton(article);
      actionBar.appendChild(btn);
    } catch (e) {
      console.error(LOG_PREFIX, 'content.js: failed to inject button for tweet', e);
    }
  }

  // ---------- Media viewer (opened photo/video at /status/<id>/photo|video/<n>) ----------

  // On these routes X renders the media in a modal layer (#layers) outside any tweet
  // <article>, so the action-bar button never appears. A floating button over the
  // viewer covers it. Everything is derived from the URL, so this also keeps working
  // when X doesn't render a tweet article inside the modal at all.

  function getViewerInfo() {
    const m = window.location.pathname.match(/^\/([^/]+)\/status\/(\d+)\/(photo|video)\/(\d+)\/?$/);
    if (!m) return null;
    return { username: m[1], tweetId: m[2], kind: m[3], index: Math.max(0, parseInt(m[4], 10) - 1) };
  }

  // Media identity ignoring format/size suffixes: the API's media_url ends in a file
  // extension ("/media/ABC.jpg") while rendered <img> srcs use "?format=jpg" on the
  // extensionless base ("/media/ABC").
  function mediaKey(u) {
    return (u || '').split('?')[0].replace(/\.[a-z0-9]+$/i, '');
  }

  function findViewerMediaEl() {
    const layers = document.getElementById('layers');
    if (!layers) return null;
    const swipe = layers.querySelector('[data-testid="swipe-to-dismiss"]');
    if (swipe) {
      const el = swipe.querySelector('img[src*="pbs.twimg.com"], video');
      if (el) return el;
    }
    return layers.querySelector('img[src*="pbs.twimg.com/media"], video');
  }

  function getMediaForViewer(info, mediaEl) {
    const cached = tweetMediaCache.get(info.tweetId);

    if (cached && cached.length > 0) {
      // Prefer matching the media currently shown in the viewer to its API object by
      // URL, so the right item is picked even when the /photo/<n> index doesn't line
      // up with the extended_entities.media index (e.g. mixed photo+video tweets).
      let media = null;
      if (mediaEl && mediaEl.tagName === 'IMG') {
        const key = mediaKey(mediaEl.src);
        media = cached.find((m) => mediaKey(m.media_url_https || m.media_url) === key) || null;
      }
      if (!media) {
        const typed = cached.filter((m) =>
          info.kind === 'photo' ? m.type === 'photo' : m.type === 'video' || m.type === 'animated_gif'
        );
        media = typed[info.index] || cached[info.index] || typed[0] || cached[0];
      }

      if (media) {
        const suffix = cached.length > 1 ? `_${cached.indexOf(media) + 1}` : '';
        if (media.type === 'photo') {
          return [{ url: upgradeImageUrl(media.media_url_https || media.media_url), filename: `${info.username}_${info.tweetId}${suffix}.jpg`, type: 'photo' }];
        }
        const best = bestMp4Variant(media.video_info);
        if (best) {
          return [{ url: best.url, filename: `${info.username}_${info.tweetId}${suffix}.mp4`, type: media.type }];
        }
        console.error(LOG_PREFIX, `content.js: viewer media for tweet ${info.tweetId} has no MP4 variant (possibly HLS-only)`, media.video_info);
        return [];
      }
    }

    // DOM fallback: download whatever image the viewer is showing.
    if (mediaEl && mediaEl.tagName === 'IMG') {
      return [{ url: upgradeImageUrl(mediaEl.src), filename: `${info.username}_${info.tweetId}_${info.index + 1}.jpg`, type: 'photo' }];
    }

    console.error(LOG_PREFIX, `content.js: no media data available for viewer tweet ${info.tweetId}`);
    return [];
  }

  function handleViewerClick(btn) {
    try {
      const info = getViewerInfo();
      if (!info) {
        setButtonState(btn, 'error');
        return;
      }
      const items = getMediaForViewer(info, findViewerMediaEl());
      if (items.length === 0) {
        setButtonState(btn, 'error');
        return;
      }
      setButtonState(btn, 'working');
      sendDownloadItems(items, btn);
    } catch (e) {
      console.error(LOG_PREFIX, 'content.js: unexpected error handling viewer download click', e);
      setButtonState(btn, 'error');
    }
  }

  function createViewerButton() {
    const btn = document.createElement('div');
    btn.id = 'xmdl-viewer-btn';
    btn.className = 'xmdl-btn xmdl-viewer';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.setAttribute('aria-label', 'Download media');
    btn.title = 'Download media (X Media Downloader)';
    btn.innerHTML = `<div class="xmdl-btn-inner">${DOWNLOAD_SVG}</div>`;
    if (!enabled) btn.style.display = 'none';

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleViewerClick(btn);
    });

    document.body.appendChild(btn);
  }

  // Show the floating button only while a media viewer page is actually displaying
  // an image or video. Called from init and the MutationObserver (SPA navigation and
  // layer mount/unmount always mutate the DOM, so no URL polling is needed).
  function syncViewerButton() {
    try {
      const existing = document.getElementById('xmdl-viewer-btn');
      if (!getViewerInfo() || !findViewerMediaEl()) {
        if (existing) existing.remove();
        return;
      }
      if (!existing) createViewerButton();
    } catch (e) {
      console.error(LOG_PREFIX, 'content.js: failed to sync viewer download button', e);
    }
  }

  function scanForTweets(root) {
    try {
      const scope = root || document;
      const articles = scope.querySelectorAll('article[data-testid="tweet"]');
      let mediaCount = 0;
      articles.forEach((article) => {
        if (tweetHasMedia(article)) mediaCount += 1;
        injectButtonForTweet(article);
      });
      if (articles.length > 0) {
        console.log(LOG_PREFIX, `content.js: scanned ${articles.length} tweet(s), ${mediaCount} with media, ${document.querySelectorAll('.xmdl-btn').length} button(s) in DOM`);
      }
    } catch (e) {
      console.error(LOG_PREFIX, 'content.js: error scanning for tweets', e);
    }
  }

  // ---------- MutationObserver for infinite scroll ----------

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          if (node.matches && node.matches('article[data-testid="tweet"]')) {
            injectButtonForTweet(node);
          } else if (node.querySelectorAll) {
            scanForTweets(node);
          }
        });
      }
      syncViewerButton();
    });

    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
  }

  // ---------- Init ----------

  function init() {
    loadSettings();
    injectPageScript();
    scanForTweets(document);
    syncViewerButton();
    startObserver();
    console.log(LOG_PREFIX, 'content.js initialized on', window.location.hostname);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
