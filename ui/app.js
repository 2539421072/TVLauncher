/*
 * Application shell.
 *
 * Owns the clock, the mode switch, the settings panel and the keyboard. The two modes are modules
 * that render themselves into the stage; the shell does not know how either one lays out.
 */

import { call, hasHost, on } from './bridge.js';
import { state, loadSettings, loadApps, loadCardArt, setCardArt, setCardColour } from './state.js';
import * as tablet from './tablet.js';
import * as tv from './tv.js';
import * as focus from './focus.js';
import * as wallpaper from './wallpaper.js';
import * as menu from './contextmenu.js';
import { pickPicture, isPickerOpen } from './picturepicker.js';
import { createPanel, togglePanel, isPanelOpen, } from './settings.js';

const $ = (id) => document.getElementById(id);

let panel = null;

/* ------------------------------------------------------------------ chrome */

/**
 * Writes the clock's size and position as CSS variables.
 *
 * The horizontal setting is a share of the window width and is converted to a pixel offset here.
 * It has to be pixels: a percentage inside `translate` resolves against the element's own width,
 * which made the slider move the clock by a fraction of a clock width and look broken.
 *
 * The offset is measured from where the layout actually places the clock rather than from the
 * window centre, because the bar's middle column is inset by the bar's padding. Measuring removes
 * the need to keep two magic numbers in step.
 */
function applyClockSettings() {
  const clock = state.settings.clock;
  const box = $('clock-box');

  document.documentElement.style.setProperty('--clock-size', `${clock.size}px`);
  document.documentElement.style.setProperty('--clock-offset-y', `${clock.y - 52}px`);

  // Temporarily clear the horizontal offset so the element's natural resting place can be read.
  document.documentElement.style.setProperty('--clock-x', '0px');

  let restCentre = window.innerWidth / 2;

  if (box) {
    const rect = box.getBoundingClientRect();
    if (rect.width > 0) {
      restCentre = rect.left + (rect.width / 2);
    }
  }

  // Where the user wants the clock's centre, as a share of the window width.
  const desiredCentre = window.innerWidth * (clock.x / 100);
  const shift = desiredCentre - restCentre;

  document.documentElement.style.setProperty('--clock-x', `${Math.round(shift)}px`);

  const date = $('date');
  if (date) {
    date.hidden = !clock.showDate;
  }
}

function tickClock() {
  const now = new Date();

  $('clock').textContent = now.toLocaleTimeString('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  $('date').textContent = now.toLocaleDateString('zh-CN', {
    month: 'long', day: 'numeric', weekday: 'long'
  });
}

function setBridgeState(text, ok) {
  const el = $('bridge-state');
  el.textContent = text;
  el.dataset.ok = ok ? 'yes' : 'no';
}

function syncModeButtons() {
  document.querySelectorAll('#mode-switch button').forEach((button) => {
    button.dataset.active = button.dataset.mode === state.settings.mode ? 'yes' : 'no';
  });

  document.body.dataset.mode = state.settings.mode;
}

/* ------------------------------------------------------------------ render */

const stage = () => $('stage');

export function render() {
  const root = stage();

  // The stage carries the mode so the stylesheets can target one mode without the other's rules
  // applying. Only the active mode's markup exists, so nothing is rendered off screen.
  root.dataset.mode = state.settings.mode;
  root.className = 'stage ' + (state.settings.mode === 'tv' ? 'tv-stage' : 'tablet-stage');

  if (state.apps.length === 0) {
    root.replaceChildren();
    showHint(state.ready
      ? `应用文件夹是空的：<br><code>${escapeHtml(state.folder)}</code><br><br>把快捷方式放进去，然后按 F5 重新扫描。`
      : '正在扫描应用…');
    return;
  }

  hideHint();

  if (state.settings.mode === 'tv') {
    tv.render(root);
  } else {
    tablet.render(root);
  }
}

function showHint(html) {
  const hint = $('hint');
  hint.innerHTML = html;
  hint.hidden = false;
}

