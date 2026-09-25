/*
 * Tablet mode: a grid of apps, pages of n rows by n columns.
 *
 * Everything about the geometry comes from CSS variables that the settings panel writes. The
 * browser does the arranging, so there is no arithmetic here that can disagree with what is drawn:
 * no card is sized twice, no row is pushed off screen, and the gaps are exactly the values in the
 * settings.
 */

import { call } from './bridge.js';
import { state, iconFor } from './state.js';

const PAGE_FLIP_MS = 280;

let page = 0;
let pageCount = 1;
let flipping = false;

/** Builds the grid for the current settings and app list. */
export function render(root) {
  const s = state.settings.tablet;

  root.replaceChildren();

  const perPage = perPageCount();
  pageCount = Math.max(1, Math.ceil(state.apps.length / perPage));
  page = Math.min(page, pageCount - 1);

  const viewport = document.createElement('div');
  viewport.className = 'tablet-viewport';

  const track = document.createElement('div');
  track.className = 'tablet-track';

  for (let p = 0; p < pageCount; p++) {
    track.append(buildPage(p, perPage));
  }

  viewport.append(track);
  root.append(viewport);

  if (pageCount > 1) {
    root.append(buildDots());
  }

  applySettings(root);
  setPage(page, false);
}

/** How many apps fit on one page, from the column and row counts. */
function perPageCount() {
  const s = state.settings.tablet;
  const rows = Math.max(1, Number(s.rows) || 2);
  return Math.max(1, s.columns) * rows;
}

function buildPage(index, perPage) {
  const s = state.settings.tablet;
  const rows = Math.max(1, Number(s.rows) || 2);

  const grid = document.createElement('div');
  grid.className = 'tablet-grid';
  grid.style.setProperty('--cols', s.columns);
  grid.style.setProperty('--rows', rows);

  const slice = state.apps.slice(index * perPage, (index + 1) * perPage);

  slice.forEach((app, i) => {
    grid.append(buildTile(app, i));
  });

  return grid;
}

function buildTile(app, order = 0) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'app-tile';
  tile.title = app.path;
  tile.dataset.appId = app.id;

  // Stagger the entrance so the grid assembles rather than appearing all at once. Capped so a
  // large page does not take a second to finish.
  tile.style.animationDelay = `${Math.min(order, 24) * 22}ms`;

  if (app.broken) {
    // The target is gone. Saying so beats a click that does nothing.
    tile.classList.add('is-broken');
  }

  const plate = document.createElement('span');
  plate.className = 'app-plate';

  const glyph = document.createElement('span');
  glyph.className = 'app-glyph';
  glyph.textContent = '';

  plate.append(glyph);

  const caption = document.createElement('span');
  caption.className = 'app-caption';
  caption.textContent = app.name;

  tile.append(plate, caption);

  applyTileArt(tile, app);

  tile.addEventListener('click', () => {
    // Play the feedback first, then launch: the press reads as the cause of the launch, and a
    // launcher that starts a program before acknowledging the click feels broken.
    playPressFeedback(tile);

    if (!app.broken) {
      setTimeout(() => call('launch', { target: app.path }), 160);
    }
  });

  tile.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    onContextMenu?.(app, tile, e.clientX, e.clientY);
  });

  return tile;
}

/**
 * Draws a tile's picture.
 *
 * In the grid the icon picture replaces the icon *and* its white plate: the tile becomes the
 * picture. A TV card is different, where the background picture sits behind an icon that stays
 * visible.
 */
export function applyTileArt(tile, app) {
  const url = state.cardIcons[app.id];
  const glyph = tile.querySelector('.app-glyph');

  if (url) {
    tile.dataset.hasArt = 'yes';
    tile.style.setProperty('--tile-art', `url("${url}")`);
    return;
  }

  delete tile.dataset.hasArt;
  tile.style.removeProperty('--tile-art');

  // No custom picture: put back whatever the extractor produced.
  if (!glyph) return;

  iconFor(app).then((extracted) => {
    if (state.cardIcons[app.id]) return;

    if (extracted) {
      const img = document.createElement('img');
      img.src = extracted;
      img.alt = '';
      glyph.classList.remove('is-fallback');
      glyph.replaceChildren(img);
    } else {
      glyph.textContent = app.name.slice(0, 1);
      glyph.classList.add('is-fallback');
    }
  });
}

