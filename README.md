# X Media Downloader

Chrome MV3 extension that adds a download button to tweets/posts on X.com and Twitter.com.

## Install (unpacked, for development)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Visit `x.com` or `twitter.com` — a small download icon appears in the action bar
   of any tweet that has media.

## How it works

- `content.js` scans the timeline with a `MutationObserver`, using stable
  `data-testid` attributes (`tweet`, `reply`, `like`, `retweet`, `videoPlayer`)
  to find tweets and their action bars, so it survives X's class-name churn.
- On the opened media viewer (`/status/<id>/photo/<n>` or `/video/<n>`), where X
  renders the media in a modal layer outside the tweet `<article>`, a floating
  button is overlaid instead. It downloads the currently viewed item: the media
  object is matched from the captured API data by URL (falling back to the
  `/photo/<n>` index), or the displayed `<img>` is used directly.
- `inject.js` is loaded as an external `<script src="...">` (never inline, so it
  is not blocked by X's CSP) into the page context, where it hooks `fetch` and
  `XMLHttpRequest` to read X's own GraphQL/API responses and capture
  `video_info.variants` (MP4 renditions) and image entities. This data is passed
  back to `content.js` via `window.postMessage`.
- Images: highest quality is fetched by requesting
  `...?format=jpg&name=orig` (or the extension detected from the URL).
- Videos/GIFs: the highest-bitrate `video/mp4` variant is selected and downloaded
  directly.
- `background.js` (service worker) performs the actual
  `chrome.downloads.download()` call, saving files into a subfolder of your
  Downloads folder (configurable in the popup, default `XMediaDownloader`),
  named `username_tweetid.jpg` / `.mp4` (multi-image tweets get `_1`, `_2`, ... suffixes).

## Design choices

- **Multi-image tweets (up to 4 images):** clicking the download button
  downloads **all** images in that tweet at once (no submenu), since this is the
  simplest and fastest UX for the common case.
- **Icon/theme handling:** the button uses `currentColor` for its SVG icon and
  X's neutral gray icon tone, matching both light and dark themes automatically
  without needing separate theme detection logic.

## Known open technical challenge: HLS-only video

Some video/GIF tweets only expose `application/x-mpegURL` (`.m3u8`) variants in
X's API responses, with no direct MP4 rendition. This extension **intentionally
does not attempt to fetch and reconstruct an MP4 from HLS `.ts` segments** —
that requires downloading and concatenating multiple segment files (and
potentially remuxing them), which is a non-trivial feature on its own. When this
happens, `content.js` logs a clear `[X Media DL]` console error identifying the
tweet and flags it as HLS-only rather than silently failing or guessing.

Contributions/implementation of HLS-to-MP4 reconstruction (e.g. via
`fetch`-ing the `.m3u8` playlist, downloading each `.ts` segment, and
concatenating them into a downloadable Blob) are the main follow-up item.

## Permissions

- `downloads`, `storage` — to save files and persist the on/off + folder setting.
- `host_permissions` for `twitter.com`, `x.com`, `twimg.com` — required to read
  page content/API responses and to download media hosted on `twimg.com`.

## Debugging

All errors are logged to the DevTools console with the `[X Media DL]` prefix,
from both the content script (page console) and the service worker (inspect via
`chrome://extensions` → the extension's "service worker" link).
