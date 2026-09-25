/*
 * The context menu for a card or tile.
 *
 * The menu is built from data so the same component serves both modes: TV cards offer a background
 * as well as an icon, tablet tiles offer only an icon, and the difference is simply which items are
 * passed in.
 */

let current = null;

/**
 * Shows the menu.
 *
 * @param {number} x  screen x of the click
 * @param {number} y  screen y of the click
 * @param {Array}  items  [{ label, onSelect, disabled }]
 */
export function showMenu(x, y, items) {
  hideMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';

  for (const item of items) {
    if (item.separator) {
      const line = document.createElement('div');
      line.className = 'context-separator';
      menu.append(line);
      continue;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'context-item';
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      hideMenu();
      item.onSelect?.();
    });

    menu.append(button);
  }

  document.body.append(menu);

  // Keep the menu inside the window: a click near the right or bottom edge would otherwise put
  // part of it off screen where it cannot be reached.
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);

  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  // Entering the menu makes it appear, so the transition runs.
  requestAnimationFrame(() => menu.dataset.open = 'yes');

  current = menu;

  return menu;
}

export function hideMenu() {
  if (current) {
    current.remove();
    current = null;
  }
}

export function isMenuOpen() {
  return current !== null;
}

/** Wires the global dismissal: any click elsewhere, Escape, or a scroll closes the menu. */
export function attachMenuDismissal() {
  document.addEventListener('pointerdown', (e) => {
    if (current && !current.contains(e.target)) {
      hideMenu();
    }
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) {
      hideMenu();
      e.stopPropagation();
    }
  }, true);

  window.addEventListener('blur', hideMenu);
}
