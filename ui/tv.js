/*
 * TV mode: a cover flow.
 *
 * Design note, because an earlier version got this wrong in a way that made the animation
 * invisible.
 *
 * Each card is bound to ONE app for its whole life. Moving the focus does not shuffle apps between
 * fixed slots: it changes where every card sits. The card for the newly focused app therefore
 * travels from the side position into the centre while growing from the side size to full size,
 * and the card that was centred slides out to the side while shrinking. That movement is the
 * animation, and it only exists because the card keeps its identity.
 *
 * Positions are transform only. Width and height are never animated: they are set once and the
 * depth is expressed as a scale, so the whole move is a single composited transform.
 */

import { call } from './bridge.js';
import { state, iconFor } from './state.js';

const SCALES = [1, 0.74, 0.52];   // focused, one step out, two steps out
const VISIBLE = 2;                // cards shown on each side
const STEP_MS = 320;              // must match the transform transition in tv.css

/** Every card, in list order. Each one is bound to the app at the same list index. */
let cards = [];
let root_ = null;
let captionName = null;
let captionCounter = null;

/** Index of the app in the centre. */
let index = 0;

/** True while a move is in flight, so a held key cannot skip past the intended card. */
let moving = false;

/** Clears the entrance's per-card delays once it has finished. */
let entranceTimer = 0;

/* ------------------------------------------------------------------ render */

/** Builds one card per app, then positions them. Called when the app list changes. */
export function render(root) {
  root_ = root;
  root.replaceChildren();

  const row = document.createElement('div');
  row.className = 'tv-row';

  const caption = document.createElement('div');
  caption.className = 'tv-caption';

  captionName = document.createElement('span');
  captionName.className = 'tv-name-label';

  captionCounter = document.createElement('span');
  captionCounter.className = 'tv-counter';

  caption.append(captionName, captionCounter);

  // The caption lives inside the row so both share one coordinate system: the card positions and
  // the caption offset are then measured from the same origin and cannot disagree.
  root.append(row);
  row.append(caption);

  cards = state.apps.map((app, i) => {
    const card = buildCard(app, i);
    row.append(card.element);
    return card;
  });

  // Start in the middle so both sides of the row are populated: starting on the first app leaves
  // the left half empty, which reads as a bug rather than as a list edge.
  if (state.apps.length > 1 && index === 0) {
    index = Math.floor(state.apps.length / 2);
  }

  index = clamp(index);

  // Position without animating: the initial layout should be instant.
  layout({ animate: false });
  updateCaption();

  // Then unfurl from the centre card outwards.
  playEntrance();
}

/**
 * The entrance: the centred card is already in place, and the others grow out of it.
 *
 * Cards start stacked on the centre card — same size, same position, no depth — and then move to
 * their real places. The effect is the row opening up from behind the focused card rather than a
 * set of cards fading in wherever they happen to belong.
 *
 * It runs by collapsing the layout and releasing it on the next frame, so the browser has a
 * starting position to animate from. Setting only the end state would jump.
 */
function playEntrance() {
  const row = root_?.querySelector('.tv-row');
  if (!row || cards.length < 2) return;

  // Respect a user who has asked for less motion: the cards simply appear in place.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const focused = cards[index]?.element;

  for (const card of cards) {
    if (card.element === focused) continue;

    // Collapse onto the centre: no sideways offset and no scale change, so every card sits exactly
    // on top of the focused one. The transition is suppressed so this starting state is applied at
    // once instead of being animated into.
    card.element.style.transition = 'none';
    card.element.style.transform = 'translateX(0px) scale(1)';
    card.element.style.zIndex = '1';
  }

  // Force the collapsed state to be laid out, so the browser has a real starting position. Without
  // this the two writes coalesce into one frame and nothing animates.
  void row.offsetWidth;

  // Cards further out start a little later, so the row opens like a fan rather than sliding as one
  // rigid block.
  for (const card of cards) {
    if (card.element === focused) continue;

    const distance = Math.abs(card.position - index);
    card.element.style.transition = '';
    card.element.style.transitionDelay = `${Math.min(distance - 1, 3) * 45}ms`;
  }

  // Re-run the layout with animation enabled so every card travels out to its real place.
  layout({ animate: true });

  // The delay is only for the entrance: leaving it set would lag every later move.
  clearTimeout(entranceTimer);
  entranceTimer = setTimeout(() => {
    for (const card of cards) {
      card.element.style.transitionDelay = '';
    }
  }, 900);
}

function clamp(value) {
  return Math.max(0, Math.min(value, Math.max(0, state.apps.length - 1)));
}

