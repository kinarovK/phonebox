import { $, API, D, PANEL_HEADERS, Q_STYLE, api, bridge, color, cssVar, fillIcon, fmtDur, fmtMem, gpuMem, gpusOf, h, en, haptic, icon, openSheet, paceInfo, quotaProviders, r1, shortGpu, store, t, tick, toast, emo, labelled, rich, tp, tpv, quotaText } from '../main.js';
import { W } from '../registry.js';
import { canKillAnywhere, dialEl, every } from './helpers.js';

// Docker / Podman containers on the PC. Tap one for start / stop / restart (when the widget allows it).
W.docker = {
  needs: ['tick'],
  create(box, { o }) {
    const filter = String(o.filter || '').toLowerCase();
    let data = null, open = null, busy = null, lastKey = '';
    const list = h('div', 'dk-list'), head = h('div', 'w-title', o.title || en('Docker'), h('span', 'dk-count'));
    box.append(head, list);
    const act = async (c, action) => {
      haptic();
      busy = c.id; render(true);
      try {
        const r = await fetch(`${API}/docker/${encodeURIComponent(c.id)}/${action}`, { method: 'POST', cache: 'no-store', headers: PANEL_HEADERS });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) toast(j.error || `Could not ${action} ${c.name}`, 'err');
        else toast(`${c.name}: ${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}`, 'ok');
      } catch (_) { toast(t('panel.pcNoAnswer'), 'err'); }
      busy = null; open = null;
      await load(); render(true);
    };
    const load = async () => { try { data = await api('/docker'); } catch (_) {} };
    const render = (force = false) => {
      const snap = data?.snapshot;
      const matched = (snap?.containers || []).filter((c) => !filter
        || c.name.toLowerCase().includes(filter) || (c.project || '').toLowerCase().includes(filter));
      const items = o.stopped === false ? matched.filter((c) => c.state === 'running') : matched;
      const key = JSON.stringify([!!data, snap?.available, snap?.error, snap?.updated === 0, matched.length, items, data?.control, open, busy, box.clientHeight]);
      if (!force && key === lastKey) return;
      lastKey = key;
      const running = items.filter((c) => c.state === 'running').length;
      head.querySelector('.dk-count').textContent = snap?.available && (!snap.error || matched.length) ? ` ${running}/${matched.length}` : '';
      if (!data || (!snap?.updated && !snap?.error)) { list.replaceChildren(h('div', 'empty', t('w.loading'))); return; }
      if (!snap.available || (snap.error && !items.length)) { list.replaceChildren(h('div', 'empty', snap.error || tp('Docker is not running'))); return; }
      if (!items.length) {
        const msg = matched.length
          ? `No running containers (${matched.length} stopped)`
          : filter ? `No containers match "${o.filter}"` : 'No containers';
        list.replaceChildren(h('div', 'empty', msg));
        return;
      }
      list.replaceChildren(...items.map((c) => {
        const st = c.health === 'unhealthy' ? 'bad' : c.state === 'running' ? (c.health === 'starting' ? 'warn' : 'ok') : c.state === 'restarting' || c.state === 'paused' ? 'warn' : 'off';
        const row = h('div', 'dk-row ' + st + (open === c.id ? ' open' : ''),
          h('span', 'dk-dot'),
          h('span', 'dk-name', c.name, h('small', null, ' ' + (c.project ? c.project + ' · ' : '') + c.image.split('@')[0])),
          h('span', 'dk-stat', busy === c.id ? '…' : c.state === 'running' ? (c.cpu != null ? `${c.cpu.toFixed(1)}%` + (c.mem ? ` · ${c.mem}` : '') : c.status) : c.status.replace(/ ago$/, '')));
        row.addEventListener('click', () => {
          if (!data.control) { toast(tp('Turn on "Allow start / stop" in the widget settings on the PC')); return; }
          haptic(); open = open === c.id ? null : c.id; render(true);
        });
        if (open !== c.id) return row;
        const btn = (label, action, cls = '') => {
          const b = h('button', 'dk-btn ' + cls, label);
          b.addEventListener('click', (e) => { e.stopPropagation(); act(c, action); });
          return b;
        };
        return h('div', 'dk-wrap', row, h('div', 'dk-acts', ...(c.state === 'running' ? [btn('↻ Restart', 'restart'), btn('■ Stop', 'stop', 'danger')] : [btn('▶ Start', 'start', 'go')])));
      }));
    };
    const tick = every(4000, async () => { await load(); render(); });
    return { update: () => { tick(); render(); } };
  },
};

