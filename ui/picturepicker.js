/*
 * The picture picker.
 *
 * Two ways to give a card a background:
 *
 *   图片  pick or import a picture; it is copied into the launcher's own folder so it cannot
 *         disappear later
 *   纯色  choose a colour on the wheel and use it as a flat background
 *
 * The colour wheel is drawn on a canvas rather than using the browser's colour input, because the
 * native control opens an operating system dialog that a remote or a gamepad cannot drive. Here
 * every part is a DOM element, so the arrow keys and Enter work throughout.
 */

import { call } from './bridge.js';

let resolvePick = null;

/**
 * Shows the picker.
 *
 * @param {string}  library       which picture library to browse
 * @param {string}  title         heading text
 * @param {boolean} allowColour   whether the flat-colour tab is offered. Only a TV card background
 *                                can be a flat colour; an icon has to be a picture.
 *
 * Resolves with { kind: 'picture', path } or { kind: 'colour', colour }, or null when dismissed.
 */
export function pickPicture({ library, title, allowColour = false }) {
  return new Promise((resolve) => {
    resolvePick = resolve;

    const overlay = document.createElement('div');
    overlay.className = 'picker';
    overlay.id = 'picture-picker';

    overlay.innerHTML = `
      <div class="picker-box">
        <header class="picker-head">
          <h2></h2>
          <button type="button" class="picker-close" aria-label="关闭">✕</button>
        </header>

        <nav class="picker-tabs" id="picker-tabs" hidden>
          <button type="button" data-tab="pictures" data-active="yes">图片</button>
          <button type="button" data-tab="colour">纯色</button>
        </nav>

        <div class="picker-body">
          <section data-panel="pictures">
            <div class="picker-grid" id="picker-grid"></div>
            <p class="picker-empty" id="picker-empty" hidden>
              这个库还是空的。<br>点下面的「从文件导入」，或直接打开文件夹把图片放进去。
            </p>
          </section>

          <section data-panel="colour" hidden>
            <div class="colour-layout">
              <canvas id="colour-wheel" width="300" height="300"></canvas>

              <div class="colour-side">
                <div class="colour-preview" id="colour-preview"></div>

                <label class="colour-readout">
                  <span>色值</span>
                  <input type="text" id="colour-hex" spellcheck="false" maxlength="7">
                </label>

                <!-- Sliders as well as the square: the wheel's square is small, and a slider is
                     far easier to land on with a mouse or a remote. -->
                <label class="colour-slider">
                  <span>明暗</span>
                  <input type="range" id="colour-value" min="0" max="100" step="1">
                  <output id="colour-value-out"></output>
                </label>

                <label class="colour-slider">
                  <span>浓淡</span>
                  <input type="range" id="colour-saturation" min="0" max="100" step="1">
                  <output id="colour-saturation-out"></output>
                </label>

                <div class="colour-swatches" id="colour-swatches"></div>
              </div>
            </div>
          </section>
        </div>

        <footer class="picker-foot">
          <button type="button" id="picker-import">从文件导入…</button>
          <button type="button" id="picker-open" class="ghost">打开文件夹</button>
          <button type="button" id="picker-apply" hidden>使用这个颜色</button>
        </footer>
      </div>`;

    overlay.querySelector('h2').textContent = title;

    const grid = overlay.querySelector('#picker-grid');
    const empty = overlay.querySelector('#picker-empty');
    const tabs = overlay.querySelector('#picker-tabs');
    const applyButton = overlay.querySelector('#picker-apply');
    const importButton = overlay.querySelector('#picker-import');
    const openButton = overlay.querySelector('#picker-open');

    // --- pictures ---

    async function reload() {
      grid.replaceChildren();

      let result;
      try {
        result = await call('libraryList', { library });
      } catch {
        return;
      }

      const files = result.files ?? [];
      empty.hidden = files.length > 0;

      for (const file of files) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'picker-item';
        item.title = file.fileName;

        const url = await assetUrl(file.path);
        const isVideo = file.kind === 'video';

        // A video is shown as a paused first frame rather than an icon: seeing the actual content is
        // what lets the user tell one clip from another.
        const thumb = document.createElement(isVideo ? 'video' : 'img');

        if (isVideo) {
          thumb.src = url;
          thumb.muted = true;
          thumb.preload = 'metadata';
        } else {
          thumb.src = url;
        }

        thumb.alt = '';

        const label = document.createElement('span');
        label.textContent = file.name;

        item.append(thumb, label);

        // A video cannot be shown as a thumbnail, so it carries a badge instead. Without one a
        // wallpaper video would look like a picture that failed to load.
        if (file.kind === 'video') {
          item.dataset.kind = 'video';

          const badge = document.createElement('span');
          badge.className = 'picker-badge';
          badge.textContent = '视频';
          item.append(badge);
        }

        item.addEventListener('click', () => finish({ kind: 'picture', path: file.path }));

        grid.append(item);
      }
    }

    // --- colour ---

    const wheel = overlay.querySelector('#colour-wheel');
    const preview = overlay.querySelector('#colour-preview');
    const hexInput = overlay.querySelector('#colour-hex');
    const swatches = overlay.querySelector('#colour-swatches');
    const valueSlider = overlay.querySelector('#colour-value');
    const valueOut = overlay.querySelector('#colour-value-out');
    const satSlider = overlay.querySelector('#colour-saturation');
    const satOut = overlay.querySelector('#colour-saturation-out');

    const colour = createColourPicker(wheel, {
      onChange: (hex, hsv) => {
        preview.style.background = hex;
        hexInput.value = hex;

        // The sliders follow the wheel so the two never disagree about the current colour.
        valueSlider.value = Math.round(hsv.value * 100);
        valueOut.textContent = `${Math.round(hsv.value * 100)}%`;
        satSlider.value = Math.round(hsv.saturation * 100);
        satOut.textContent = `${Math.round(hsv.saturation * 100)}%`;
      }
    });

    valueSlider.addEventListener('input', () => colour.setValue(valueSlider.value / 100));
    satSlider.addEventListener('input', () => colour.setSaturation(satSlider.value / 100));

    // A few common choices, so a plain colour is one click away rather than a wheel hunt.
    for (const hex of ['#4c8dff', '#e5484d', '#f5a524', '#30a46c', '#8e4ec6', '#1f2430', '#ffffff']) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'colour-swatch';
      swatch.style.background = hex;
      swatch.title = hex;
      swatch.addEventListener('click', () => colour.set(hex));
      swatches.append(swatch);
    }

    hexInput.addEventListener('change', () => {
      if (/^#[0-9a-f]{6}$/i.test(hexInput.value.trim())) {
        colour.set(hexInput.value.trim());
      } else {
        // Put the valid value back rather than leaving a half typed one on screen.
        hexInput.value = colour.get();
      }
    });

    if (allowColour) {
      tabs.hidden = false;

      tabs.addEventListener('click', (e) => {
        const button = e.target.closest('button[data-tab]');
        if (!button) return;

        const tab = button.dataset.tab;

        tabs.querySelectorAll('button').forEach((b) => {
          b.dataset.active = b.dataset.tab === tab ? 'yes' : 'no';
        });

        overlay.querySelectorAll('[data-panel]').forEach((panel) => {
          panel.hidden = panel.dataset.panel !== tab;
        });

        // The footer follows the tab: importing and opening a folder only make sense for pictures.
        const pictures = tab === 'pictures';
        importButton.hidden = !pictures;
        openButton.hidden = !pictures;
        applyButton.hidden = pictures;
      });
    }

    applyButton.addEventListener('click', () => {
      // A hex string is stored as a picture would be, so the page has one shape to handle.
      finish({ kind: 'colour', colour: colour.get() });
    });

    overlay.querySelector('.picker-close').addEventListener('click', () => finish(null));

    importButton.addEventListener('click', async () => {
      const picked = await call('pickFile', { kind: 'image' });
      if (!picked.ok) return;

      const added = await call('libraryAdd', { library, path: picked.path });

      if (added.ok) {
        // Importing then picks it: the user obviously means to use the picture they just chose,
        // and making them find it in the grid afterwards would be busywork.
        finish({ kind: 'picture', path: added.file.path });
      }
    });

    openButton.addEventListener('click', () => call('libraryFolder', { library }));

    // A click on the backdrop dismisses, but a click inside the box must not.
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) {
        finish(null);
      }
    });

    document.body.append(overlay);
    colour.set('#4c8dff');
    reload();

    function finish(value) {
      const done = resolvePick;
      resolvePick = null;
      overlay.remove();
      done?.(value);
    }
  });
}