function buildCard(app, position) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'tv-card';
  element.title = app.path;
  element.dataset.position = String(position);
  element.dataset.appId = app.id;

  // The artwork layer sits behind the icon and is only shown when the card has a picture. The
  // white plate underneath stays: an icon with a transparent background needs something to sit on.
  const art = document.createElement('span');
  art.className = 'tv-card-art';

  const glyph = document.createElement('span');
  glyph.className = 'tv-glyph';

  element.append(art, glyph);

  // Both pictures are drawn by the same two helpers the settings use, so there is exactly one
  // place that decides what a card shows.
  applyCardArt(element, app);
  applyCardIcon(element, app);

  if (app.broken) {
    element.classList.add('is-broken');
  }

  element.addEventListener('click', () => {
    if (position === index) {
      activate();
    } else {
      // Clicking a side card focuses it; only the centred card launches.
      move(position - index);
    }
  });

  element.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    onContextMenu?.(app, element, e.clientX, e.clientY);
  });

  return { element, glyph, art, app, position };
}

/** Draws the card's custom background, or removes it when there is none. */
export function applyCardArt(element, app) {
  const art = element.querySelector('.tv-card-art');
  if (!art) return;

  const url = state.cardArt[app.id];
  const colour = state.cardColours[app.id];

  if (url) {
    art.style.backgroundImage = `url("${url}")`;
    art.style.backgroundColor = '';
    element.dataset.hasArt = 'yes';
    delete element.dataset.hasColour;
    return;
  }

  if (colour) {
    // A flat colour needs no image, but it uses the same layer so the icon stays on top of it.
    art.style.backgroundImage = '';
    art.style.backgroundColor = colour;
    element.dataset.hasArt = 'yes';
    element.dataset.hasColour = 'yes';
    return;
  }

  art.style.backgroundImage = '';
  art.style.backgroundColor = '';
  delete element.dataset.hasArt;
  delete element.dataset.hasColour;
}

/** Draws the card's custom icon, or falls back to the one extracted from the program. */
export function applyCardIcon(element, app) {
  const glyph = element.querySelector('.tv-glyph');
  if (!glyph) return;

  const url = state.cardIcons[app.id];

  if (!url) {
    // No custom icon: put back whatever the extractor produced.
    delete element.dataset.hasIcon;

    iconFor(app).then((extracted) => {
      if (state.cardIcons[app.id]) return;

      if (extracted) {
        const img = document.createElement('img');
        img.src = extracted;
        img.alt = '';
        glyph.classList.remove('is-fallback');
        glyph.replaceChildren(img);
      } else {
        const fallback = document.createElement('span');
        fallback.className = 'is-fallback';
        fallback.textContent = app.name.slice(0, 1);
        glyph.replaceChildren(fallback);
      }
    });

    return;
  }

  element.dataset.hasIcon = 'yes';

  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  glyph.classList.remove('is-fallback');
  glyph.replaceChildren(img);
}

/** Re-draws both pictures on every card, after either changes. */
export function refreshCardArt() {
  for (const card of cards) {
    applyCardArt(card.element, card.app);
    applyCardIcon(card.element, card.app);
  }
}

/** Set by the shell so the menu can be built without this module knowing about menus. */
let onContextMenu = null;

export function setContextMenuHandler(handler) {
  onContextMenu = handler;
}

/* ------------------------------------------------------------------ layout */

/**
 * Places every card for the current focus.
 *
 * A card's depth is its distance from the focused index. Depth 0 is centred at full size, and each
 * step out is smaller and further from the middle, tucked under the card in front of it.
 */