function hideHint() {
  $('hint').hidden = true;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ------------------------------------------------------------------ actions */

function setMode(mode) {
  if (state.settings.mode === mode) return;

  const previous = state.settings.mode;

  // Entering the grid always starts at the first page. This has to happen after the render, not
  // before: rendering rebuilds the pages and deliberately keeps the page the user was on, so a
  // reset beforehand is immediately overwritten.
  state.settings.mode = mode;

  // A mode switch changes what the content is, so the focus returns to it rather than staying on a
  // bar button that may no longer make sense.
  focus.focusContent();
  tablet.resetCursor();

  syncModeButtons();
  render();

  if (mode === 'tablet' && previous !== 'tablet') {
    tablet.resetPage();
  }

  panel?.refresh();
  updateFocusVisuals();
  call('saveConfig', { config: state.settings });
}

async function rescan() {
  showHint('正在重新扫描应用…');
  await loadApps();
  render();
}

/* ------------------------------------------------------------------ card artwork */

/**
 * Builds the right-click menu for a card or tile.
 *
 * The two modes differ on purpose. A TV card separates the picture behind the icon from the icon
 * itself, so it offers both. A grid tile has a single picture that replaces the icon and its plate,
 * so it offers only that.
 */
function openCardMenu(app, element, x, y) {
  const items = [
    {
      label: '更改图标',
      onSelect: () => changeArt(app, 'icon')
    }
  ];

  if (state.settings.mode === 'tv') {
    items.push({
      label: '更换背景',
      onSelect: () => changeArt(app, 'background')
    });
  }

  items.push(
    { separator: true },
    {
      label: '打开所在文件夹',
      onSelect: () => call('openFolder', { path: state.folder, create: false })
    },
    {
      // Enabled when either picture has been customised, since clearing puts back both the stock
      // icon and the plain card.
      label: '恢复默认图标',
      disabled: !state.cardArt[app.id] && !state.cardIcons[app.id],
      onSelect: () => clearArt(app)
    }
  );

  menu.showMenu(x, y, items);
}

/**
 * Lets the user choose a background or an icon for a card.
 *
 * A background can be a picture or a flat colour; an icon has to be a picture, so the colour tab is
 * only offered for a background.
 *
 * @param {string} kind  'icon' for the card's icon, 'background' for the picture behind it.
 */
async function changeArt(app, kind) {
  const isIcon = kind === 'icon';

  const picked = await pickPicture({
    library: 'icons',
    title: isIcon ? '选择图标图片' : '选择卡片背景',
    allowColour: !isIcon
  });

  if (!picked) {
    return;
  }

  if (picked.kind === 'colour') {
    const result = await call('setCardArt', {
      appId: app.id, colour: picked.colour, kind: 'background'
    });

    if (result.ok) {
      setCardColour(app.id, result.colour);
      applyArt();
    }

    return;
  }

  const result = await call('setCardArt', { appId: app.id, path: picked.path, kind });

  if (!result.ok) {
    return;
  }

  setCardArt(app.id, kind, result.url);
  applyArt();
}

/** Puts a card back to the stock icon and the plain background. */
async function clearArt(app) {
  await call('setCardArt', { appId: app.id, path: null, kind: 'icon' });
  await call('setCardArt', { appId: app.id, path: null, kind: 'background' });

  setCardArt(app.id, 'icon', null);
  setCardArt(app.id, 'background', null);
  setCardColour(app.id, null);
  applyArt();
}

/** Re-draws artwork everywhere it appears. */
function applyArt() {
  tv.refreshCardArt();
  tablet.refreshTileArt();
}

/* ------------------------------------------------------------------ mode swipe */

/**
 * Drives the mode switch as the user drags the stage sideways.
 *
 * The stage follows the pointer during the drag, then either completes or springs back. Because the
 * position is written every frame rather than animated on release, the movement stays under the
 * cursor instead of lagging behind it.
 *
 * @param {string} phase  'drag', 'commit' or 'cancel'
 * @param {number} amount drag distance as a share of the window width; negative is leftward
 * @param {string} target the mode the completed gesture switches to
 */
function handleModeSwipe(phase, amount, target) {
  const el = stage();
  if (!el) return;

  if (phase === 'drag') {
    el.dataset.swiping = 'yes';

    // Fade a little as it goes, so the move reads as leaving one screen for another.
    const progress = Math.min(1, Math.abs(amount) / 0.6);
    el.style.transform = `translateX(${amount * 100}%)`;
    el.style.opacity = String(1 - (progress * 0.35));
    return;
  }

  if (phase === 'commit') {
    // Let the transition carry it the rest of the way, then swap the mode at the end so the user
    // never sees the old content sitting in the new position.
    const direction = target === 'tv' ? 1 : -1;

    el.dataset.swiping = 'settle';
    el.style.transform = `translateX(${direction * 100}%)`;
    el.style.opacity = '0';

    setTimeout(() => {
      el.style.transform = '';
      el.style.opacity = '';
      delete el.dataset.swiping;

      setMode(target);
    }, 300);

    return;
  }

  // Cancelled: spring back to where it started.
  el.dataset.swiping = 'settle';
  el.style.transform = '';
  el.style.opacity = '';

  setTimeout(() => delete el.dataset.swiping, 340);
}

/** Applies the window-level settings that live on the host side. */
function applyWindowSettings() {
  call('wallFullScreen', { enabled: state.settings.fullScreen !== false });
}

/* ------------------------------------------------------------------ keyboard */

/** The mode module for whichever mode is on screen. Both expose the same content interface. */
function contentMode() {
  return state.settings.mode === 'tv' ? tv : tablet;
}

function handleKey(key) {
  // A dialog owns the keyboard completely while it is open.
  if (isConfirmOpen()) {
    if (key === 'Escape') closeConfirm();
    return;
  }

  // The picture picker and the context menu both take Escape to dismiss.
  if (isPickerOpen() || menu.isMenuOpen()) {
    if (key === 'Escape') {
      menu.hideMenu();
    }
    return;
  }

  // The settings panel owns Escape while it is open.
  if (isPanelOpen()) {
    if (key === 'Escape') {
      togglePanel(false);
    }
    return;
  }

  // Global keys work wherever the focus is.
  switch (key) {
    case 'F5':
      rescan();
      return;
    case 'F1':
      panel?.open();
      return;
  }

  // The top bar has the focus: it handles its own movement and activation.
  if (focus.inBar()) {
    if (!focus.handleBarKey(key)) {
      focus.focusContent();
    }
    return;
  }

  const mode = contentMode();

  switch (key) {
    case 'Escape':
      // Escape is the way out of the launcher, and it asks first.
      openConfirm();
      return;

    case 'ArrowUp':
      // From the top of the content, up moves into the top bar.
      if (mode.cursorOnTopRow()) {
        focus.focusBar();
        updateFocusVisuals();
        return;
      }

      mode.moveCursor(0, -1);
      return;

    case 'ArrowDown':
      mode.moveCursor(0, 1);
      return;

    case 'ArrowLeft':
      mode.moveCursor(-1, 0);
      return;

    case 'ArrowRight':
      mode.moveCursor(1, 0);
      return;

    case 'PageUp':
      state.settings.mode === 'tv' ? tv.move(-3) : tablet.previousPage();
      return;

    case 'PageDown':
      state.settings.mode === 'tv' ? tv.move(3) : tablet.nextPage();
      return;

    case 'Enter':
    case 'Space':
      mode.activateCursor();
      return;
  }
}

/** Keeps the content's own focus highlight in step with where the focus is. */
function updateFocusVisuals() {
  contentMode().setContentFocus(!focus.inBar());
}

/* ------------------------------------------------------------------ exit confirmation */

/**
 * Exiting hands the desktop back to Windows. That is not something to do by accident with a remote
 * in your hand, so it always asks first.
 */
function openConfirm() {
  const dialog = $('exit-confirm');
  if (!dialog) return;

  $('exit-no').focus();
  dialog.hidden = false;
}

function closeConfirm() {
  const dialog = $('exit-confirm');
  if (dialog) {
    dialog.hidden = true;
  }
}

function isConfirmOpen() {
  return !$('exit-confirm')?.hidden;
}

/* ------------------------------------------------------------------ start */

async function start() {
  const trace = [];
  const mark = (label) => trace.push(`${new Date().toISOString().slice(11, 23)} ${label}`);

  // The trace is written continuously, so if start() hangs the last line identifies where.
  const flush = () => call('log', { text: trace.join('\n') }).catch(() => {});

  mark('start');

  tickClock();
  setInterval(tickClock, 10000);
  mark('clock');

  await loadSettings();
  mark(`settings loaded: ${JSON.stringify(state.settings.tv)}`);

  applyClockSettings();
  applyWindowSettings();
  mark('clock applied');
  flush();

  wallpaper.mount();
  mark('wallpaper mounted');
  flush();

  await wallpaper.apply();
  mark('wallpaper applied');
  flush();

  try {
    panel = createPanel(document.body, {
      onLayoutChange: applyCurrentMode,

    onWallpaper: async (action) => {
      if (action === 'clear') {
        await wallpaper.clear();
        return { ok: true };
      }

      // Choosing opens the picker over the library, so the user sees what they actually have rather
      // than being dropped into a file dialog every time.
      if (action === 'pick') {
        const picked = await pickPicture({
          library: 'wallpapers',
          title: '选择壁纸'
        });

        if (!picked) {
          return { ok: false, cancelled: true };
        }

        return wallpaper.use(picked.path);
      }

      return wallpaper.choose();
    },

    onApps: async (action) => {
      if (action === 'openFolder') {
        return call('openFolder', { path: state.folder, create: true });
      }
      // Import: ask for a file, copy it into the apps folder, then rescan so the new app appears
      // without the user having to know a rescan is needed.
      const picked = await call('pickFile', { kind: 'shortcut' });

      if (!picked.ok) {
        return { cancelled: true };
      }

      const imported = await call('import', { path: picked.path });

      if (!imported.ok) {
        return imported;
      }

      await loadApps();
      render();
      setBridgeState(`已连接 · ${state.apps.length} 个应用`, true);

      return imported;
    },

    onLibrary: async (action, library) => {
      if (action === 'open') {
        return call('libraryFolder', { library });
      }

      // Import: pick one or more files and copy them into the library. Several at once is worth
      // supporting because a wallpaper collection is usually built a handful at a time.
      const kind = library === 'wallpapers' ? 'wallpaper' : 'image';
      const picked = await call('pickFiles', { kind });

      if (!picked.ok) {
        return { cancelled: true };
      }

      return call('libraryAddMany', { library, paths: picked.paths });
    },

    onBackup: async (action, path) => {
      switch (action) {
        case 'create':
          return call('backupCreate', {});
        case 'list':
          return call('backupList');
        case 'restore': {
          const result = await call('backupRestore', { path });

          // The restored files are what the next launch reads, so the running window keeps its
          // current state until it is reopened. Saying so avoids a confusing half applied look.
          if (result.ok) {
            await loadCardArt();
            applyArt();
          }

          return result;
        }
        case 'open':
          return call('backupFolder');
        default:
          return { ok: false, error: 'unknown action' };
      }
    },

    // Starting with Windows is stored in the registry, not in the settings file, because the
    // registry is what Windows actually acts on.
    onStartup: async (action, value) => {
      if (action === 'status') {
        return call('autoStartStatus');
      }

      return call('autoStartSet', { enabled: Boolean(value) });
    }
  });
    mark('panel created');
    flush();
  } catch (err) {
    mark(`PANEL FAILED: ${err && err.stack ? err.stack : err}`);
    flush();
    throw err;
  }

  $('btn-settings').addEventListener('click', () => panel.open());

  $('btn-exit').addEventListener('click', () => openConfirm());
  $('exit-no').addEventListener('click', () => closeConfirm());
  $('exit-yes').addEventListener('click', () => call('quit'));

  // The focus module drives the content's highlight, so it is told how to reach the current mode.
  focus.configure({
    onFocus: () => updateFocusVisuals(),
    onBlur: () => updateFocusVisuals()
  });

  // Both modes hand their right-clicks to the same menu builder.
  tv.setContextMenuHandler(openCardMenu);
  tablet.setContextMenuHandler(openCardMenu);
  menu.attachMenuDismissal();

  document.querySelectorAll('#mode-switch button').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });

  syncModeButtons();

  if (!hasHost()) {
    setBridgeState('不在宿主中运行', false);
  } else {
    setBridgeState('已连接', true);

    // The host forwards keys it saw before the page did, which is how the remote and a gamepad
    // reach the same handler as the keyboard.
    on('key', (message) => handleKey(message.key));
  }

  window.addEventListener('keydown', (e) => {
    // The host already forwarded this one.
    if (e.key === 'F5') e.preventDefault();
    handleKey(normaliseKey(e.key));
  });

  try {
    await loadApps();
    await loadCardArt();
    setBridgeState(`已连接 · ${state.apps.length} 个应用`, true);
    mark(`apps loaded: ${state.apps.length}`);
  } catch (err) {
    setBridgeState('宿主无响应', false);
    mark(`loadApps failed: ${err.message}`);
  }

  flush();

  // Input is bound once, to the stage's parent, so it survives every re-render and a mode switch
  // cannot stack duplicate handlers.
  tablet.attachInput(stage());
  tv.attachInput(stage());
  tv.attachSwipe(stage(), {
    isEnabled: () => state.settings.mode === 'tv',
    onSwitch: (phase, amount) => handleModeSwipe(phase, amount, 'tablet')
  });

  // Dragging the grid sideways turns pages, and dragging right off the first page returns to the
  // TV mode.
  tablet.attachDrag(stage(), {
    isEnabled: () => state.settings.mode === 'tablet',
    onFirstPage: () => tablet.currentPage().page === 0,
    onLeaveToTv: (phase, amount) => handleModeSwipe(phase, amount, 'tv')
  });
  mark('input attached');

  render();
  updateFocusVisuals();
  mark(`rendered: ${document.querySelectorAll('.tv-card, .app-tile').length} tiles`);
  flush();
}