/** True when the picker is on screen, so the keyboard can leave it alone. */
export function isPickerOpen() {
  return document.getElementById('picture-picker') !== null;
}

/** Asks the host for a loadable URL for a file in one of its folders. */
async function assetUrl(path) {
  try {
    const result = await call('assetUrl', { path });
    return result.ok ? result.url : '';
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ colour wheel */

/**
 * A hue ring with a saturation and brightness square inside it.
 *
 * Drawn once per frame into an ImageData buffer, which is fast enough to be regenerated whenever
 * the hue changes and avoids depending on canvas gradient quirks at the seam of the ring.
 */
function createColourPicker(canvas, { onChange }) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const size = canvas.width;
  const centre = size / 2;
  const outer = centre - 4;
  const inner = outer * 0.70;

  // The largest square that fits inside the inner circle, inset a little so its corners stay clear
  // of the hue ring. A square inscribed in a circle touches it at the corners, so the factor is
  // just under the exact value of 1/sqrt(2) for the half-diagonal.
  const square = inner * Math.SQRT2 * 0.92;
  const squareLeft = centre - square / 2;

  let hue = 210;
  let saturation = 0.7;
  let value = 1;

  function drawWheel() {
    const image = ctx.createImageData(size, size);
    const data = image.data;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - centre + 0.5;
        const dy = y - centre + 0.5;
        const distance = Math.sqrt((dx * dx) + (dy * dy));
        const index = ((y * size) + x) * 4;

        if (distance > outer || distance < inner) {
          data[index + 3] = 0;
          continue;
        }

        // The angle around the ring is the hue.
        let angle = Math.atan2(dy, dx) * (180 / Math.PI);
        if (angle < 0) angle += 360;

        const [r, g, b] = hsvToRgb(angle, 1, 1);
        data[index] = r;
        data[index + 1] = g;
        data[index + 2] = b;
        data[index + 3] = 255;
      }
    }

    ctx.putImageData(image, 0, 0);

    // The saturation and brightness square for the current hue.
    const [hr, hg, hb] = hsvToRgb(hue, 1, 1);
    const gradientX = ctx.createLinearGradient(squareLeft, 0, squareLeft + square, 0);
    gradientX.addColorStop(0, '#ffffff');
    gradientX.addColorStop(1, `rgb(${hr},${hg},${hb})`);

    ctx.fillStyle = gradientX;
    ctx.fillRect(squareLeft, squareLeft, square, square);

    const gradientY = ctx.createLinearGradient(0, squareLeft, 0, squareLeft + square);
    gradientY.addColorStop(0, 'rgba(0,0,0,0)');
    gradientY.addColorStop(1, '#000000');

    ctx.fillStyle = gradientY;
    ctx.fillRect(squareLeft, squareLeft, square, square);

    // Markers for the ring and the square.
    const angle = hue * (Math.PI / 180);
    const ringRadius = (outer + inner) / 2;

    ctx.beginPath();
    ctx.arc(centre + (Math.cos(angle) * ringRadius), centre + (Math.sin(angle) * ringRadius), 9, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = '#00000059';
    ctx.lineWidth = 1;
    ctx.stroke();

    const sx = squareLeft + (saturation * square);
    const sy = squareLeft + ((1 - value) * square);

    ctx.beginPath();
    ctx.arc(sx, sy, 8, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = '#00000059';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function emit() {
    const [r, g, b] = hsvToRgb(hue, saturation, value);
    onChange(rgbToHex(r, g, b), { hue, saturation, value });
  }

  /** Works out what the pointer is over and updates the matching part of the picker. */
  function handlePointer(event) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (size / rect.width);
    const y = (event.clientY - rect.top) * (size / rect.height);

    const dx = x - centre;
    const dy = y - centre;
    const distance = Math.sqrt((dx * dx) + (dy * dy));

    // Inside the square picks saturation and brightness; outside it picks the hue.
    const inSquare = x >= squareLeft && x <= squareLeft + square &&
                     y >= squareLeft && y <= squareLeft + square;

    if (inSquare) {
      saturation = clamp((x - squareLeft) / square, 0, 1);
      value = clamp(1 - ((y - squareLeft) / square), 0, 1);
    } else {
      let angle = Math.atan2(dy, dx) * (180 / Math.PI);
      if (angle < 0) angle += 360;
      hue = angle;
    }

    drawWheel();
    emit();
  }

  let dragging = false;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    handlePointer(e);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (dragging) handlePointer(e);
  });

  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  });

  drawWheel();
  emit();

  return {
    get: () => {
      const [r, g, b] = hsvToRgb(hue, saturation, value);
      return rgbToHex(r, g, b);
    },
    set: (hex) => {
      const parsed = hexToHsv(hex);
      if (!parsed) return;

      [hue, saturation, value] = parsed;
      drawWheel();
      emit();
    },
    setValue: (next) => {
      value = clamp(next, 0, 1);
      drawWheel();
      emit();
    },
    setSaturation: (next) => {
      saturation = clamp(next, 0, 1);
      drawWheel();
      emit();
    }
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs((((h / 60) % 2) - 1)));
  const m = v - c;

  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }

  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255)
  ];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function hexToHsv(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;

  const value = parseInt(match[1], 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * (((b - r) / delta) + 2);
    else h = 60 * (((r - g) / delta) + 4);
  }

  if (h < 0) h += 360;

  return [h, max === 0 ? 0 : delta / max, max];
}