/** Re-draws the artwork on every tile, after artwork changes. */
export function refreshTileArt() {
  document.querySelectorAll('.app-tile').forEach((tile) => {
    const app = state.apps.find((a) => a.id === tile.dataset.appId);
    if (app) {
      applyTileArt(tile, app);
    }
  });
}

/** Set by the shell so the menu can be built without this module knowing about menus. */
let onContextMenu = null;

export function setContextMenuHandler(handler) {
  onContextMenu = handler;
}

/**
 * The press feedback.
 *
 * A class rather than :active so the same animation plays for a mouse click, a keyboard activation
 * and a remote. The animation itself runs on the plate, which is the part of the tile the eye
 * tracks, and the class is cleared on a timer rather than on animationend: the entrance animation
 * also ends on this element, so an event listener would clear the press feedback immediately.
 */
export function playPressFeedback(element) {
  element.classList.remove('tile-press');

  // Reading offsetWidth restarts the animation when it is already running, which is what makes a
  // quick second press respond instead of being ignored.
  void element.offsetWidth;
  element.classList.add('tile-press');

  clearTimeout(element._pressTimer);
  element._pressTimer = setTimeout(() => element.classList.remove('tile-press'), 460);
}

function buildDots() {
  const dots = document.createElement('div');
  dots.className = 'page-dots';

  for (let i = 0; i < pageCount; i++) {
    const dot = document.createElement('span');
    dot.className = 'page-dot';
    dots.append(dot);
  }

  return dots;
}

/** Writes the settings into CSS variables. This is the only place geometry is decided. */
export function applySettings(root) {
  const s = state.settings.tablet;

  root.style.setProperty('--icon-size', `${s.iconSize}px`);
  root.style.setProperty('--card-size', `${s.cardSize}px`);
  root.style.setProperty('--card-radius', `${s.cardRadius}px`);
  root.style.setProperty('--col-gap', `${s.colGap}px`);
  root.style.setProperty('--row-gap', `${s.rowGap}px`);
  root.style.setProperty('--caption-size', `${s.captionSize}px`);
  root.dataset.showPlate = s.showPlate ? 'yes' : 'no';
}

/** The current page index and how many there are. */
export function currentPage() {
  return { page, pageCount };
}

/** Returns to the first page without animating. Used when entering the mode. */
export function resetPage() {
  setPage(0, false);
}

/** Moves to a page, animating unless told not to. */
export function setPage(index, animate = true) {
  const track = document.querySelector('.tablet-track');

  if (!track) return;

  page = Math.max(0, Math.min(index, pageCount - 1));

  track.style.transition = animate
    ? `transform var(--dur-base) var(--ease-out)`
    : 'none';

  track.style.transform = `translateX(${-page * 100}%)`;

  // Only the visible page accepts input. Without this, a card on an adjacent page could still be
  // clicked through the viewport edge.
  document.querySelectorAll('.tablet-grid').forEach((grid, i) => {
    grid.dataset.active = i === page ? 'yes' : 'no';
  });

  document.querySelectorAll('.page-dot').forEach((dot, i) => {
    dot.dataset.active = i === page ? 'yes' : 'no';
  });
}

/*
 * Paging stops at the ends rather than wrapping.
 *
 * Wrapping looks helpful in isolation but it breaks the two gestures that live at the edges: the
 * first page is where a rightward drag means "go back to the TV mode", and wrapping turned that
 * drag into a jump to the last page first. Stopping at the ends keeps the edges free to mean
 * something else.
 */

export function nextPage() {
  if (flipping) return;
  if (page + 1 >= pageCount) return;

  flipping = true;
  setPage(page + 1);
  setTimeout(() => { flipping = false; }, PAGE_FLIP_MS);
}

export function previousPage() {
  if (flipping) return;
  if (page - 1 < 0) return;

  flipping = true;
  setPage(page - 1);
  setTimeout(() => { flipping = false; }, PAGE_FLIP_MS);
}

/**
 * The tablet grid's own focus, used when the top bar hands control back to the content.
 *
 * A grid needs a cursor because the remote has no pointer: without one there is no way to say which
 * tile Enter would launch.
 */
let cursor = 0;