W.battery = {
  needs: ['tick'],
  create(box) {
    const dial = dialEl(), sub = h('div', 'g-sub');
    box.append(dial, h('div', 'g-label', tp('PHONE')), sub);
    const load = every(20_000, () => {
      if (!bridge) { dial.set(0, '—'); sub.textContent = tp('Only on the phone'); return; }
      try {
        const b = JSON.parse(bridge.battery());
        box.style.setProperty('--q', b.plugged ? '#22c55e' : b.level <= 20 ? '#ef4444' : b.level <= 40 ? '#f59e0b' : '#84cc16');
        dial.set(b.level, b.level, '%');
        sub.replaceChildren(rich((b.plugged ? '⚡ ' + tp('Charging') : tp('On battery')) + (b.temp ? ` · ${b.temp.toFixed(0)}°C` : '')));
      } catch (_) {}
    });
    return { update: load };
  },
};

W.topprocs = {
  needs: ['procs', 'state'],
  create(box, { o }) {
    const byMem = o.sort === 'mem';
    const list = h('div', 'tp-list');
    box.style.setProperty('--c', '#f472b6');
    const title = h('div', 'w-title', en(byMem ? 'Top memory' : 'Top CPU'));
    box.append(title, list);
    const rowMap = new Map();
    return {
      update() {
        const pc = D.state?.pc;
        if (byMem && pc?.ramTotalGb) {
          const pct = Math.round((pc.ramUsedGb / pc.ramTotalGb) * 100);
          title.replaceChildren(en('Top memory'), ` (${pct}% · ${Math.round(pc.ramUsedGb)}/${Math.round(pc.ramTotalGb)} GB)`);
        } else if (!byMem && pc?.cpu != null) {
          title.replaceChildren(en('Top CPU'), ` (${Math.round(pc.cpu)}%)`);
        }
        const data = D.procs;
        if (!data?.groups?.length) { rowMap.clear(); list.replaceChildren(h('div', 'empty', t('w.measuring'))); return; }
        if (list.querySelector('.empty')) list.replaceChildren();
        const n = Math.max(1, Math.floor((box.clientHeight - 30) / 24));
        const top = [...data.groups].sort((a, b) => (byMem ? b.memMb - a.memMb : b.cpu - a.cpu)).slice(0, n);
        const keep = new Set(top.map((g) => g.name));
        for (const [k, el] of rowMap) if (!keep.has(k)) { el.remove(); rowMap.delete(k); }
        for (const g of top) {
          let row = rowMap.get(g.name);
          if (!row) {
            const ico = h('div', 'p-ico');
            fillIcon(ico, g);
            row = h('div', 'tp-i', ico, h('span', 'tp-n'), h('b'));
            row.addEventListener('click', () => { haptic(); openSheet(row._g, canKillAnywhere()); });
            rowMap.set(g.name, row);
          }
          row._g = g;
          row.querySelector('.tp-n').textContent = g.title + (g.count > 1 ? ` ×${g.count}` : '');
          row.querySelector('b').textContent = byMem ? fmtMem(g.memMb) : g.cpu.toFixed(1) + '%';
          list.appendChild(row);
        }
      },
    };
  },
};

W.quotaring = {
  needs: ['quotas', 'tick'],
  create(box, { o }) {
    const prov = o.provider || 'claude', idx = Number(o.limit) || 0;
    const st = Q_STYLE[prov] || { color: '#94a3b8', logo: '●' };
    box.style.setProperty('--q', st.color);
    const dial = dialEl(), label = h('div', 'g-label'), sub = h('div', 'g-sub');
    box.append(dial, label, sub);
    let last = 0;
    const render = () => {
      const p = quotaProviders().find((x) => x.id === prov);
      const l = p?.limits?.[idx];
      if (!l) { dial.set(0, '—'); label.textContent = `${st.logo} ${p?.name || prov}`; sub.textContent = D.quotas ? tp('No data') : tp('Waiting…'); return; }
      const pace = paceInfo(l);
      dial.style.setProperty('--qc', l.percent >= 95 ? '#ef4444' : l.percent >= 80 ? '#f59e0b' : 'var(--q)');
      dial.set(l.percent, Math.round(l.percent), '%', pace?.elapsed);
      label.textContent = `${st.logo} ${p.name} · ${quotaText(l.label)}`;
      sub.textContent = l.resetsAt ? 'resets in ' + fmtDur(l.resetsAt - Date.now()) : '';
      sub.className = 'g-sub ' + (pace?.cls === 'over' ? 'hot' : '');
    };
    return { update(kind) { if (kind === 'tick' && Date.now() - last < 30_000) return; last = Date.now(); render(); } };
  },
};