/** Maps DOM key names onto the names the host sends. */
function normaliseKey(key) {
  switch (key) {
    case 'ArrowLeft': return 'ArrowLeft';
    case 'ArrowRight': return 'ArrowRight';
    case 'ArrowUp': return 'ArrowUp';
    case 'ArrowDown': return 'ArrowDown';
    default: return key;
  }
}

/*
 * Settings probe.
 *
 * Drives the settings through the same path the sliders use and writes the measured result to a
 * file via the host. Input injection from outside the window is unreliable, and an on-screen report
 * is covered by the launcher's own content, so the findings go to a file that can be read directly.
 */
async function selfTest() {
  const log = [];

  const measureTablet = () => {
    const plate = document.querySelector('.app-plate');
    const grid = document.querySelector('.tablet-grid');
    return {
      cardSizeVar: getComputedStyle(stage()).getPropertyValue('--card-size').trim(),
      platePx: plate ? Math.round(plate.getBoundingClientRect().width) : 0,
      tiles: document.querySelectorAll('.app-tile').length,
      cols: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0
    };
  };

  const measureTv = () => {
    const focused = document.querySelector('.tv-card.is-focused');
    const row = document.querySelector('.tv-row');
    if (!focused) return { focused: null };

    const r = focused.getBoundingClientRect();
    return {
      focused: `${Math.round(r.width)}x${Math.round(r.height)}`,
      centreY: Math.round(r.top + r.height / 2),
      groupY: row ? getComputedStyle(row).getPropertyValue('--group-y').trim() : '-'
    };
  };

  const applyTablet = () => {
    tablet.applySettings(stage());
    tablet.refresh();
  };

  // --- tablet ---
  state.settings.mode = 'tablet';
  syncModeButtons();
  render();
  log.push(`tablet start   : ${JSON.stringify(measureTablet())}`);

  state.settings.tablet.cardSize = 170;
  applyTablet();
  log.push(`cardSize=170   : ${JSON.stringify(measureTablet())}`);

  state.settings.tablet.columns = 4;
  applyTablet();
  log.push(`columns=4      : ${JSON.stringify(measureTablet())}`);

  state.settings.tablet.cardSize = 128;
  state.settings.tablet.columns = 6;
  applyTablet();

  // --- tv ---
  state.settings.mode = 'tv';
  syncModeButtons();
  render();
  log.push(`tv start       : ${JSON.stringify(measureTv())}`);

  const beforeWidth = measureTv().focused;
  state.settings.tv.cardWidth = 420;
  tv.applySettings({ ...state.settings.tv, cardWidth: 620 });
  log.push(`cardWidth 620->420 : ${beforeWidth} -> ${measureTv().focused}`);

  state.settings.tv.cardWidth = 620;
  tv.applySettings({ ...state.settings.tv, cardWidth: 420 });
  state.settings.tv.groupY = 30;
  tv.applySettings(null);
  log.push(`groupY=30      : ${JSON.stringify(measureTv())}`);

  state.settings.tv.groupY = 70;
  tv.applySettings(null);
  log.push(`groupY=70      : ${JSON.stringify(measureTv())}`);

  state.settings.tv.groupY = 46;
  tv.applySettings(null);

  call('log', { text: log.join('\n') });
}

