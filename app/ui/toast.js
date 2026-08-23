// Non-blocking notifications and a two-click confirmation helper (no window.confirm — it
// blocks automation and is easy to mis-click).

export function createToast(el) {
  let timer = null;
  return {
    show(msg, { level = 'info', ms = 4000 } = {}) {
      el.textContent = msg;
      el.className = `toast show ${level}`;
      clearTimeout(timer);
      timer = setTimeout(() => { el.className = 'toast'; }, ms);
    },
    error(msg) { this.show(msg, { level: 'error', ms: 6000 }); },
    success(msg) { this.show(msg, { level: 'success' }); },
  };
}

/** First click arms the button (label changes), second click within `ms` runs `fn`. */
export function armConfirm(button, fn, { label = 'Click again to confirm', ms = 4000 } = {}) {
  if (button.dataset.armed === '1') {
    button.dataset.armed = '';
    button.textContent = button.dataset.label;
    fn();
    return;
  }
  button.dataset.label = button.textContent;
  button.dataset.armed = '1';
  button.textContent = label;
  setTimeout(() => { if (button.dataset.armed === '1') { button.dataset.armed = ''; button.textContent = button.dataset.label; } }, ms);
}