W.volume = {
  needs: ['state'],
  create(box) {
    const fill = h('i'), bar = h('div', 'vb', fill), pct = h('div', 'vb-v', '--');
    const mute = labelled(h('button', 'pb', icon('volume-x')), t('w.a.mute')), down = h('button', 'pb', '−'), up = h('button', 'pb', '+');
    box.append(h('div', 'w-title', en('Volume')), h('div', 'vb-row', bar, pct), h('div', 'pomo-btns', mute, down, up));
    let dragging = false, timer = 0, dragEndTimer = 0, level = 0;
    const vertical = () => box.clientHeight > box.clientWidth * 1.15;
    const paint = (v, muted) => {
      level = v;
      box.classList.toggle('vert', vertical());
      fill.style[vertical() ? 'height' : 'width'] = v + '%';
      fill.style[vertical() ? 'width' : 'height'] = '100%';
      pct.textContent = muted ? 'muted' : v + '%';
      box.classList.toggle('muted', !!muted);
    };
    const fromPointer = (e) => {
      if ((!D.state?.audio || D.state.audio.canControl === false)) return;
      const r = bar.getBoundingClientRect();
      const f = vertical() ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
      const v = Math.round(Math.max(0, Math.min(1, f)) * 100);
      paint(v, false);
      clearTimeout(timer);
      timer = setTimeout(() => api('/volume?level=' + v, 'POST').catch(() => {}), 80);
    };
    bar.addEventListener('pointerdown', (e) => { clearTimeout(dragEndTimer); dragEndTimer = 0; dragging = true; try { bar.setPointerCapture(e.pointerId); } catch (_) {} fromPointer(e); });
    bar.addEventListener('pointermove', (e) => { if (dragging) fromPointer(e); });
    bar.addEventListener('pointerup', () => { clearTimeout(dragEndTimer); dragEndTimer = setTimeout(() => { dragEndTimer = 0; dragging = false; }, 400); });
    const cancelDrag = () => { clearTimeout(dragEndTimer); dragEndTimer = 0; clearTimeout(timer); dragging = false; };
    bar.addEventListener('pointercancel', cancelDrag);
    bar.addEventListener('lostpointercapture', () => { if (dragging && !dragEndTimer) dragging = false; });
    const op = (q) => async () => { haptic(); try { const a = await api('/volume?' + q, 'POST'); paint(a.volume, a.muted); } catch (_) {} };
    mute.addEventListener('click', op('op=mute'));
    down.addEventListener('click', op('op=down'));
    up.addEventListener('click', op('op=up'));
    return { update() {
      const a = D.state?.audio;
      box.classList.toggle('unavailable', (!a || a.canControl === false));
      mute.disabled = down.disabled = up.disabled = (!a || a.canControl === false);
      if (a && !dragging) paint(a.volume, a.muted);
      else if (!a) { pct.textContent = 'n/a'; fill.style.width = fill.style.height = '0'; }
    } };
  },
};

W.chargecare = {
  needs: ['tick'],
  create(box) {
    const C = 2 * Math.PI * 42;
    box.innerHTML = '<div class="w-title">Battery care</div><div class="cc-body"><div class="cc-wrap"><svg viewBox="0 0 100 100" class="cc-ring">' +
      '<circle class="cc-bg" cx="50" cy="50" r="42"/><circle class="cc-fg" cx="50" cy="50" r="42"/></svg>' +
      '<b class="cc-pct">—</b></div></div><div class="cc-sub"><span class="cc-state"></span> <span class="cc-text"></span></div>';
    const q = (s) => box.querySelector(s);
    const load = every(15_000, () => {
      if (!bridge?.battery) { q('.cc-pct').textContent = '—'; q('.cc-text').textContent = tp('Only on the phone'); return; }
      let b;
      try { b = JSON.parse(bridge.battery()); } catch (_) { return; }
      if (!(b.level >= 0)) return;
      q('.cc-fg').style.strokeDasharray = `${(C * b.level) / 100} ${C}`;
      q('.cc-pct').textContent = b.level + '%';
      q('.cc-state').replaceChildren(emo(b.plugged ? '⚡' : '🔋'));
      box.style.setProperty('--cc', b.level <= 20 ? '#ef4444' : b.plugged ? '#22c55e' : 'rgb(var(--ambient))');
      q('.cc-text').textContent = (b.plugged ? tp('Charging') : tp('On battery')) + (b.temp ? ` · ${b.temp.toFixed(0)} °C` : '');
    });
    return { update: load };
  },
};

