/*
 * Shared application state.
 *
 * One store, one render path. Both modes read the same app list and the same settings, so a change
 * made in the settings panel is visible in whichever mode is on screen without any syncing code.
 */

import { call } from './bridge.js';

/** Defaults for everything the settings panel can change. */
export const DEFAULTS = {
  mode: 'tablet',

  // The clock and date. Not per mode: there is one clock, and it should look the same whichever
  // mode is on screen.
  clock: {
    size: 40,      // px, the size of the time; the date scales from it
    x: 50,         // horizontal centre, as a % of the window width
    y: 52,         // vertical centre, in px from the top
    showDate: true
  },

  /**
   * Whether the launcher fills the whole screen.
   *
   * On by default, which suits a transparent taskbar: the taskbar draws on top of the launcher and
   * only its buttons show, so the wallpaper runs edge to edge. With an opaque taskbar this has to be
   * off, or the launcher covers the taskbar and every minimised window with it.
   */
  fullScreen: true,

  // Per mode, so tuning one never disturbs the other.
  tablet: {
    columns: 6,          // apps per row
    rows: 2,             // rows per page; columns * rows is how many apps fit on one page
    iconSize: 88,        // px, the icon glyph inside the card
    cardSize: 128,       // px, the white plate
    cardRadius: 26,      // px
    colGap: 32,          // px between columns
    rowGap: 44,          // px between rows
    captionSize: 15,     // px
    showPlate: true      // white rounded plate behind the icon
  },

  tv: {
    cardWidth: 620,      // px, the focused card
    overlap: 0.55,       // how much of each side card is hidden
    captionSize: 26,     // px
    groupY: 46,          // vertical position of the card group, as a % of the row's height
    captionY: 0          // extra offset of the name below the card group, in px
  }
};

/** The live state. Mutated in place so references stay valid. */
export const state = {
  apps: [],
  folder: '',
  settings: structuredClone(DEFAULTS),
  ready: false,

  /**
   * Card pictures, keyed by app id.
   *
   * `art` is the picture drawn behind a TV card; `icons` is the picture that replaces a card's
   * icon. They are separate because they are independent: a card can have either, both or neither,
   * and the two modes use them differently.
   *
   *   TV      background goes behind the icon, which stays on top
   *   tablet  the icon picture replaces the icon and its white plate
   */
  cardArt: {},
  cardIcons: {},

  /**
   * Flat background colours, keyed by app id.
   *
   * A card's background is either a picture or a colour, never both: setting one clears the other
   * on the host, so a card can be looked up in either map without ambiguity.
   */
  cardColours: {}
};

/** Loads the saved card pictures from the host. */
export async function loadCardArt() {
  try {
    const result = await call('cardArt');
    state.cardArt = result?.art ?? {};
    state.cardIcons = result?.icons ?? {};
    state.cardColours = result?.colours ?? {};
  } catch {
    state.cardArt = {};
    state.cardIcons = {};
    state.cardColours = {};
  }
}

/** Records a picture for one app. The host has already copied the file. */
export function setCardArt(appId, kind, url) {
  const map = kind === 'icon' ? state.cardIcons : state.cardArt;

  if (url) {
    map[appId] = url;
  } else {
    delete map[appId];
  }

  // A background picture and a background colour are mutually exclusive.
  if (kind === 'background' && url) {
    delete state.cardColours[appId];
  }
}

/** Records a flat background colour for one app. */
export function setCardColour(appId, colour) {
  if (colour) {
    state.cardColours[appId] = colour;
    delete state.cardArt[appId];
  } else {
    delete state.cardColours[appId];
  }
}

/** Reads the settings file, filling in anything missing. */
export async function loadSettings() {
  try {
    const result = await call('loadConfig');
    const saved = result?.config;

    if (saved) {
      // Merge rather than replace: a config written by an older build is missing newer keys, and
      // replacing outright would leave them undefined.
      state.settings = {
        ...structuredClone(DEFAULTS),
        ...saved,
        clock: { ...DEFAULTS.clock, ...(saved.clock || {}) },
        tablet: { ...DEFAULTS.tablet, ...(saved.tablet || {}) },
        tv: { ...DEFAULTS.tv, ...(saved.tv || {}) }
      };
    }
  } catch {
    // First run, or the host is unavailable: the defaults are correct anyway.
  }
}

export async function saveSettings() {
  try {
    await call('saveConfig', { config: state.settings });
  } catch {
    // A failed save must not break the interface.
  }
}

/** Scans the apps folder. */
export async function loadApps() {
  const result = await call('scan');
  state.apps = result.apps || [];
  state.folder = result.folder || '';
  state.ready = true;
  return state.apps;
}

/** Icons are fetched once per app and cached in the page, so switching modes is instant. */
const iconCache = new Map();

export async function iconFor(app) {
  if (iconCache.has(app.id)) return iconCache.get(app.id);

  const promise = call('icon', { path: app.path })
    .then((r) => (r.ok ? r.dataUrl : null))
    .catch(() => null);

  iconCache.set(app.id, promise);
  return promise;
}
