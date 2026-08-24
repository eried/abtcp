// Modal progress overlay for multi-step operations (auto-chain, fill gaps, recompute):
// dims the app, shows what is happening, how far it got and how long it has been running.

export function createBusy(el) {
  const box = el.querySelector('.busy-box');
  const titleEl = el.querySelector('.busy-title');
  const lineEl = el.querySelector('.busy-line');
  const barEl = el.querySelector('.busy-bar');
  const fillEl = el.querySelector('.busy-bar i');
  const logEl = el.querySelector('.busy-log');
  const elapsedEl = el.querySelector('.busy-elapsed');
  const stopBtn = el.querySelector('#busy-stop');
  let timer = null;
  let started = 0;
  let cancel = null;
  let done = 0;
  let total = 0;

  const tick = () => {
    const s = Math.round((Date.now() - started) / 1000);
    elapsedEl.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };

  stopBtn.addEventListener('click', () => {
    stopBtn.disabled = true;
    stopBtn.textContent = 'Stopping…';
    if (cancel) cancel();
  });

  return {
    get active() { return !el.hidden; },
    start({ title, total: t = 0, onCancel = null } = {}) {
      total = t;
      done = 0;
      cancel = onCancel;
      started = Date.now();
      titleEl.textContent = title || 'Working…';
      lineEl.textContent = 'Starting…';
      logEl.innerHTML = '';
      barEl.classList.toggle('indeterminate', !total);
      fillEl.style.width = total ? '0%' : '';
      stopBtn.disabled = !onCancel;
      stopBtn.textContent = 'Stop';
      el.hidden = false;
      tick();
      clearInterval(timer);
      timer = setInterval(tick, 250);
    },
    /** update({ done, text, log }) — `log` appends a line to the running list. */
    update({ done: d = null, text = null, log = null } = {}) {
      if (d != null) done = d;
      if (total) fillEl.style.width = `${Math.min(100, Math.round(done / total * 100))}%`;
      if (text != null) lineEl.textContent = total ? `${done}/${total} · ${text}` : `${done} added · ${text}`;
      if (log) {
        const li = document.createElement('li');
        li.textContent = log;
        logEl.prepend(li);
        while (logEl.children.length > 6) logEl.lastElementChild.remove();
      }
    },
    stop(summary = null) {
      clearInterval(timer);
      timer = null;
      cancel = null;
      if (summary) lineEl.textContent = summary;
      el.hidden = true;
    },
  };
}