// One GPU in detail: load, memory, temperatures, power, clocks and fan. NVIDIA comes from nvidia-smi; AMD and Intel
// from Windows' own GPU counters (temperature, VRAM, load), richer with LibreHardwareMonitor (hot spot, watts, fan, clocks).
const GPU_VENDOR = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple', qualcomm: 'Qualcomm' };
const GPU_SOURCE = { 'nvidia-smi': 'nvidia-smi', lhm: 'LibreHardwareMonitor', windows: 'Windows', sysfs: 'sysfs', ioreg: 'ioreg' };

W.gpu = {
  needs: ['state'],
  create(box, { o }) {
    const idx = Math.max(0, Math.min(3, Number(o.adapter) || 0));
    box.style.setProperty('--c', cssVar('--gpu'));
    const label = h('span', 's-label', 'GPU'), name = h('span', 's-name');
    const big = h('div', 'gd-big'), rows = h('div', 'meters gd-rows'), chips = h('div', 'chips gd-chips');
    box.append(h('div', 's-head', label, name), big, rows, chips);
    const meter = (title, txt, pct, c) => {
      const e = h('div', 'meter', h('div', 'm-row', h('span', null, title), h('span', null, txt)), h('div', 'track', h('i')));
      e.querySelector('i').style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
      if (c) e.style.setProperty('--c', c);
      return e;
    };
    const heat = (t, max) => (t >= max - 5 ? '#ef4444' : t >= max - 15 ? '#f59e0b' : '#f97316');
    return {
      update() {
        const g = gpusOf(D.state)[idx];
        if (!g) {
          label.textContent = 'GPU';
          name.textContent = '';
          big.replaceChildren(h('div', 'empty', !D.state ? tp('Waiting…') : idx ? tp('No second GPU') : tp('No GPU data')));
          rows.replaceChildren();
          chips.replaceChildren();
          return;
        }
        label.textContent = (GPU_VENDOR[g.vendor] || 'GPU') + (g.integrated ? ' · iGPU' : '');
        name.textContent = shortGpu(g.name);
        name.title = g.name;

        const temps = [g.temp != null ? `${Math.round(g.temp)}°C` : null, g.hotSpot != null ? tpv('hot spot {n}°', { n: Math.round(g.hotSpot) }) : null,
          g.memTemp != null ? tpv('memory {n}°', { n: Math.round(g.memTemp) }) : null].filter(Boolean).join(' · ');
        big.replaceChildren(h('b', null, g.util != null ? String(Math.round(g.util)) : '—'), h('small', null, tp('% load')), h('span', 'gd-temp', temps));

        const list = [];
        const mem = gpuMem(g);
        if (mem) list.push(meter(mem.label === 'VRAM' ? 'VRAM' : tp('GPU memory'), `${r1(mem.used)} / ${Math.round(mem.total)} GB`, (mem.used / mem.total) * 100));
        if (!g.integrated && g.sharedTotal && g.sharedUsed != null) list.push(meter(tp('Shared memory'), `${r1(g.sharedUsed)} GB`, (g.sharedUsed / g.sharedTotal) * 100, '#64748b'));
        if (g.power != null) {
          list.push(meter(tp('Power'), g.powerLimit ? `${Math.round(g.power)} / ${Math.round(g.powerLimit)} W` : `${Math.round(g.power)} W`,
            g.powerLimit ? (g.power / g.powerLimit) * 100 : g.powerPct, '#facc15'));
        } else if (g.powerPct != null) list.push(meter(tp('Power'), tpv('{n}% of limit', { n: Math.round(g.powerPct) }), g.powerPct, '#facc15'));
        const hottest = Math.max(g.temp ?? -1, g.hotSpot ?? -1);
        if (hottest >= 0) {
          const max = g.tempMax || (g.hotSpot != null ? 110 : 100);
          list.push(meter(tp('Temperature'), `${Math.round(hottest)} / ${Math.round(max)}°C`, (hottest / max) * 100, heat(hottest, max)));
        }
        rows.replaceChildren(...list);

        chips.replaceChildren(...[
          g.clock != null ? `Core ${Math.round(g.clock)} MHz` : null,
          g.memClock != null ? `Memory ${Math.round(g.memClock)} MHz` : null,
          g.fan != null || g.fanRpm != null ? `Fan ${[g.fan != null ? Math.round(g.fan) + '%' : null, g.fanRpm != null ? Math.round(g.fanRpm) + ' rpm' : null].filter(Boolean).join(' · ')}` : null,
          g.driver ? `Driver ${g.driver}` : null,
          g.source ? g.source.split('+').map((x) => GPU_SOURCE[x] || x).join(' + ') : null,
        ].filter(Boolean).map((t) => h('span', 'chip', t)));
      },
    };
  },
};
