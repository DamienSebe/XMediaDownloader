// [X Media DL] content.js
// Injects a download button into each tweet's action bar and extracts media URLs
// from the DOM (images) and from JSON captured by inject.js (videos/GIFs, and images
// as a higher-confidence source).

(function () {
  const LOG_PREFIX = '[X Media DL]';
  const BTN_MARK = 'data-xmdl-injected';

  // Tweet container selector covering both UIs:
  // - legacy: <article data-testid="tweet">
  // - new "x-web" client: <div role="link" data-href="/user/status/id"> wrapping <article>
  const TWEET_CELL_SEL = 'article[data-testid="tweet"], [role="link"][data-href*="/status/"]';

  let enabled = true;
  let downloadFolder = 'XMediaDownloader';

  // tweetId -> array of raw media objects from GraphQL/API responses
  const tweetMediaCache = new Map();

  // video id (amplify_video_thumb/ext_tw_video_thumb poster id) -> { mp4: [], m3u8: [] }
  // captured from the player's own network requests by inject.js. Needed on the new
  // x-web UI where <video src> is a blob: URL (MediaSource), so no direct URL exists in the DOM.
  const videoUrlCache = new Map();

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
    if (!data || data.source !== 'xmediadl') return;
    if (data.type === 'media-data' && data.tweetId && Array.isArray(data.mediaList)) {
      tweetMediaCache.set(data.tweetId, data.mediaList);
    } else if (data.type === 'video-url' && data.videoId && data.url) {
      const entry = videoUrlCache.get(data.videoId) || { mp4: [], m3u8: [] };
      const isHls = /\.m3u8(\?|#|$)/i.test(data.url);
      // Fragments are never standalone-playable: .ts/.m4s media segments and
      // seg/chunk/init-style init segments. Note init segments can also hide
      // behind plain ".mp4" names - background.js range-checks for those.
      const isFrag =
        /\.(ts|m4s|mp4s)(\?|#|$)/i.test(data.url) ||
        /\/(seg|chunk|clip|frag|init)[^/]*\.(mp4|m4s|ts)(\?|#|$)/i.test(data.url);
      const list = isHls ? entry.m3u8 : entry.mp4;
      if (!isHls && !isFrag && !list.includes(data.url)) list.push(data.url);
      videoUrlCache.set(data.videoId, entry);
    }
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
    const isMp4 = (v) => (v.content_type || v.contentType) === 'video/mp4' || /\.mp4(\?|$)/i.test(v.url || '');
    const mp4s = videoInfo.variants.filter((v) => isMp4(v) && v.url);
    if (mp4s.length === 0) return null;
    mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return mp4s[0];
  }

  function hasOnlyHls(videoInfo) {
    if (!videoInfo || !Array.isArray(videoInfo.variants)) return false;
    const type = (v) => v.content_type || v.contentType || '';
    const hasHls = videoInfo.variants.some((v) => type(v) === 'application/x-mpegURL' || type(v) === 'application/vnd.apple.mpegurl' || /\.m3u8(\?|$)/i.test(v.url || ''));
    const hasMp4 = videoInfo.variants.some((v) => type(v) === 'video/mp4');
    return hasHls && !hasMp4;
  }

  // Video id -> all captured .mp4 URLs, highest WxH in path first.
  function capturedMp4s(videoId) {
    const entry = videoUrlCache.get(videoId);
    if (!entry) return [];
    const res = (u) => { const m = u.match(/\/(\d+)x(\d+)\//); return m ? Number(m[1]) * Number(m[2]) : 0; };
    return entry.mp4.slice().sort((a, b) => res(b) - res(a));
  }

  function bestCapturedMp4(videoId) {
    return capturedMp4s(videoId)[0] || null;
  }

  // All MP4 variant URLs from a video_info object, highest bitrate first.
  function mp4VariantUrls(videoInfo) {
    if (!videoInfo || !Array.isArray(videoInfo.variants)) return [];
    return videoInfo.variants
      .filter((v) => v.url && ((v.content_type || v.contentType) === 'video/mp4' || /\.mp4(\?|$)/i.test(v.url)))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
      .map((v) => v.url);
  }

  // Media field accessors tolerant of both legacy (media_url_https/video_info) and
  // camelCase (mediaUrl/videoInfo) API shapes from the new x-web client.
  const mediaTypeOf = (m) => m.type || m.media_type;
  const mediaUrlOf = (m) => m.media_url_https || m.media_url || m.url || m.preview_image_url;
  const videoInfoOf = (m) => m.video_info || m.videoInfo;

  // Status permalink anchors owned by THIS article - i.e. not inside a nested
  // repost/quote article, which belongs to a different tweet.
  function ownedStatusLinks(article) {
    return Array.from(article.querySelectorAll('a[href*="/status/"]'))
      .filter((a) => a.closest('article') === article);
  }

  function extractTweetIdAndUser(article) {
    const parse = (href) => href?.match(/\/([^/]+)\/status\/(\d+)/);
    // New "x-web" UI: the tweet cell is a role=link whose data-href IS the permalink.
    // Only trust it when this article is the cell's own (first) article - in reposts
    // the closest() cell of a nested article is the outer tweet's cell.
    const cell = article.closest?.('[role="link"][data-href*="/status/"]');
    const m1 = cell && cell.querySelector('article') === article && parse(cell.getAttribute('data-href'));
    if (m1) return { username: m1[1], tweetId: m1[2] };
    // Legacy UI timestamp link (contains <time>), else the first owned status
    // permalink - on the new UI that's the timestamp anchor ("17m"/"Nov 22").
    const owned = ownedStatusLinks(article);
    const link = owned.find((a) => a.querySelector('time')) || owned[0];
    const m2 = link && parse(link.getAttribute('href'));
    return m2 ? { username: m2[1], tweetId: m2[2] } : null;
  }

  // Quote-tweets/reposts nest a second tweet (with its own id/media) inside the outer
  // tweet. Collect every "status permalink" reference (outer tweet first) so we can
  // also look up the nested tweet's cached media, which is keyed by its own tweet ID
  // in tweetMediaCache (see inject.js's walkForMedia). On the new UI this also picks up
  // media-attribution links inside the player (videos embedded from another tweet).
  function extractAllTweetRefs(article) {
    const refs = [];
    const seen = new Set();
    const add = (href) => {
      const m = href?.match(/\/([^/]+)\/status\/(\d+)/);
      if (m && !seen.has(m[2])) { seen.add(m[2]); refs.push({ username: m[1], tweetId: m[2] }); }
    };
    // Own permalink first: the new-UI cell data-href (guarded by ownership as in
    // extractTweetIdAndUser), then this article's owned status links (timestamp,
    // quote-card permalinks), then nested x-web cells and player attribution links
    // so embedded/quoted media keyed under other tweet IDs is also found.
    const cell = article.closest?.('[role="link"][data-href*="/status/"]');
    if (cell && cell.querySelector('article') === article) add(cell.getAttribute('data-href'));
    ownedStatusLinks(article).forEach((a) => add(a.getAttribute('href')));
    article.querySelectorAll('[role="link"][data-href*="/status/"]').forEach((d) => add(d.getAttribute('data-href')));
    article.querySelectorAll('[data-press-control] a[href*="/status/"]').forEach((a) => add(a.getAttribute('href')));
    return refs;
  }

  // Build the list of downloadable media items for a tweet: [{ url, filename }]
  function getMediaForTweet(article, username, tweetId) {
    const items = [];
    const refs = extractAllTweetRefs(article);
    const refsToCheck = refs.length > 0 ? refs : [{ username, tweetId }];

    const seenUrls = new Set();
    refsToCheck.forEach((ref) => {
      const cached = tweetMediaCache.get(ref.tweetId);
      if (!cached || cached.length === 0) return;

      cached.forEach((media, idx) => {
        const type = mediaTypeOf(media);
        const suffix = cached.length > 1 ? `_${idx + 1}` : '';
        if (type === 'photo') {
          const url = upgradeImageUrl(mediaUrlOf(media));
          if (url && !seenUrls.has(url)) { seenUrls.add(url); items.push({ url, filename: `${ref.username}_${ref.tweetId}${suffix}.jpg`, type: 'photo' }); }
        } else if (type === 'video' || type === 'animated_gif') {
          const candidates = mp4VariantUrls(videoInfoOf(media));
          // Also try player-captured URLs for the same media id (the amplify_video
          // path id equals the media id) in case the listed variants are DASH init
          // segments that only LOOK like .mp4s.
          capturedMp4s(media.id_str || media.id).forEach((u) => {
            if (!candidates.includes(u)) candidates.push(u);
          });
          if (candidates.length > 0 && !seenUrls.has(candidates[0])) {
            seenUrls.add(candidates[0]);
            items.push({ url: candidates[0], candidates, filename: `${ref.username}_${ref.tweetId}${suffix}.mp4`, type });
          } else if (candidates.length === 0 && hasOnlyHls(videoInfoOf(media))) {
            console.error(
              LOG_PREFIX,
              `content.js: tweet ${ref.tweetId} media #${idx + 1} is HLS-only (.m3u8), no MP4 rendition found.`,
              'Reconstructing MP4 from HLS segments is not implemented - this is a known open technical challenge.',
              videoInfoOf(media)
            );
          } else if (candidates.length === 0) {
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

    // Videos on the new UI use a blob: src (MediaSource), but the poster URL carries
    // the video id, which we can match against URLs captured from the player's own
    // network requests (inject.js -> videoUrlCache).
    article.querySelectorAll('video').forEach((vid) => {
      const poster = vid.getAttribute('poster') || '';
      const vidId = poster.match(/(?:amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\/(\d+)/)?.[1];
      const candidates = vidId ? capturedMp4s(vidId).filter((u) => !seenUrls.has(u)) : [];
      if (candidates.length > 0) {
        candidates.forEach((u) => seenUrls.add(u));
        items.push({ url: candidates[0], candidates, filename: `${username}_${tweetId}.mp4`, type: 'video' });
      } else if (vidId && videoUrlCache.has(vidId)) {
        console.error(LOG_PREFIX, `content.js: only HLS (.m3u8) streams captured for video ${vidId} in tweet ${tweetId}`);
      }
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
    // The action bar is a role="group" containing engagement controls - legacy UI
    // uses data-testid, the new x-web UI uses data-engagement-action. The group must
    // be owned by THIS article: reposts nest the original tweet (with its own bar)
    // inside the outer article, and we must not attach to that one.
    const ENGAGEMENT = '[data-testid="reply"], [data-testid="like"], [data-testid="retweet"], [data-engagement-action="reply"], [data-engagement-action="like"], [data-engagement-action="retweet"]';
    const groups = article.querySelectorAll('[role="group"]');
    for (const g of groups) {
      if (g.closest('article') !== article) continue;
      if (g.querySelector(ENGAGEMENT)) return g;
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
    // New x-web UI: media blocks are wrapped in [data-press-control]; videos carry a
    // pbs.twimg.com poster image; photos render as pbs.twimg.com/media imgs.
    if (article.querySelector('[data-press-control]')) return true;
    if (article.querySelector('video')) return true;
    if (article.querySelector('img[src*="pbs.twimg.com/media"], img[src*="amplify_video_thumb"], img[src*="tweet_video_thumb"]')) return true;
    // Fallbacks in case testids change.
    if (article.querySelector('img[src*="pbs.twimg.com"][src*="format="]')) return true;
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

  function injectButtonForTweet(cell) {
    try {
      // Legacy cells ARE the tweet article. New-UI cells are wrappers that may hold
      // several <article>s (reposts nest the original tweet inside a wrapper article).
      const targets = cell.matches('article') ? [cell] : Array.from(cell.querySelectorAll('article'));
      for (const article of targets) {
        if (article.getAttribute(BTN_MARK) === '1') continue;
        if (!tweetHasMedia(article)) continue;

        const actionBar = findActionBar(article);
        // A found action bar must belong to THIS article - for reposts the outer
        // article only finds the nested tweet's group, which we must not use.
        if (!actionBar || actionBar.closest('article') !== article) {
          if (!actionBar) {
            console.error(LOG_PREFIX, 'content.js: could not locate action bar for a media tweet, skipping button injection', article);
          }
          continue;
        }

        article.setAttribute(BTN_MARK, '1');
        actionBar.appendChild(createButton(article));
      }
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
    // The legacy UI renders the lightbox under #layers; the new x-web client parks
    // open media under a dedicated [data-active-media-holder] container instead.
    for (const root of [document.getElementById('layers'), document.querySelector('[data-active-media-holder]')]) {
      if (!root) continue;
      const swipe = root.querySelector('[data-testid="swipe-to-dismiss"]');
      if (swipe) {
        const el = swipe.querySelector('img[src*="pbs.twimg.com"], video');
        if (el) return el;
      }
      const el = root.querySelector('img[src*="pbs.twimg.com/media"], img[src*="amplify_video_thumb"], video');
      if (el) return el;
    }
    return null;
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
        media = cached.find((m) => mediaKey(mediaUrlOf(m)) === key) || null;
      }
      if (!media) {
        const typed = cached.filter((m) => {
          const t = mediaTypeOf(m);
          return info.kind === 'photo' ? t === 'photo' : t === 'video' || t === 'animated_gif';
        });
        media = typed[info.index] || cached[info.index] || typed[0] || cached[0];
      }

      if (media) {
        const suffix = cached.length > 1 ? `_${cached.indexOf(media) + 1}` : '';
        const type = mediaTypeOf(media);
        if (type === 'photo') {
          return [{ url: upgradeImageUrl(mediaUrlOf(media)), filename: `${info.username}_${info.tweetId}${suffix}.jpg`, type: 'photo' }];
        }
        const candidates = mp4VariantUrls(videoInfoOf(media));
        if (candidates.length > 0) {
          return [{ url: candidates[0], candidates, filename: `${info.username}_${info.tweetId}${suffix}.mp4`, type }];
        }
        console.error(LOG_PREFIX, `content.js: viewer media for tweet ${info.tweetId} has no MP4 variant (possibly HLS-only)`, videoInfoOf(media));
        return [];
      }
    }

    // DOM fallback: download whatever image the viewer is showing.
    if (mediaEl && mediaEl.tagName === 'IMG') {
      return [{ url: upgradeImageUrl(mediaEl.src), filename: `${info.username}_${info.tweetId}_${info.index + 1}.jpg`, type: 'photo' }];
    }

    // New-UI video viewer: the <video> uses a blob: src, so resolve through the
    // poster id against URLs captured from the player's own requests.
    if (mediaEl && mediaEl.tagName === 'VIDEO') {
      const vidId = (mediaEl.getAttribute('poster') || '').match(/(?:amplify_video_thumb|ext_tw_video_thumb|tweet_video_thumb)\/(\d+)/)?.[1];
      const candidates = vidId ? capturedMp4s(vidId) : [];
      if (candidates.length > 0) {
        return [{ url: candidates[0], candidates, filename: `${info.username}_${info.tweetId}_${info.index + 1}.mp4`, type: 'video' }];
      }
      console.error(LOG_PREFIX, `content.js: no captured MP4 for viewer video (poster id ${vidId || 'unknown'}) in tweet ${info.tweetId}`);
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
      const cells = scope.querySelectorAll(TWEET_CELL_SEL);
      let mediaCount = 0;
      cells.forEach((cell) => {
        if (tweetHasMedia(cell)) mediaCount += 1;
        injectButtonForTweet(cell);
      });
      if (cells.length > 0) {
        console.log(LOG_PREFIX, `content.js: scanned ${cells.length} tweet(s), ${mediaCount} with media, ${document.querySelectorAll('.xmdl-btn').length} button(s) in DOM`);
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
          if (node.matches && node.matches(TWEET_CELL_SEL)) {
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