/**
 * Reproduces the reported loss: give two apps artwork, then import a third and see whether the
 * first two keep theirs.
 */
function importTest() {
  (async () => {
    try {
      await new Promise((r) => setTimeout(r, 1000));
      const lines = [];
      const log = (text) => {
        lines.push(text);
        // Written on every step, so a failure part way through still leaves a record of how far it
        // got.
        call('log', { text: lines.join('\n') });
      };
    const snapshot = (label) => {
      const cards = [...document.querySelectorAll('.tv-card')];
      const withArt = cards.filter((c) => c.dataset.hasArt === 'yes').length;
      const withIcon = cards.filter((c) => c.dataset.hasIcon === 'yes').length;

      lines.push(
        `${label}\n` +
        `   state: art=${Object.keys(state.cardArt).length} ` +
        `icons=${Object.keys(state.cardIcons).length} ` +
        `colours=${Object.keys(state.cardColours).length}\n` +
        `   dom  : cards=${cards.length} withArt=${withArt} withIcon=${withIcon}`);
    };

    snapshot('before');

    // Give the first two apps a background colour and a picture icon.
    const listed = await call('libraryList', { library: 'icons' });
    const files = listed.files ?? [];

    for (const app of state.apps.slice(0, 2)) {
      if (files.length > 0) {
        const icon = await call('setCardArt', {
          appId: app.id, path: files[0].path, kind: 'icon'
        });
        setCardArt(app.id, 'icon', icon.url);
      }

      const bg = await call('setCardArt', {
        appId: app.id, colour: '#8e4ec6', kind: 'background'
      });
      setCardColour(app.id, bg.colour);
    }

    applyArt();
    await new Promise((r) => setTimeout(r, 300));
    snapshot('after setting art on 2 apps');

    // Now simulate an import: copy a file in and rescan, exactly as the settings button does.
    const target = state.apps[0].path;
    const imported = await call('import', { path: target, name: 'ZZ测试导入' });

    lines.push(`import         : ok=${imported.ok} name=${imported.name ?? '-'} err=${imported.error ?? '-'}`);

    await loadApps();
    render();
    await new Promise((r) => setTimeout(r, 400));

    snapshot('after import + rescan + render');

    // Which apps lost their art?
    const lost = state.apps
      .filter((a) => state.cardArt[a.id] || state.cardIcons[a.id] || state.cardColours[a.id])
      .map((a) => `${a.name}: art=${state.cardArt[a.id] ? 'y' : '-'} icon=${state.cardIcons[a.id] ? 'y' : '-'} colour=${state.cardColours[a.id] ?? '-'}`);

    lines.push('');
    lines.push(`apps that still have art in state: ${lost.length}`);
    lines.push(...lost.slice(0, 6));

    call('log', { text: lines.join('\n') });
    } catch (err) {
      call('log', { text: 'IMPORT TEST FAILED: ' + (err?.stack ?? err) + '\n\n' + lines.join('\n') });
    }
  })();
}

/** Reports what was loaded at startup and whether the cards picked it up. */
function artCheck() {
  (async () => {
    await new Promise((r) => setTimeout(r, 1200));

    const cards = [...document.querySelectorAll('.tv-card')];
    const visible = cards.find((c) => c.dataset.empty === 'no');

    // Set a colour on the centred card through the real code path, then save nothing else: the
    // next launch should show it again.
    if (new URLSearchParams(location.search).has('set')) {
      const listed = await call('libraryList', { library: 'icons' });
      const files = listed.files ?? [];
      const app = state.apps.find((a) => a.id === visible?.dataset.appId);

      if (app && files.length > 0) {
        const result = await call('setCardArt', {
          appId: app.id, path: files[0].path, kind: 'background'
        });

        setCardArt(app.id, 'background', result.url);
        applyArt();

        await new Promise((r) => setTimeout(r, 300));

        call('log', {
          text: `SET ${app.name} (${app.id})\n  path=${files[0].fileName}\n  url=${result.url}`
        });
        return;
      }
    }

    // Ask the host directly, so the raw reply can be compared with what ended up in state.
    const raw = await call('cardArt');

    const lines = [
      `raw keys         : ${Object.keys(raw ?? {}).join(', ')}`,
      `raw.art          : ${Object.keys(raw?.art ?? {}).length}`,
      `raw.icons        : ${Object.keys(raw?.icons ?? {}).length}`,
      `raw.colours      : ${Object.keys(raw?.colours ?? {}).length}`,
      '',
      `colours raw      : ${JSON.stringify(raw?.colours ?? {})}`,
      '',
      `state.cardArt    : ${Object.keys(state.cardArt).length}`,
      `state.cardColours: ${Object.keys(state.cardColours).length}`,
      `state colours    : ${JSON.stringify(state.cardColours)}`,
      '',
      `UU remote id     : ${state.apps.find((a) => a.name.includes('UU'))?.id ?? '?'}`,
      `lookup hit       : ${state.cardColours[state.apps.find((a) => a.name.includes('UU'))?.id] ?? 'MISS'}`,
      ''
    ];

    for (const card of cards.slice(0, 5)) {
      const id = card.dataset.appId;
      const app = state.apps.find((a) => a.id === id);
      const art = card.querySelector('.tv-card-art');
      const cs = art ? getComputedStyle(art) : null;
      const rect = art?.getBoundingClientRect();

      lines.push(
        `${app?.name ?? '?'}\n` +
        `   state : art=${state.cardArt[id] ? 'yes' : '-'} colour=${state.cardColours[id] ?? '-'}\n` +
        `   dom   : hasArt=${card.dataset.hasArt ?? '-'} hasColour=${card.dataset.hasColour ?? '-'}\n` +
        `   style : bgImage=${art?.style.backgroundImage || 'empty'} bgColor=${art?.style.backgroundColor || 'empty'}\n` +
        `   layout: display=${cs?.display} size=${rect ? Math.round(rect.width) + 'x' + Math.round(rect.height) : '-'} ` +
        `z=${cs?.zIndex} opacity=${cs?.opacity} visibility=${cs?.visibility}`);
    }

    call('log', { text: lines.join('\n') });
  })();
}