export function layout({ animate = true } = {}) {
  const row = document.querySelector('.tv-row');
  if (!row) return;

  const { cardWidth, overlap } = state.settings.tv;
  const cardHeight = cardWidth * (9 / 16);

  // Centre-to-centre distance for each depth. The outer card is pulled in until the requested
  // share of its own width is hidden behind the card in front of it.
  const offsets = [0];
  for (let d = 1; d <= VISIBLE; d++) {
    const inner = cardWidth * SCALES[d - 1];
    const outer = cardWidth * SCALES[d];
    offsets[d] = offsets[d - 1] + inner / 2 + outer * (1 - overlap) - outer / 2;
  }

  // All the positional variables in one place, so the arrangement and the settings path can never
  // disagree about where anything goes.
  writePositionVariables(row, state.settings.tv);

  // Suppress the transition for the initial layout and for settings changes, so nothing slides
  // when the geometry is simply being (re)established.
  if (!animate) {
    row.dataset.instant = 'yes';
  }

  for (const card of cards) {
    const delta = card.position - index;
    const depth = Math.abs(delta);
    const visible = depth <= VISIBLE;

    card.element.dataset.empty = visible ? 'no' : 'yes';

    if (!visible) {
      continue;
    }

    const scale = SCALES[depth];
    const x = Math.sign(delta) * offsets[depth];

    // Fixed size for every card; the depth is a scale. This is what makes growing and moving one
    // single animatable transform.
    card.element.style.width = `${cardWidth}px`;
    card.element.style.height = `${cardHeight}px`;
    card.element.style.transform = `translateX(${x}px) scale(${scale})`;

    // Nearer the centre paints on top. Unique per card, so no tie can be broken by DOM order.
    card.element.style.zIndex = String(1000 - depth);

    // The icon is sized against the focused card so it stays proportional at every depth.
    const glyph = Math.round(cardWidth * scale * 0.42);
    card.glyph.style.width = `${glyph}px`;
    card.glyph.style.height = `${glyph}px`;

    card.element.classList.toggle('is-focused', depth === 0);
  }

  if (!animate) {
    // Force the layout to settle before re-enabling transitions, otherwise the browser coalesces
    // the instant placement and the next move into one frame and the slide is lost.
    void row.offsetWidth;
    delete row.dataset.instant;
  }
}

/**
 * Writes the positional variables.
 *
 * The caption is placed from the focused card's measured rectangle rather than from arithmetic on
 * the row height. The row does not begin at the top of the window (the top bar sits above it), so
 * deriving the caption from the row's own height put the name behind the cards. Measuring the card
 * removes that entire class of mistake.
 */
function writePositionVariables(row, settings) {
  const cardHeight = settings.cardWidth * (9 / 16);
  const cardWidth = settings.cardWidth;

  row.style.setProperty('--card-width', `${cardWidth}px`);
  row.style.setProperty('--card-height', `${cardHeight}px`);
  row.style.setProperty('--caption-size', `${settings.captionSize}px`);
  row.style.setProperty('--group-y', `${settings.groupY}%`);

  // Measure after the group position has been written, so the rectangle reflects it.
  const focused = row.querySelector('.tv-card.is-focused');
  const rowRect = row.getBoundingClientRect();

  const groupBottom = focused
    ? focused.getBoundingClientRect().bottom - rowRect.top
    : (rowRect.height * (settings.groupY / 100)) + (cardHeight / 2);

  const gap = Math.round(cardHeight * 0.08);
  const captionTop = groupBottom + gap + Number(settings.captionY ?? 0);

  row.style.setProperty('--caption-top', `${Math.round(captionTop)}px`);
}

/**
 * Re-applies the geometry after a settings change.
 *
 * Card width and overlap change the arrangement, so those need a full re-layout. The vertical
 * positions and the caption size do not: they are CSS variables, and writing them directly means
 * the group follows the slider while it is being dragged instead of snapping.
 */
export function applySettings(previous) {
  const row = document.querySelector('.tv-row');
  if (!row) return;

  const s = state.settings.tv;

  const geometryChanged = !previous
    || previous.cardWidth !== s.cardWidth
    || previous.overlap !== s.overlap;

  if (geometryChanged) {
    layout({ animate: false });
    return;
  }

  writePositionVariables(row, s);
}

/* ------------------------------------------------------------------ caption */

function updateCaption() {
  if (!captionName || !captionCounter) return;

  const app = state.apps[index];

  captionName.textContent = app ? app.name : '';
  captionCounter.textContent = state.apps.length > 0
    ? `${index + 1} / ${state.apps.length}`
    : '';
}

/* ------------------------------------------------------------------ movement */

/** Moves the focus by whole cards. The cards animate to their new positions. */
export function move(delta) {
  if (moving || state.apps.length === 0) return;

  const next = clamp(index + delta);
  if (next === index) return;

  index = next;
  moving = true;

  // This is the animation: every card is given a new transform, and the transition on the element
  // carries it there.
  layout({ animate: true });
  updateCaption();

  setTimeout(() => { moving = false; }, 90);
}

/** Launches the centred app. */
export function activate() {
  const app = state.apps[index];
  if (!app || app.broken) return;

  const centred = cards.find((c) => c.position === index);
  if (centred) {
    playPress(centred.element);
  }

  // The feedback plays first so the press reads as the cause of the launch.
  setTimeout(() => call('launch', { target: app.path }), 160);
}

/**
 * The press feedback, shared with the tablet grid so both modes respond identically.
 *
 * Cleared on a timer rather than on animationend: other animations also end on this element, and an
 * event listener would clear the press feedback the moment one of those finished.
 */