/** Highlights the tile at the cursor, or clears the highlight when the content is not focused. */
export function setContentFocus(active) {
  const tiles = [...document.querySelectorAll('.tablet-grid[data-active="yes"] .app-tile')];

  tiles.forEach((tile, i) => {
    tile.classList.toggle('is-cursor', active && i === cursor);
  });

  if (active && tiles[cursor]) {
    tiles[cursor].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/** True when the cursor is on the first row, so up should leave the grid. */
export function cursorOnTopRow() {
  const cols = Math.max(1, Number(state.settings.tablet.columns) || 1);
  return cursor < cols;
}

/** True when the cursor is on the last row of the page. */
export function cursorOnBottomRow() {
  const cols = Math.max(1, Number(state.settings.tablet.columns) || 1);
  const tiles = document.querySelectorAll('.tablet-grid[data-active="yes"] .app-tile').length;
  return cursor + cols >= tiles;
}

/** Moves the grid cursor. Returns true when the move happened inside this page. */
export function moveCursor(dx, dy) {
  const tiles = [...document.querySelectorAll('.tablet-grid[data-active="yes"] .app-tile')];
  if (tiles.length === 0) return false;

  const cols = Math.max(1, Number(state.settings.tablet.columns) || 1);

  if (dx !== 0) {
    const next = cursor + dx;

    // Moving past an edge turns the page instead of stopping, which is what a remote user expects.
    if (next < 0) {
      previousPage();
      cursor = 0;
    } else if (next >= tiles.length) {
      nextPage();
      cursor = 0;
    } else {
      cursor = next;
    }

    setContentFocus(true);
    return true;
  }

  const next = cursor + (dy * cols);

  // Moving up off the first row, or down off the last, is the caller's cue to leave the grid.
  if (next < 0 || next >= tiles.length) {
    return false;
  }

  cursor = next;
  setContentFocus(true);
  return true;
}

/** Activates the tile under the cursor. */
export function activateCursor() {
  const tiles = [...document.querySelectorAll('.tablet-grid[data-active="yes"] .app-tile')];
  tiles[cursor]?.click();
}

/** Resets the cursor, used when the page or the layout changes. */
export function resetCursor() {
  cursor = 0;
}

export function currentCursor() {
  return cursor;
}

/**
 * Re-lays the grid after a settings change. Only the geometry changes, so the existing pages are
 * rebuilt in place rather than the whole stage: that keeps the current page and avoids rebuilding
 * every icon.
 */
export function refresh() {
  const s = state.settings.tablet;
  const rows = Math.max(1, Number(s.rows) || 2);
  const perPage = perPageCount();
  const wanted = Math.max(1, Math.ceil(state.apps.length / perPage));

  document.querySelectorAll('.tablet-grid').forEach((grid) => {
    grid.style.setProperty('--cols', s.columns);
    grid.style.setProperty('--rows', rows);
  });

  // The number of pages changes whenever the column or row count does.
  if (wanted !== pageCount || document.querySelectorAll('.tablet-grid').length !== wanted) {
    const keep = page;
    render(document.getElementById('stage'));
    setPage(Math.min(keep, pageCount - 1), false);
  }
}

/**
 * Horizontal scroll and drag both flip pages.
 *
 * Bound once, to an element that outlives a render. Binding to the stage on every render would
 * stack handlers, so one wheel notch would advance several pages.
 */
let inputBound = false;

export function attachInput(root) {
  if (inputBound) return;
  inputBound = true;

  // Bound to the stage element itself, which persists across renders.
  const host = root;

  host.addEventListener('wheel', (e) => {
    if (state.settings.mode !== 'tablet') return;

    // Trackpads send both axes; the larger one wins.
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 4) return;

    e.preventDefault();
    delta > 0 ? nextPage() : previousPage();
  }, { passive: false });
}

/* ------------------------------------------------------------------ drag to page */

/**
 * Dragging the grid sideways turns the page, following the pointer as it goes.
 *
 * The track is moved with the finger rather than playing a canned animation on release, so the
 * page stays under the cursor and the gesture reads as physically pulling the grid. On release it
 * either settles onto the next page or springs back, depending on how far it travelled.
 *
 * Dragging right on the first page has nothing to reach, so that gesture is handed to the caller,
 * which uses it to return to the TV mode. That is why the first page can be swiped back out of.
 */
let drag = null;

/**
 * Guards against binding twice.
 *
 * Each call adds a fresh set of listeners sharing a fresh `drag` variable, so a second call leaves
 * one handler tracking a gesture while another sees an empty one — the symptom being a drag that
 * animates but never settles. The same guard is used for the wheel handler.
 */
let dragBound = false;

export function attachDrag(root, { onLeaveToTv, isEnabled, onFirstPage }) {

  if (dragBound) return;
  dragBound = true;

  const stage = root;

  /** The window width, used to judge how far a drag has travelled. */
  const width = () => window.innerWidth || 1;

  /** The element the pages live in, created fresh by each render. */
  const track = () => document.querySelector('.tablet-track');

  /*
   * Offsets are written as percentages of the track, matching setPage. The track is one page wide
   * per page and the viewport shows one page, so one page of travel is 100%. Using the same unit as
   * setPage means a drag and a keyboard flip cannot disagree about where a page rests.
   */
  const restPercent = (index) => -index * 100;

  function moveTrack(percent) {
    const el = track();
    if (!el) return;

    // No transition while dragging: the track has to follow the pointer exactly, and a transition
    // would make it lag behind and feel detached.
    el.style.transition = 'none';
    el.style.transform = `translateX(${percent}%)`;
  }

  /** Applies a settled page, reusing setPage so the dots and grid activation stay in step. */
  function settleTo(index) {
    setPage(index, true);
  }

  /** How far the pointer has moved, as a share of one page's width. */
  function dxToPercent(dx) {
    const viewport = document.querySelector('.tablet-viewport');
    const width = viewport?.getBoundingClientRect().width || window.innerWidth || 1;
    return (dx / width) * 100;
  }

  stage.addEventListener('pointerdown', (e) => {

    if (!isEnabled() || e.button !== 0) {
      return;
    }

    if (e.target.closest('button, .settings-panel')) {
      return;
    }

    drag = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      active: false,
      // Whether this drag is turning a page or leaving for the TV mode.
      leaving: false
    };
  });

  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (!drag.active) {
      // Wait until the gesture is clearly horizontal, so a vertical drag is left alone.
      if (Math.abs(dx) < 12) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        drag = null;
        return;
      }

      drag.active = true;

      // Pointer capture is a convenience, not a requirement: the listeners are on the stage, which
      // contains the pointer for the whole gesture. Capturing is attempted so a drag that leaves
      // the window keeps reporting, but a failure must not abort the gesture.
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        // Nothing to do: the drag still works through the stage's own listeners.
      }

      // On the first page a rightward drag is the way back to the TV mode.
      drag.leaving = dx > 0 && onFirstPage();
    }

    drag.dx = dx;

    if (drag.leaving) {
      // Only rightward counts when leaving; there is nothing to the left.
      onLeaveToTv('drag', Math.max(0, dx) / width());
      return;
    }

    const from = currentPage().page;
    const atStart = from === 0;
    const atEnd = from >= currentPage().pageCount - 1;

    // Pulling past the first or last page meets resistance rather than not moving at all, so the
    // edge feels like an edge instead of a broken gesture.
    const resisted = (atStart && dx > 0) || (atEnd && dx < 0);

    moveTrack(restPercent(from) + dxToPercent(resisted ? dx * 0.35 : dx));
  });

  const finish = (e) => {

    if (!drag || e.pointerId !== drag.id) {
      return;
    }

    const { active, dx, leaving } = drag;

    drag = null;

    if (!active) {
      return;
    }

    try {
      stage.releasePointerCapture(e.pointerId);
    } catch {
      // Capture was never taken, or was already released. Neither is a problem.
    }

    // A fifth of a page is far enough to mean it.
    const far = Math.abs(dx) / width() > 0.2;

    if (leaving) {
      onLeaveToTv(far ? 'commit' : 'cancel');
      return;
    }

    const from = currentPage().page;
    const target = dx < 0 ? from + 1 : from - 1;

    if (far && target >= 0 && target < currentPage().pageCount) {
      flipping = true;
      settleTo(target);
      setTimeout(() => { flipping = false; }, PAGE_FLIP_MS);
      return;
    }

    // Not far enough, or past the end: return to where it started.
    settleTo(from);
  };

  stage.addEventListener('pointerup', (e) => {
    finish(e);
  });
  stage.addEventListener('pointercancel', finish);
}