/** Applies artwork to whatever card is currently centred, so a screenshot shows the effect. */
/** Drives the picker's colour tab and applies the result, so a screenshot shows the effect. */
function artDemo() {
  (async () => {
    try {
      if (state.settings.mode !== 'tv') {
        state.settings.mode = 'tv';
        syncModeButtons();
        render();
      }

      await new Promise((r) => setTimeout(r, 400));

    const centred = document.querySelector('.tv-card.is-focused');
    const app = state.apps.find((a) => a.id === centred?.dataset.appId);

    if (!app) {
      call('log', { text: 'no centred card' });
      return;
    }

    const lines = [`app            : ${app.name}`];

    // --- the picker's colour tab ---
    const pickerPromise = pickPicture({
      library: 'icons', title: '测试', allowColour: true
    });

    await new Promise((r) => setTimeout(r, 500));

    const picker = document.getElementById('picture-picker');
    const tabs = picker ? [...picker.querySelectorAll('.picker-tabs button')] : [];

    lines.push(`tabs           : ${tabs.map((t) => t.textContent).join(' / ')}`);
    lines.push(`wheel canvas   : ${Boolean(picker?.querySelector('#colour-wheel'))}`);
    lines.push(`swatches       : ${picker?.querySelectorAll('.colour-swatch').length ?? 0}`);

    // Select a colour through the same path the wheel uses, then apply it.
    tabs.find((t) => t.dataset.tab === 'colour')?.click();
    await new Promise((r) => setTimeout(r, 200));

    const hexField = picker.querySelector('#colour-hex');
    hexField.value = '#2f9e44';
    hexField.dispatchEvent(new Event('change', { bubbles: true }));

    lines.push(`colour chosen  : ${hexField.value}`);

    picker.querySelector('#picker-apply').click();
    const picked = await pickerPromise;

    lines.push(`picker result  : kind=${picked?.kind} colour=${picked?.colour}`);

    // --- apply it ---
    const result = await call('setCardArt', {
      appId: app.id, colour: picked.colour, kind: 'background'
    });

    lines.push(`setCardArt     : ok=${result.ok} colour=${result.colour}`);

    setCardColour(app.id, result.colour);
    applyArt();
    await new Promise((r) => setTimeout(r, 400));

    const card = document.querySelector('.tv-card.is-focused');
    const art = card?.querySelector('.tv-card-art');

    lines.push('');
    lines.push(`card hasArt    : ${card?.dataset.hasArt ?? 'no'}`);
    lines.push(`card hasColour : ${card?.dataset.hasColour ?? 'no'}`);
    lines.push(`art background : image=${art?.style.backgroundImage || 'none'} colour=${art?.style.backgroundColor || 'none'}`);
    lines.push(`icon still set : ${Boolean(card?.querySelector('.tv-glyph img, .tv-glyph .is-fallback'))}`);

    call('log', { text: lines.join('\n') });
    } catch (err) {
      call('log', { text: 'ART DEMO FAILED: ' + (err?.stack ?? err) });
    }
  })();
}

/** Exercises the context menu, the picture picker and card artwork end to end. */
function layoutProbe() {
  const lines = [];

  const setMode = (mode) => {
    state.settings.mode = mode;
    syncModeButtons();
    render();
  };

  (async () => {
    // --- context menu ---
    setMode('tv');
    await new Promise((r) => setTimeout(r, 300));

    const app = state.apps[0];
    const card = [...document.querySelectorAll('.tv-card')].find((c) => c.dataset.appId === app.id);

    lines.push(`app            : ${app.name} (${app.id})`);
    lines.push(`card found     : ${Boolean(card)}`);

    openCardMenu(app, card, 400, 400);
    await new Promise((r) => setTimeout(r, 200));

    const menu = document.querySelector('.context-menu');
    lines.push(`menu items     : ${menu ? [...menu.querySelectorAll('.context-item')].map((b) => b.textContent).join(' | ') : 'NO MENU'}`);

    menu.hideMenu?.();
    document.querySelector('.context-menu')?.remove();

    // --- picture picker ---
    const pickerPromise = pickPicture({ library: 'icons', title: '测试' });
    await new Promise((r) => setTimeout(r, 600));

    const picker = document.getElementById('picture-picker');
    const items = picker ? [...picker.querySelectorAll('.picker-item')] : [];
    lines.push(`picker items   : ${items.length} (${items.map((i) => i.querySelector('span').textContent).join(', ')})`);

    // Choose the first picture, as a click in the picker would.
    items[0]?.click();
    const chosen = await pickerPromise;
    lines.push(`picked         : ${chosen ? chosen.split('\\').pop() : 'none'}`);

    // --- apply both, to different pictures ---
    if (chosen) {
      const background = await call('setCardArt', {
        appId: app.id, path: chosen, kind: 'background'
      });
      setCardArt(app.id, 'background', background.url);
      applyArt();

      await new Promise((r) => setTimeout(r, 300));

      const tile = [...document.querySelectorAll('.tv-card')].find((c) => c.dataset.appId === app.id);
      lines.push(`card hasArt    : ${tile?.dataset.hasArt ?? 'no'}`);
      lines.push(`card bgImage   : ${tile?.querySelector('.tv-card-art')?.style.backgroundImage ? 'set' : 'empty'}`);
    }

    // --- tablet behaviour ---
    setMode('tablet');
    await new Promise((r) => setTimeout(r, 400));

    const tile = [...document.querySelectorAll('.app-tile')].find((t) => t.dataset.appId === app.id);
    lines.push(`tablet hasArt  : ${tile?.dataset.hasArt ?? 'no'}`);

    call('log', { text: lines.join('\n') });
  })();
}

/* ------------------------------------------------------------------ settings application */

/**
 * The TV geometry as it was the last time the layout was computed.
 *
 * The TV mode needs to know what changed: a card size or overlap change rearranges the row, while
 * the group's vertical position is a single CSS variable that can be written live while the slider
 * is being dragged, so the group glides instead of snapping.
 */
let lastTvGeometry = null;

/** Applies the current settings to whichever mode is on screen. */
function applyCurrentMode() {
  // The clock is not per mode, so it is refreshed on every settings change regardless of which
  // mode is showing.
  applyClockSettings();
  applyWindowSettings();

  if (state.settings.mode === 'tv') {
    tv.applySettings(lastTvGeometry);
    lastTvGeometry = { ...state.settings.tv };
  } else {
    tablet.applySettings(stage());
    tablet.refresh();
  }
}

