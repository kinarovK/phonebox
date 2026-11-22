import { cfg, h, ringSvg } from '../main.js';

/** Calls load() now and then every intervalMs while the widget is on a visible page. */
export function every(intervalMs, load, retryMs = 60_000) {
  let next = 0;
  return () => {
    if (Date.now() < next) return;
    next = Date.now() + intervalMs;
    // a load that returns false failed (offline, service down): try again soon, not after the whole interval
    Promise.resolve(load()).then((ok) => { if (ok === false) next = Math.min(next, Date.now() + retryMs); }, () => {});
  };
}

/** Gauge-style dial used by several widgets. */
export function dialEl() {
  const dial = h('div', 'g-dial'), val = h('div', 'g-val');
  dial.append(val);
  let svg = null;
  dial.set = (pct, text, unit, elapsed) => {
    if (svg) svg.remove();
    dial.insertAdjacentHTML('afterbegin', ringSvg(pct, elapsed)); // numbers only
    svg = dial.firstElementChild;
    val.replaceChildren(String(text), unit ? h('small', null, unit) : '');
  };
  return dial;
}

export function canKillAnywhere() {
  return (cfg.pages || []).some((p) => p.enabled !== false && (p.widgets || []).some((w) => w.type === 'processes' && w.options?.allowKill !== false));
}
