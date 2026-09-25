/*
 * Wallpaper.
 *
 * A picture is drawn as a CSS background; a video is a real <video> element behind everything and
 * loops muted. Video is handled in the page rather than the host because the browser already has a
 * hardware accelerated decoder, and driving one from C# would mean shipping a media stack for no
 * gain.
 */

import { call } from './bridge.js';
import { state, saveSettings } from './state.js';

let layer = null;

/** Creates the two layers the wallpaper uses: one for pictures, one for video. */
export function mount() {
  if (layer) return layer;

  layer = document.createElement('div');
  layer.className = 'wallpaper';
  layer.innerHTML = `
    <div class="wallpaper-image"></div>
    <video class="wallpaper-video" muted loop playsinline preload="auto"></video>`;

  document.body.prepend(layer);
  return layer;
}

/** Applies whatever the settings say the wallpaper is. */
export async function apply() {
  const root = mount();
  const image = root.querySelector('.wallpaper-image');
  const video = root.querySelector('.wallpaper-video');

  const path = state.settings.wallpaper?.path;
  const kind = state.settings.wallpaper?.kind;

  if (!path || !kind) {
    image.style.backgroundImage = '';
    video.pause();
    video.removeAttribute('src');
    root.dataset.kind = 'none';
    return;
  }

  // The host hands back a URL it is willing to serve. Building a file:// path here would be
  // refused, because the page itself is loaded over https.
  let url;
  try {
    const resolved = await call('wallpaperUrl', { path });
    if (!resolved.ok) {
      root.dataset.kind = 'none';
      return;
    }
    url = resolved.url;
  } catch {
    root.dataset.kind = 'none';
    return;
  }

  if (kind === 'video') {
    if (video.getAttribute('src') !== url) {
      video.src = url;
    }

    root.dataset.kind = 'video';
    video.play().catch(() => {
      // Autoplay can be refused; the still frame is still better than a black screen.
    });
    return;
  }

  video.pause();
  video.removeAttribute('src');
  root.dataset.kind = 'image';
  image.style.backgroundImage = `url("${url}")`;
}

/**
 * Switches to a file that is already in the wallpaper library.
 *
 * Nothing is copied: the file is where it belongs already. Only the kind has to be worked out,
 * because the page needs to know whether to draw a picture or play a video.
 */
export async function use(path) {
  if (!path) {
    return { ok: false, error: '没有选择文件' };
  }

  const videoExtensions = ['.mp4', '.webm', '.wmv', '.avi', '.mov', '.mkv'];
  const lower = path.toLowerCase();
  const kind = videoExtensions.some((extension) => lower.endsWith(extension))
    ? 'video'
    : 'image';

  state.settings.wallpaper = { path, kind };
  await saveSettings();
  await apply();

  return { ok: true, kind };
}

/**
 * Asks for a file, copies it into the launcher's folder and switches to it.
 * Returns a short message describing what happened.
 */
export async function choose() {
  const picked = await call('pickFile', { kind: 'wallpaper' });

  if (!picked.ok) {
    return null;
  }

  const imported = await call('wallpaperImport', { path: picked.path });

  if (!imported.ok) {
    return { ok: false, error: imported.error };
  }

  state.settings.wallpaper = { path: imported.path, kind: imported.kind };
  await saveSettings();
  await apply();

  return { ok: true, kind: imported.kind };
}

/** Removes the wallpaper and goes back to the plain background. */
export async function clear() {
  await call('wallpaperClear');
  state.settings.wallpaper = null;
  await saveSettings();
  await apply();
}