/**
 * --presstest: clicks a tablet tile and samples the plate's transform every frame.
 *
 * The press feedback is a 420ms animation, so a single screenshot cannot show whether it plays.
 * Sampling the computed transform over time proves it either way, and the result is written to a
 * file because an overlay on screen is covered by the launcher's own content.
 */
function pressTest() {
  const lines = [];

  const setMode = (mode) => {
    state.settings.mode = mode;
    syncModeButtons();
    render();
  };

  const sample = (label, element, trigger) => {
    const before = getComputedStyle(element).transform;
    lines.push(`${label}: before=${before}`);

    trigger();

    const t0 = performance.now();
    const seen = [];

    return new Promise((resolve) => {
      const tick = () => {
        const t = Math.round(performance.now() - t0);
        seen.push(`t=${t}ms ${getComputedStyle(element).transform}`);

        if (t < 520) {
          requestAnimationFrame(tick);
          return;
        }

        // Only the frames where the transform actually changed are interesting.
        const distinct = [...new Set(seen.map((s) => s.split(' ').slice(1).join(' ')))];
        lines.push(`${label}: distinct transforms = ${distinct.length}`);
        lines.push(...seen.filter((_, i) => i % 4 === 0).slice(0, 8));
        resolve();
      };

      requestAnimationFrame(tick);
    });
  };

  (async () => {
    setMode('tablet');
    await new Promise((r) => setTimeout(r, 400));

    const tile = document.querySelector('.app-tile');
    const plate = tile?.querySelector('.app-plate');

    if (!plate) {
      lines.push('no tablet tile found');
      call('log', { text: lines.join('\n') });
      return;
    }

    lines.push(`plate transition: ${getComputedStyle(plate).transition}`);
    lines.push(`plate delay     : ${getComputedStyle(plate).animationDelay}`);

    // Clicking the tile would launch an app, so the feedback is triggered the same way the click
    // handler does, without the launch.
    await sample('tablet press', plate, () => {
      tile.classList.add('tile-press');
      setTimeout(() => tile.classList.remove('tile-press'), 460);
    });

    setMode('tv');
    await new Promise((r) => setTimeout(r, 500));

    const card = document.querySelector('.tv-card.is-focused')
      ?? [...document.querySelectorAll('.tv-card')].find((c) => c.dataset.empty === 'no');
    const glyph = card?.querySelector('.tv-glyph');

    if (glyph) {
      lines.push(`tv glyph transition: ${getComputedStyle(glyph).transition}`);
      await sample('tv press', glyph, () => {
        card.classList.add('tile-press');
        setTimeout(() => card.classList.remove('tile-press'), 460);
      });
    }

    call('log', { text: lines.join('\n') });
  })();
}

/**
 * --probe: reports what the TV row actually contains, into the page, so a screenshot can be read
 * instead of guessed at. Input injection from outside the window is unreliable, so anything that
 * needs exercising gets a hook here.
 */
function probe() {
  const lines = [];

  // Measure the card that is actually on screen. The first card in DOM order may be one of the
  // ones parked outside the visible depth, which correctly has no transform at all.
  const card = document.querySelector('.tv-card.is-focused')
    ?? [...document.querySelectorAll('.tv-card')].find((c) => c.dataset.empty === 'no');

  if (!card) {
    return;
  }

  const cs = getComputedStyle(card);
  lines.push(`measured card      : pos=${card.dataset.position}`);
  lines.push(`transition-property: ${cs.transitionProperty}`);
  lines.push(`transition-duration: ${cs.transitionDuration}`);
  lines.push(`transform          : ${cs.transform}`);
  lines.push(`translate          : ${cs.translate}`);
  lines.push(`row data-instant   : ${document.querySelector('.tv-row')?.dataset.instant ?? '(unset)'}`);
  lines.push('');
  lines.push('--- live move, sampled every frame ---');
  lines.push(`t=0    ${cs.transform}`);

  // Watch the focused card. It moves to depth 1, so its transform must change over time.
  tv.move(1);

  const samples = [];
  const t0 = performance.now();

  const tick = () => {
    const t = Math.round(performance.now() - t0);
    samples.push(`t=${t}ms ${getComputedStyle(card).transform}`);

    if (t < 620) {
      requestAnimationFrame(tick);
      return;
    }

    lines.push(...samples.filter((_, i) => i % 5 === 0));
    call('log', { text: lines.join('\n') });
  };

  requestAnimationFrame(tick);
}

/** Reports the startup state and, when asked, turns it on so it can be verified. */
function startProbe() {
  const lines = [];
  const log = (text) => {
    lines.push(text);
    call('log', { text: lines.join('\n') });
  };

  (async () => {
    try {
      await new Promise((r) => setTimeout(r, 1200));

      const action = new URLSearchParams(location.search).get('startprobe') || 'status';

      const before = await call('autoStartStatus');
      log(`before     : enabled=${before.enabled} registered="${before.registered}"`);
      log(`current    : ${before.current}`);
      log(`matches    : ${before.matches}`);

      if (action === 'on' || action === 'off') {
        const want = action === 'on';
        const set = await call('autoStartSet', { enabled: want });

        log('');
        log(`set(${want}) : ok=${set.ok} enabled=${set.enabled} error=${set.error ?? '-'}`);

        const after = await call('autoStartStatus');
        log(`after      : enabled=${after.enabled} registered="${after.registered}"`);
        log(`matches    : ${after.matches}`);
      }
    } catch (err) {
      log('START PROBE FAILED: ' + err.message + ' | ' + err.hostWhere);
    }
  })();
}

/** Opens the card context menu over a busy part of the screen so its glass can be judged. */
function menuShot() {
  (async () => {
    try {
      await new Promise((r) => setTimeout(r, 1600));

      const card = document.querySelector('.tv-card.is-focused') ||
        document.querySelector('.app-tile');

      if (!card) {
        call('log', { text: 'no card to click' });
        return;
      }

      const app = state.apps.find((a) => a.id === card.dataset.appId) ?? state.apps[0];
      const rect = card.getBoundingClientRect();

      openCardMenu(app, card, rect.left + (rect.width / 2), rect.top + (rect.height / 2));
      call('log', { text: `menu open for ${app?.name}` });
    } catch (err) {
      call('log', { text: 'menu shot failed: ' + (err?.stack ?? err) });
    }
  })();
}

