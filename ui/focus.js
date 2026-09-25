/*
 * Focus navigation.
 *
 * One focus, one place it can be: either a button in the top bar or a tile in the content. Every
 * input — keyboard, remote, gamepad — moves the same focus, so there is never a question of which
 * control is about to be activated.
 *
 * The top bar sits above the content, so the rule is simple: up from the top row of content moves
 * into the bar, down from the bar returns to the content. Left and right walk within whichever row
 * currently holds the focus.
 */

import { state } from './state.js';

/** The buttons in the bar, in the order left to right moves through them. */
const BAR_ITEMS = ['btn-settings', 'mode-tv', 'mode-tablet', 'btn-exit'];

/** Where the focus is: 'bar' or 'content'. */
let zone = 'content';

/** Index into BAR_ITEMS when the zone is 'bar'. */
let barIndex = 0;

/** Remembers the bar button the user was on, so coming back up returns to it. */
let lastBarIndex = 0;

/** Called when the focus enters the content, so the mode can highlight its own tile. */
let onContentFocus = () => {};
let onContentBlur = () => {};

export function configure(handlers) {
  onContentFocus = handlers.onFocus ?? (() => {});
  onContentBlur = handlers.onBlur ?? (() => {});
}

/** Elements the bar items map to. The mode switch holds two buttons, so they are looked up by mode. */
function elementFor(id) {
  switch (id) {
    case 'mode-tv':
      return document.querySelector('#mode-switch button[data-mode="tv"]');
    case 'mode-tablet':
      return document.querySelector('#mode-switch button[data-mode="tablet"]');
    default:
      return document.getElementById(id);
  }
}

/** The bar items that are actually present and visible. */
function visibleBarItems() {
  return BAR_ITEMS.filter((id) => {
    const el = elementFor(id);
    return el && !el.hidden && getComputedStyle(el).display !== 'none';
  });
}

function paint() {
  // Clear every ring first: only one element may be focused.
  document.querySelectorAll('.focus-ring').forEach((el) => el.classList.remove('focus-ring'));

  if (zone !== 'bar') {
    return;
  }

  const items = visibleBarItems();
  const id = items[Math.min(barIndex, items.length - 1)];
  elementFor(id)?.classList.add('focus-ring');
}

/** True when the focus is in the top bar. */
export function inBar() {
  return zone === 'bar';
}

/** Moves the focus into the bar, landing on the button the user last used. */
export function focusBar() {
  if (zone === 'bar') return false;

  zone = 'bar';

  const items = visibleBarItems();
  barIndex = Math.min(lastBarIndex, Math.max(0, items.length - 1));

  onContentBlur();
  paint();
  return true;
}

/** Moves the focus back into the content. */
export function focusContent() {
  if (zone === 'content') return false;

  zone = 'content';
  document.querySelectorAll('.focus-ring').forEach((el) => el.classList.remove('focus-ring'));

  onContentFocus();
  return true;
}

/**
 * Handles a key while the bar has focus.
 * Returns true when the key was consumed.
 */
export function handleBarKey(key) {
  if (zone !== 'bar') return false;

  const items = visibleBarItems();
  if (items.length === 0) {
    focusContent();
    return true;
  }

  switch (key) {
    case 'ArrowLeft':
      barIndex = (barIndex - 1 + items.length) % items.length;
      lastBarIndex = barIndex;
      paint();
      return true;

    case 'ArrowRight':
      barIndex = (barIndex + 1) % items.length;
      lastBarIndex = barIndex;
      paint();
      return true;

    case 'ArrowDown':
      focusContent();
      return true;

    case 'Enter':
    case 'Space':
      elementFor(items[barIndex])?.click();
      return true;

    case 'Escape':
      focusContent();
      return true;

    default:
      // Anything else is not the bar's business, but it should not leak into the content either
      // while the bar is focused.
      return true;
  }
}

/** The id of the button the bar focus is on, for diagnostics. */
export function focusedBarId() {
  if (zone !== 'bar') return null;
  const items = visibleBarItems();
  return items[Math.min(barIndex, items.length - 1)] ?? null;
}