function playPress(element) {
  element.classList.remove('tile-press');

  // Forcing a reflow restarts the animation when it is already running.
  void element.offsetWidth;
  element.classList.add('tile-press');

  clearTimeout(element._pressTimer);
  element._pressTimer = setTimeout(() => element.classList.remove('tile-press'), 460);
}

/* ------------------------------------------------------------------ content focus */

/**
 * The cover flow always has exactly one focused card, so entering the content means showing its
 * highlight and leaving means muting the ring while keeping the position.
 */
export function setContentFocus(active) {
  const row = document.querySelector('.tv-row');
  if (row) {
    row.dataset.contentFocused = active ? 'yes' : 'no';
  }
}

/** The cover flow is a single row, so it is always on its top row. */
export function cursorOnTopRow() {
  return true;
}

export function cursorOnBottomRow() {
  return true;
}

/** Left and right move the focus by one card; vertical moves report that they went nowhere. */
export function moveCursor(dx, dy) {
  if (dx !== 0) {
    move(dx);
    return true;
  }

  return false;
}

/** Activates the centred card. */
export function activateCursor() {
  activate();
}

export function resetCursor() {
  // The cover flow keeps its position; there is nothing to reset.
}

/* ------------------------------------------------------------------ swipe to tablet */

/**
 * Dragging left on empty space switches to the tablet mode, following the finger as it goes.
 *
 * The page is moved with the pointer rather than playing a canned animation on release, so the
 * gesture feels attached to the cursor: the tablet slides in from the right exactly as far as the
 * drag has travelled, and springs back if the drag was too short to count.
 *
 * Only bare space starts a drag. Starting one on a card would fight the card's own click, and the
 * row is where the user expects to scroll the cover flow.
 */
let swipe = null;

export function attachSwipe(root, { onSwitch, isEnabled }) {
  const stage = root;

  stage.addEventListener('pointerdown', (e) => {
    if (!isEnabled() || e.button !== 0) return;

    // Anything on top of a card or a control keeps its own behaviour.
    if (e.target.closest('.tv-card, button, .settings-panel')) return;

    swipe = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      active: false
    };
  });

  stage.addEventListener('pointermove', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;

    const dx = e.clientX - swipe.startX;
    const dy = e.clientY - swipe.startY;

    // Wait until the gesture is clearly horizontal before taking over, so a vertical movement is
    // left to whatever else wanted it.
    if (!swipe.active) {
      if (Math.abs(dx) < 12) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        swipe = null;
        return;
      }

      swipe.active = true;
      stage.setPointerCapture(e.pointerId);
    }

    // Left only: dragging right has nothing behind it.
    swipe.dx = Math.min(0, dx);
    onSwitch('drag', swipe.dx / window.innerWidth);
  });

  const finish = (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;

    const { active, dx } = swipe;
    swipe = null;

    if (!active) return;

    try {
      stage.releasePointerCapture(e.pointerId);
    } catch {
      // The capture may already have been released; nothing to undo.
    }

    // A quarter of the screen is far enough to mean it.
    const progress = Math.abs(dx) / window.innerWidth;

    if (progress > 0.25) {
      // The page's own transition carries it the rest of the way.
      onSwitch('commit');
    } else {
      onSwitch('cancel');
    }
  };

  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);
}


/* ------------------------------------------------------------------ input */

/**
 * Wheel and drag, bound once to an element that outlives every render.
 *
 * Binding on each render would stack handlers, so one wheel notch would advance several cards.
 */
let inputBound = false;

export function attachInput(root) {
  if (inputBound) return;
  inputBound = true;

  const host = root;

  host.addEventListener('wheel', (e) => {
    if (state.settings.mode !== 'tv') return;

    // Trackpads report both axes; whichever is larger is the one the user meant.
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(delta) < 4) return;

    e.preventDefault();
    move(delta > 0 ? 1 : -1);
  }, { passive: false });

  let startX = null;
  let dragged = false;

  host.addEventListener('pointerdown', (e) => {
    if (state.settings.mode !== 'tv' || e.button !== 0) return;
    startX = e.clientX;
    dragged = false;
  });

  host.addEventListener('pointermove', (e) => {
    if (startX === null) return;
    if (Math.abs(e.clientX - startX) > 12) dragged = true;
  });

  host.addEventListener('pointerup', (e) => {
    if (startX === null) return;

    const dx = e.clientX - startX;
    startX = null;

    if (dragged && Math.abs(dx) > 60) {
      move(dx < 0 ? 1 : -1);
    }
  }, true);
}