/** Drags right on the first grid page and reports what the stage actually does. */
function tvSwipeProbe() {
  const lines = [];
  const log = (text) => {
    lines.push(text);
    call('log', { text: lines.join('\n') });
  };

  (async () => {
    try {
      await new Promise((r) => setTimeout(r, 1600));

      const stageEl = stage();
      const viewport = document.querySelector('.tablet-viewport');

      log(`mode = ${state.settings.mode}`);
      log(`page = ${JSON.stringify(tablet.currentPage())}`);

      if (!stageEl || !viewport) {
        log('MISSING ELEMENTS');
        return;
      }

      const rect = viewport.getBoundingClientRect();
      const x0 = rect.left + 200;
      const y = rect.top + (rect.height / 2);

      const send = (type, x, buttons) => {
        stageEl.dispatchEvent(new PointerEvent(type, {
          pointerId: 7, bubbles: true, cancelable: true,
          clientX: x, clientY: y, button: 0, buttons
        }));
      };

      log(`stage animation before = ${getComputedStyle(stageEl).animationName}`);
      log('');

      send('pointerdown', x0, 1);

      // Drag rightwards in steps, recording the stage's transform each frame.
      for (let i = 1; i <= 8; i++) {
        send('pointermove', x0 + (i * 70), 1);
        await new Promise((r) => requestAnimationFrame(r));

        const cs = getComputedStyle(stageEl);
        log(`  step ${i}: inline=${stageEl.style.transform || 'none'} ` +
          `computed=${cs.transform} anim=${cs.animationName} opacity=${stageEl.style.opacity || '-'}`);
      }

      log('');
      log(`data-swiping = ${stageEl.dataset.swiping}`);

      send('pointerup', x0 + 560, 0);
      await new Promise((r) => setTimeout(r, 120));

      log(`after release: data-swiping = ${stageEl.dataset.swiping} ` +
        `inline=${stageEl.style.transform}`);

      await new Promise((r) => setTimeout(r, 700));
      log(`final mode = ${state.settings.mode}`);
    } catch (err) {
      log('TV SWIPE PROBE FAILED: ' + (err?.stack ?? err));
    }
  })();
}

/** Simulates a drag across the tablet grid and reports the track's movement. */
function dragProbe() {
  const lines = [];
  const log = (text) => {
    lines.push(text);
    call('log', { text: lines.join('\n') });
  };

  (async () => {
    try {
      await new Promise((r) => setTimeout(r, 1600));

      log(`mode = ${state.settings.mode}`);
      log(`apps = ${state.apps.length}`);

      const stageEl = stage();
      const track = document.querySelector('.tablet-track');
      const viewport = document.querySelector('.tablet-viewport');

      if (!stageEl || !track || !viewport) {
        log('MISSING ELEMENTS');
        return;
      }

      log(`viewport width = ${Math.round(viewport.getBoundingClientRect().width)}`);
      log(`page = ${JSON.stringify(tablet.currentPage())}`);

      // What is actually under the drag start point, and does it reach the stage listener?
      const r0 = viewport.getBoundingClientRect();
      const cx = r0.left + (r0.width / 2);
      const cy = r0.top + (r0.height / 2);
      const under = document.elementFromPoint(cx, cy);
      log(`element under centre = ${under?.className || under?.tagName}`);
      log(`closest button      = ${under?.closest('button') ? 'YES (drag will be ignored)' : 'no'}`);
      log('');

      /** Fires a synthetic pointer sequence the length of a real drag. */
      const dragBy = async (totalDx, label) => {
        const rect = viewport.getBoundingClientRect();
        const y = rect.top + (rect.height / 2);
        const x0 = rect.left + (rect.width / 2);

        const send = (type, x) => {
          stageEl.dispatchEvent(new PointerEvent(type, {
            pointerId: 1,
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: type === 'pointerup' ? 0 : 1
          }));
        };

        const samples = [];

        send('pointerdown', x0);

        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          send('pointermove', x0 + ((totalDx * i) / steps));
          await new Promise((r) => requestAnimationFrame(r));

          const m = /translateX\(([-\d.]+)%\)/.exec(track.style.transform || '');
          samples.push(m ? Number(m[1]).toFixed(1) : track.style.transform || 'none');
        }

        log(`${label}: track offsets during drag = ${samples.join(' -> ')}`);

        send('pointerup', x0 + totalDx);
        await new Promise((r) => setTimeout(r, 450));

        log(`${label}: page after release = ${JSON.stringify(tablet.currentPage())}`);
        log(`${label}: track after release = ${track.style.transform}`);
        log('');
      };

      log('--- drag LEFT (should go to page 2) ---');
      await dragBy(-500, 'left');

      log('--- drag RIGHT (should return to page 1) ---');
      await dragBy(500, 'right');

      log('--- drag RIGHT on page 1 (should start leaving for tv) ---');
      await dragBy(600, 'right-on-first');

      await new Promise((r) => setTimeout(r, 600));
      log(`final mode = ${state.settings.mode}`);

      log('');
      log('--- what the drag handler saw ---');
      for (const line of tablet.diagnostic.slice(0, 40)) {
        log(`   ${line}`);
      }
    } catch (err) {
      log('DRAG PROBE FAILED: ' + (err?.stack ?? err));
    }
  })();
}

/** Walks through the mode transitions and reports the page each one lands on. */
function pageProbe() {
  const lines = [];
  const log = (text) => {
    lines.push(text);
    call('log', { text: lines.join('\n') });
  };

  (async () => {
    try {
      await new Promise((r) => setTimeout(r, 1600));

      const where = (label) => {
        const p = tablet.currentPage();
        log(`${label.padEnd(34)} mode=${state.settings.mode.padEnd(6)} page=${p.page}/${p.pageCount}`);
      };

      log('--- paging stops at the ends ---');

      state.settings.mode = 'tablet';
      syncModeButtons();
      render();
      tablet.resetPage();
      await new Promise((r) => setTimeout(r, 300));
      where('tablet, start');

      tablet.previousPage();
      await new Promise((r) => setTimeout(r, 450));
      where('previousPage on first page');

      tablet.nextPage();
      await new Promise((r) => setTimeout(r, 450));
      where('nextPage');

      tablet.nextPage();
      await new Promise((r) => setTimeout(r, 450));
      where('nextPage again');

      // Run to the end and try to go past it.
      for (let i = 0; i < 6; i++) {
        tablet.nextPage();
        await new Promise((r) => setTimeout(r, 400));
      }
      where('nextPage at the last page');

      log('');
      log('--- switching modes ---');

      setMode('tv');
      await new Promise((r) => setTimeout(r, 400));
      where('switched to tv');

      setMode('tablet');
      await new Promise((r) => setTimeout(r, 500));
      where('switched back to tablet');

      log('');
      log('the two lines above must both read page=0');
    } catch (err) {
      log('PAGE PROBE FAILED: ' + (err?.stack ?? err));
    }
  })();
}

