/*
 * The only channel to the host.
 *
 * Every call is a promise: the host replies to the id it was given, so a slow icon extraction can
 * never be mistaken for the answer to a different request. Nothing else in the UI knows how the
 * host works.
 */

const pending = new Map();
let nextId = 1;

// Events pushed by the host (keys it saw before the page did, status ticks).
const listeners = new Map();

function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(handler);
}

window.chrome?.webview?.addEventListener('message', (e) => {
  const message = e.data;

  if (!message) return;

  // Pushed event rather than a reply.
  if (message.event) {
    (listeners.get(message.event) || []).forEach((fn) => fn(message));
    return;
  }

  const entry = pending.get(message.id);
  if (!entry) return;

  pending.delete(message.id);

  if (message.ok) {
    entry.resolve(message.result);
  } else {
    // The type and location from the host are carried onto the error: without them every host
    // failure reads the same, which makes them impossible to tell apart while debugging.
    const error = new Error(message.error || 'host error');
    error.hostType = message.type;
    error.hostWhere = message.where;
    entry.reject(error);
  }
});

/** Calls a host command and resolves with its result. */
export function call(command, args = {}) {
  const id = String(nextId++);

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });

    // A missing bridge means the page is open outside the host (a plain browser), which is useful
    // during development.
    const webview = window.chrome?.webview;
    if (!webview) {
      pending.delete(id);
      reject(new Error('host bridge unavailable'));
      return;
    }

    webview.postMessage({ id, command, args });
  });
}

/** True when the page is running inside the launcher. */
export function hasHost() {
  return Boolean(window.chrome?.webview);
}

export { on };