/** Reports how the window is attached to the desktop. */
function wallProbe() {
  (async () => {
    try {
      await new Promise((r) => setTimeout(r, 1500));

      const status = await call('wallStatus');

      // Ask the host to try each placement in turn and report which leaves the window above the
      // desktop. Guessing at the right one has already proved unreliable on this machine.
      const probe = await call('wallProbe');

      const lines = Object.entries(status)
        .filter(([key]) => key !== 'workArea' && key !== 'screen' && key !== 'attempt')
        .map(([key, value]) => `${key.padEnd(18)}: ${value}`);

      lines.push('');
      lines.push('placement trials (aboveDesktop = visible over the wallpaper):');

      for (const trial of probe.results ?? []) {
        lines.push(`   ${String(trial.name).padEnd(15)} parent=${trial.parent} aboveDesktop=${trial.aboveDesktop}`);
      }

      lines.push('');
      lines.push(`page viewport     : ${window.innerWidth}x${window.innerHeight}`);

      call('log', { text: lines.join('\n') });
    } catch (err) {
      call('log', { text: 'wall probe failed: ' + (err?.stack ?? err) });
    }
  })();
}

/** Reports where the clock ends up for each horizontal slider value. */
function clockProbe() {
  (async () => {
    try {
      await new Promise((r) => setTimeout(r, 1500));

      const box = $('clock-box');
      const lines = [`window width   : ${window.innerWidth}`];

      for (const x of [0, 5, 25, 50, 75, 95, 100]) {
        state.settings.clock.x = x;
        applyClockSettings();

        // The browser has to lay out before the new position can be read.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        const rect = box.getBoundingClientRect();
        const centre = Math.round(rect.left + (rect.width / 2));
        const expected = Math.round(window.innerWidth * (x / 100));

        lines.push(
          `x=${String(x).padStart(3)}%  centre=${String(centre).padStart(4)}px  ` +
          `expected=${String(expected).padStart(4)}px  diff=${centre - expected}px`);
      }

      // Restore the setting the user had.
      state.settings.clock.x = 50;
      applyClockSettings();

      call('log', { text: lines.join('\n') });
    } catch (err) {
      call('log', { text: 'clock probe failed: ' + (err?.stack ?? err) });
    }
  })();
}

/** Opens one floating surface so its glass treatment can be photographed. */
function glassShot() {
  (async () => {
    try {
      await new Promise((r) => setTimeout(r, 1200));

      const step = new URLSearchParams(location.search).get('glassshot') ?? 'panel';

      if (step === 'confirm') {
        panel?.close();
        openConfirm();
        call('log', { text: 'confirm open' });
        return;
      }

      if (step === 'picker') {
        panel?.close();
        pickPicture({ library: 'icons', title: '选择卡片背景', allowColour: true });
        call('log', { text: 'picker open' });
        return;
      }

      panel?.open();
      call('log', { text: 'panel open' });
    } catch (err) {
      call('log', { text: 'glass shot failed: ' + (err?.stack ?? err) });
    }
  })();
}

/*
 * Runs a backup and reports what it captured, so the archive can be checked without opening it.
 */
function backupTest() {
  const lines = [];
  const log = (text) => {
    lines.push(text);
    call('log', { text: lines.join('\n') });
  };

  (async () => {
    try {
      log('backup test starting');
      await new Promise((r) => setTimeout(r, 2000));

      const listed = await call('backupList');
      log(`backup folder  : ${listed.folder}`);
      log(`before         : ${(listed.backups ?? []).length} backups`);

      const created = await call('backupCreate', { note: '自动化测试' });

      if (!created.ok) {
        log('BACKUP FAILED: ' + created.error);
        return;
      }

      log(`created        : ${created.path}`);
      log(`size           : ${Math.round(created.size / 1024)} KB`);
      log('');
      log('captured:');
      for (const [key, value] of Object.entries(created.counts ?? {})) {
        log(`   ${key}: ${value}`);
      }

      const after = await call('backupList');
      log('');
      log(`after          : ${(after.backups ?? []).length} backups`);
      log(`newest         : ${(after.backups ?? [])[0]?.name ?? '-'}`);
    } catch (err) {
      log('BACKUP TEST FAILED: ' + (err?.stack ?? err));
    }
  })();
}

/** Reports what the host sees, then opens a real file dialog so its appearance can be checked. */
function pickProbe() {
  (async () => {
    try {
      await new Promise((r) => setTimeout(r, 1600));

      const before = await call('pickTest');
      call('log', { text: `before: ${JSON.stringify(before)}` });

      // Opens the dialog for real. It stays up until it is answered or dismissed.
      const kind = new URLSearchParams(location.search).get('pickprobe') || 'wallpaper';
      const command = kind === 'shortcut' ? 'pickFile' : 'pickFiles';

      call('log', { text: `calling ${command} kind=${kind}` });

      const result = command === 'pickFile'
        ? await call('pickFile', { kind })
        : await call('pickFiles', { kind });

      call('log', { text: `dialog returned: ${JSON.stringify(result)}` });
    } catch (err) {
      call('log', {
        text: `pick probe failed: ${err?.message}\n  type: ${err?.hostType}\n  where: ${err?.hostWhere}`
      });
    }
  })();
}

/*
 * Starts the shell and, when a diagnostic flag is present, runs the matching probe.
 *
 * A failing probe is reported rather than swallowed: a probe that silently does nothing is
 * indistinguishable from a feature that does not work, which has already cost time more than once.
 */
start()
  .then(() => {
    const params = new URLSearchParams(location.search);

    const probes = [
      ['selftest', selfTest],
      ['probe', probe],
      ['presstest', pressTest],
      ['layoutprobe', layoutProbe],
      ['artdemo', artDemo],
      ['artcheck', artCheck],
      ['importtest', importTest],
      ['backuptest', backupTest],
      ['glassshot', glassShot],
      ['clockprobe', clockProbe],
      ['wallprobe', wallProbe],
      ['pageprobe', pageProbe],
      ['dragprobe', dragProbe],
      ['tvswipeprobe', tvSwipeProbe],
      ['menushot', menuShot],
      ['pickprobe', pickProbe],
      ['startprobe', startProbe]
    ];

    for (const [flag, run] of probes) {
      if (params.has(flag)) {
        try {
          run();
        } catch (err) {
          call('log', { text: `PROBE ${flag} FAILED: ${err?.stack ?? err}` });
        }
      }
    }
  })
  .catch((err) => {
    setBridgeState('启动失败', false);

    // The page is otherwise blank, so the failure is put where it can be seen.
    const hint = document.getElementById('hint');
    if (hint) {
      hint.hidden = false;
      hint.textContent = '启动失败: ' + (err?.stack ?? err);
      hint.style.whiteSpace = 'pre-wrap';
      hint.style.zIndex = '9999';
    }

    call('log', { text: `START FAILED: ${err?.stack ?? err}` });
  });
