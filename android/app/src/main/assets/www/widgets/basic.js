import { $, D, LOCALE, METRICS, Q_STYLE, S_ORDER, ago, api, cfg, chart, color, cssVar, currentProcessesSort, fillIcon, fmtDur, fmtMem, fmtReset, gotoProcesses, gpuMem, gpusOf, h, haptic, hasProcessesPage, hist, hour12, icon, metricText, openSheet, paceInfo, pad, prRow, quotaProviders, r1, registerProcessesSorter, renderStatus, ringSvg, shortDur, shortGpu, t, tick, emo, rich, tp, tpv, quotaText } from '../main.js';
import { W } from '../registry.js';

function bindProcessLink(box, sortTarget) {
  if (!hasProcessesPage()) return;
  box.style.cursor = 'pointer';
  box.addEventListener('click', () => {
    if (!hasProcessesPage()) return;
    haptic();
    gotoProcesses(sortTarget);
  });
}

// ================================================================= widgets
// Each widget: { needs: [data kinds], bare?: no card background, create(box, ctx) -> { update(kind) } }
// Data kinds: tick (every second), fast (4×/s), state, quotas, work, procs.

W.clock = {
  bare: true, needs: ['tick', 'state', 'quotas', 'work'],
  create(box, { o }) {
    const status = o.status !== false ? h('div', 'status') : null;
    const hh = h('span', 'hh', '--'), colon = h('span', 'colon', ':'), mm = h('span', 'mm', '--'), ss = h('span', 'sec'), ap = h('span', 'ap');
    const date = o.date !== false ? h('div', 'date') : null;
    box.append(status || '', h('div', 'clock', hh, colon, mm, ss, ap), date || '');
    box.style.setProperty('--tf', (0.84 - (status ? 0.1 : 0) - (date ? 0.11 : 0)).toFixed(2));
    return {
      update(kind) {
        if (kind === 'tick') {
          const now = new Date();
          const H = now.getHours(), h12 = hour12();
          hh.textContent = h12 ? String(H % 12 || 12) : pad(H);
          ap.textContent = h12 ? (H < 12 ? 'AM' : 'PM') : '';
          mm.textContent = pad(now.getMinutes());
          ss.textContent = cfg.display?.showSeconds === false ? '' : pad(now.getSeconds());
          // the colon blinks once a second from here, not from a CSS animation: a running animation makes the browser draw a frame
          // on every display refresh (120 a second on some phones) for something that changes once a second
          colon.classList.toggle('dim', now.getSeconds() % 2 === 1);
          if (date) date.textContent = now.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
          if (status && now.getSeconds() % 30 === 0) renderStatus(status, o); // battery
        } else if (status) renderStatus(status, o);
      },
    };
  },
};

W.stat = {
  needs: ['state'],
  create(box, { o }) {
    const m = METRICS[o.metric] || METRICS.cpu;
    const c = color(m.color);
    box.style.setProperty('--c', c);
    const canvas = h('canvas');
    const lbl = h('div', 't-label', tp(m.label));
    const val = h('b', null, '—'), unit = h('small'), sub = h('div', 't-sub', ' ');
    box.append(canvas, lbl, h('div', 't-val', val, unit), sub);
    if (o.metric === 'cpu' || o.metric === 'ram') bindProcessLink(box, o.metric === 'cpu' ? 'cpu' : 'mem');
    return {
      update() {
        const s = D.state;
        if (!s) return;
        const [v, u] = metricText(m, s);
        val.textContent = v;
        unit.textContent = u;
        const pctVal = m.pct?.(s);
        lbl.textContent = pctVal != null && m.label === 'RAM' ? `RAM (${Math.round(pctVal)}%)` : tp(m.label);
        sub.textContent = m.sub?.(s) || ' ';
        chart(canvas, [{ data: hist[m.hist || o.metric] || hist.cpu, color: c, max: m.max(s) }]);
      },
    };
  },
};

W.gauge = {
  needs: ['state'],
  create(box, { o }) {
    const m = METRICS[o.metric] || METRICS.cpu;
    box.style.setProperty('--q', color(m.color));
    const dial = h('div', 'g-dial'), pct = h('div', 'g-val'), sub = h('div', 'g-sub');
    box.append(dial, h('div', 'g-label', tp(m.label)), sub);
    dial.append(pct);
    if (o.metric === 'cpu' || o.metric === 'ram') bindProcessLink(box, o.metric === 'cpu' ? 'cpu' : 'mem');
    let svg = null;
    return {
      update() {
        const s = D.state;
        if (!s) return;
        const raw = m.pct ? m.pct(s) : m.val(s);
        const p = raw == null ? 0 : (raw / (m.pct ? 100 : m.max(s))) * 100;
        const warn = m.hot ? (raw > m.hot[1] ? '#ef4444' : raw > m.hot[0] ? '#f59e0b' : '') : (p >= 95 ? '#ef4444' : p >= 85 ? '#f59e0b' : '');
        dial.style.setProperty('--qc', warn || 'var(--q)');
        if (svg) svg.remove();
        dial.insertAdjacentHTML('afterbegin', ringSvg(p));
        svg = dial.firstElementChild;
        const [v, u] = metricText(m, s);
        pct.replaceChildren(v, h('small', null, u));
        sub.textContent = m.sub?.(s) || '';
      },
    };
  },
};

W.chart = {
  needs: ['state'],
  create(box, { o }) {
    // a list of only unknown names falls back like no list at all; own keys only, so "constructor" is unknown too
    const keys = (Array.isArray(o.metrics) && o.metrics.length ? o.metrics : ['cpu']).filter((k) => Object.prototype.hasOwnProperty.call(METRICS, k));
    if (!keys.length) keys.push('cpu');
    const single = keys.length === 1 ? METRICS[keys[0]] : null;
    const isNet = keys.every((k) => k === 'down' || k === 'up');
    const label = single ? tp(single.name) : isNet ? tp('Network') : keys.map((k) => tp(METRICS[k].name)).join(' · ');
    box.style.setProperty('--c', color((single || METRICS[keys[0]]).color));
    const head = h('div', 's-head', h('span', 's-label', label), h('span', 's-name', ''));
    const main = h('div', 's-main');
    const canvas = h('canvas');
    box.append(head, main, canvas);
    if (keys.includes('cpu') || keys.includes('ram')) bindProcessLink(box, keys.includes('cpu') ? 'cpu' : 'mem');
    return {
      update() {
        const s = D.state;
        if (!s) return;
        if (single) {
          const [v, u] = metricText(single, s);
          main.replaceChildren(h('b', null, v), h('small', null, u), h('span', 'chips', single.sub?.(s) ? h('span', 'chip', single.sub(s)) : ''));
          head.lastChild.textContent = single.title?.(s) || '';
        } else {
          main.replaceChildren(...keys.map((k) => {
            const mm = METRICS[k];
            const [v, u] = metricText(mm, s);
            const e = h('span', 'multi', (k === 'down' ? '↓ ' : k === 'up' ? '↑ ' : tp(mm.label) + ' '), h('b', null, v + ' ' + u));
            e.style.color = color(mm.color);
            return e;
          }));
          head.lastChild.textContent = isNet && s.ping ? tpv('Ping {ms} · loss {loss}%', { ms: s.ping.ms != null ? Math.round(s.ping.ms) + ' ms' : '—', loss: s.ping.lossPct }) : '';
        }
        chart(canvas, keys.map((k) => ({ data: hist[METRICS[k].hist || k], color: color(METRICS[k].color), max: METRICS[k].max(s) })), { grid: true });
      },
    };
  },
};

W.meters = {
  needs: ['state'],
  create(box) {
    box.style.setProperty('--c', cssVar('--ram'));
    const up = h('span', 's-name');
    const list = h('div', 'meters');
    box.append(h('div', 's-head', h('span', 's-label', t('w.memory')), up), list);
    bindProcessLink(box, 'mem');
    const meter = (name, txt, pct, c) => {
      const e = h('div', 'meter', h('div', 'm-row', h('span', null, name), h('span', null, txt)), h('div', 'track', h('i')));
      e.querySelector('i').style.width = Math.min(100, pct) + '%';
      if (c) e.style.setProperty('--c', c);
      return e;
    };
    return {
      update() {
        const pc = D.state?.pc;
        if (!pc) return;
        const s = pc.uptimeSec, d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
        up.textContent = tp('Up ') + (d ? `${d} d ${hr} h` : hr ? `${hr} h ${m} min` : `${m} min`);
        const rows = [meter('RAM', `${r1(pc.ramUsedGb)} / ${Math.round(pc.ramTotalGb)} GB`, (pc.ramUsedGb / pc.ramTotalGb) * 100)];
        // one row per GPU (the integrated one counts its shared memory); named once there is more than one
        const gpus = gpusOf(D.state);
        for (const g of gpus) {
          const m = gpuMem(g);
          if (m) rows.push(meter(gpus.length > 1 ? `${m.label === 'VRAM' ? 'VRAM' : 'GPU'} · ${shortGpu(g.name)}` : m.label === 'VRAM' ? 'VRAM' : tp('GPU MEMORY'),
            `${r1(m.used)} / ${Math.round(m.total)} GB`, (m.used / m.total) * 100, cssVar('--gpu')));
        }
        const disks = h('div', 'disks', ...(pc.disks || []).map((dk) => meter(dk.name === '/' ? tp('DISK') : dk.name, Math.round((dk.usedGb / dk.totalGb) * 100) + '%', (dk.usedGb / dk.totalGb) * 100, '#94a3b8')));
        list.replaceChildren(...rows, disks);
      },
    };
  },
};

W.quotas = {
  needs: ['quotas', 'tick'],
  /**
   * Creates the AI Quotas widget instance with optional paged provider rotation.
   */
  create(box, { o }) {
    const tokens = (n) => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
    const grid = h('div', 'q-grid', h('div', 'empty', tp('Quota data arrives once the computer is connected.')));
    box.append(grid);
    let last = 0;
    let offset = 0;
    let lastRotate = Date.now();

    const isRotateEnabled = () => {
      if (o.rotate !== undefined && o.rotate !== null) return !!o.rotate;
      if (cfg.codexBar?.rotate !== undefined && cfg.codexBar?.rotate !== null) return !!cfg.codexBar.rotate;
      return true;
    };

    const getPageSize = () => {
      if (o.pageSize !== undefined && o.pageSize !== null && o.pageSize !== '') {
        const n = Number(o.pageSize);
        return Number.isFinite(n) ? Math.max(0, Math.min(6, Math.floor(n))) : 2;
      }
      return cfg.codexBar?.pageSize ?? 2;
    };

    const getRotateInterval = () => {
      if (!isRotateEnabled()) return 0;
      if (o.rotateInterval !== undefined && o.rotateInterval !== null && o.rotateInterval !== '') {
        const n = Number(o.rotateInterval);
        return Number.isFinite(n) ? Math.max(2, Math.min(300, n)) : 8;
      }
      return cfg.codexBar?.rotateInterval ?? 8;
    };

    const getProviders = () => {
      if (Array.isArray(o.providers)) return o.providers;
      if (Array.isArray(cfg.codexBar?.providers)) return cfg.codexBar.providers;
      return ['claude', 'codex', 'antigravity'];
    };

    const isOverviewEnabled = () => o.showOverview === true;

    const getItems = () => {
      const want = getProviders();
      const items = quotaProviders().filter((p) => want.includes(p.id));
      if (isOverviewEnabled() && D.quotas?.overview) {
        return [{ id: '__overview__', isOverview: true, overview: D.quotas.overview }, ...items];
      }
      return items;
    };

    const fmtCurrency = (amount, code = 'USD') => {
      const n = Number(amount || 0);
      const cur = (code || 'USD').toUpperCase();
      try { return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: cur }).format(n); }
      catch (_) { return `${cur === 'USD' ? '$' : cur + ' '}${n.toFixed(2)}`; }
    };

    const renderOverviewCard = (ov, flexVal) => {
      const card = h('div', 'q-card q-overview-card');
      card.style.setProperty('--q', '#f97316');
      card.style.flex = flexVal;
      const days = ov.windowDays || 30;
      const age = ov.updatedAt ? Math.max(0, Date.now() - ov.updatedAt) : null;
      const updStr = age != null ? `checked ${age < 60_000 ? 'just now' : fmtDur(age) + ' ago'}` : '';
      card.appendChild(h('div', 'q-head',
        h('span', 'q-logo', emo('📊')),
        h('span', 'q-name', tp('Overview')),
        h('span', 'q-plan', `${days}-day spend`),
        updStr ? h('span', 'q-upd', updStr) : null
      ));
      const summary = h('div', 'q-ov-hero',
        h('div', 'q-ov-stat', h('span', 'q-ov-lbl', tp('Estimated spend')), h('strong', 'q-ov-val', fmtCurrency(ov.totalCost, ov.currencyCode))),
        h('div', 'q-ov-stat', h('span', 'q-ov-lbl', tp('Recorded tokens')), h('strong', 'q-ov-val', tokens(ov.totalTokens || 0)))
      );
      card.appendChild(summary);
      const details = h('div', 'q-details q-ov-details');
      for (const s of (ov.subscriptions || []).slice(0, 3)) {
        details.appendChild(h('div', 'q-detail',
          h('span', null, s.name),
          h('strong', null, `${tokens(s.tokens)} · ${fmtCurrency(s.cost, s.currencyCode || ov.currencyCode)}`)
        ));
      }
      for (const m of (ov.topModels || []).slice(0, 2)) {
        details.appendChild(h('div', 'q-detail q-breakdown',
          h('span', null, m.modelName || m.name),
          h('strong', null, fmtCurrency(m.cost, m.currencyCode || ov.currencyCode))
        ));
      }
      if (details.childNodes.length) card.appendChild(details);
      const count = ov.providerCount ?? (ov.subscriptions || []).length;
      card.appendChild(h('div', 'q-foot', h('span', null, `${count} ${count === 1 ? 'provider' : 'providers'}`), h('span')));
      return card;
    };

    const render = () => {
      if (!D.quotas) return;
      const want = getProviders();
      const list = getItems();
      grid.replaceChildren();
      if (!list.length) { grid.appendChild(h('div', 'empty', want.length ? tp('Quota data is unavailable for the selected providers') : tp('No quota providers enabled'))); return; }

      const ps = getPageSize();
      const needsPaging = isRotateEnabled() && ps > 0 && list.length > ps;
      if (offset >= list.length) offset = 0;

      let visible = list;
      if (needsPaging) {
        visible = [];
        for (let i = 0; i < ps; i++) {
          visible.push(list[(offset + i) % list.length]);
        }
      }

      for (const p of visible) {
        if (p.isOverview) {
          grid.appendChild(renderOverviewCard(p.overview, needsPaging && ps === 2 ? '1 1 0' : '1.5'));
          continue;
        }
        const st = Q_STYLE[p.id] || { color: '#94a3b8', logo: '●' };
        const card = h('div', 'q-card' + (p.limits.length >= 4 ? ' q-card-compact' : ''));
        card.style.setProperty('--q', st.color);
        card.style.flex = needsPaging && ps === 2 ? '1 1 0' : String(Math.max(1, p.limits.length) + 0.3);
        card.appendChild(h('div', 'q-head', h('span', 'q-logo', st.logo), h('span', 'q-name', p.name), h('span', 'q-plan', p.plan),
          p.updatedAt ? h('span', 'q-upd', fmtDur(Date.now() - p.updatedAt) + ' ago') : null));
        const compact = p.limits.length >= 4;
        const rings = h('div', 'q-rings' + (compact ? ' q-rings-grid' : ''));
        for (const l of p.limits) {
          const pace = paceInfo(l);
          const dial = h('div', 'q-dial');
          if (compact) {
            dial.style.width = '86px';
            dial.style.height = '86px';
          }
          if (l.percent >= 95 || l.severity === 'critical') dial.style.setProperty('--qc', '#ef4444');
          else if (l.percent >= 80 || l.severity === 'warning') dial.style.setProperty('--qc', '#f59e0b');
          dial.innerHTML = ringSvg(l.percent, pace?.elapsed); // numbers only
          const pctEl = h('div', 'q-pct', String(Math.round(l.percent)), h('small', null, '%'));
          if (compact) pctEl.style.fontSize = 'calc(22px * var(--widget-font-scale, 1))';
          dial.appendChild(pctEl);
          rings.appendChild(h('div', 'q-ring', dial, h('div', 'q-label', quotaText(l.label)), p.id === 'codex' ? h('div', 'q-left', tpv('{n}% left', { n: Math.max(0, Math.round(100 - l.percent)) })) : null, h('div', 'q-reset', fmtReset(l.resetsAt)),
            pace ? h('div', 'q-pace ' + pace.cls, pace.text) : null));
        }
        if (!p.limits.length) rings.appendChild(h('div', 'q-reset', tp('No data')));
        card.append(rings);
        if (p.id === 'codex' && p.codex) {
          const c = p.codex;
          const details = h('div', 'q-details');
          if (c.model) details.append(h('div', 'q-detail', h('span', null, tp('Latest local session')), h('strong', null, c.model + (c.effort ? ` · ${c.effort}` : ''))));
          if (c.totalTokens != null) details.append(h('div', 'q-detail', h('span', null, tp('Session tokens')), h('strong', null, tokens(c.totalTokens))));
          if (c.totalInput != null || c.totalOutput != null) details.append(h('div', 'q-detail q-breakdown', tpv('In {in} · Out {out} · Cached {cached} · Reasoning {reasoning}', { in: tokens(c.totalInput), out: tokens(c.totalOutput), cached: tokens(c.totalCached), reasoning: tokens(c.totalReasoning) })));
          if (c.lastInput != null && c.contextWindow) details.append(h('div', 'q-detail q-breakdown', tpv('Last input {n} / {max} context window', { n: tokens(c.lastInput), max: tokens(c.contextWindow) })));
          if (details.childNodes.length) card.append(details);
        }
        card.append(h('div', 'q-foot', h('span', p.extra?.startsWith('Limit reached') ? 'q-alert' : null, quotaText(p.extra) || ''), p.error ? h('span', 'q-err', p.error) : h('span')));

        grid.appendChild(card);
      }

      if (needsPaging) {
        const dots = h('div', 'q-dots');
        for (let i = 0; i < list.length; i++) {
          const dot = h('span', 'q-dot' + (i === offset ? ' active' : ''));
          dot.onclick = (e) => {
            e.stopPropagation();
            offset = i;
            lastRotate = Date.now();
            render();
            haptic();
          };
          dots.appendChild(dot);
        }
        grid.appendChild(dots);
      }
    };

    grid.onclick = () => {
      const ps = getPageSize();
      const list = getItems();
      if (ps > 0 && list.length > ps) {
        offset = (offset + 1) % list.length;
        lastRotate = Date.now();
        render();
        haptic();
      }
    };

    /**
     * Checks whether an enclosing Smart Stack widget has paused rotation.
     */
    const isStackPaused = () => box.closest('.w-stack')?.dataset.stackPaused === '1';

    return {
      /**
       * Updates quota display and advances paged provider rotation on ticks.
       */
      update(kind) {
        if (kind === 'tick') {
          const sec = getRotateInterval();
          if (isStackPaused()) {
            lastRotate = Date.now();
          } else if (sec > 0 && Date.now() - lastRotate >= sec * 1000) {
            const ps = getPageSize();
            const list = getItems();
            if (ps > 0 && list.length > ps) {
              offset = (offset + 1) % list.length;
              lastRotate = Date.now();
              render();
            }
          }
          if (Date.now() - last > 30_000) { last = Date.now(); render(); }
          return;
        }
        last = Date.now();
        render();
      },
    };
  },
};

W.codexbar = W.quotas;

W.sessions = {
  needs: ['work', 'tick'],
  create(box) {
    const sum = h('span', 'w-sum');
    const list = h('div', 's-list', h('div', 'empty', t('sess.waitingData')));
    box.append(h('div', 'w-head', h('span', 's-label', t('w.sessions')), sum), list);
    box.style.setProperty('--c', '#d97757');
    const tokens = (n) => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
    const statusText = (s) => s.status === 'busy' ? t('sess.working') : s.status === 'waiting' ? t('sess.waiting') : s.status === 'shell' ? t('sess.shell') : s.outcome === 'completed' ? t('sess.completed') : s.outcome === 'failed' ? t('sess.failed') : s.outcome === 'aborted' ? t('sess.aborted') : t('sess.idle');
    // The tool each session comes from: one glyph in the list, a glyph and a name in the details panel.
    const toolIcon = (tool) => tool === 'claude' ? '✳' : tool === 'codex' ? '◎' : tool === 'cursor' ? '◆' : tool === 'antigravity' ? Q_STYLE.antigravity.logo : '◎';
    const toolTitle = (tool) => tool === 'claude' ? 'Claude Code' : tool === 'codex' ? 'Codex' : tool === 'cursor' ? 'Cursor' : tool === 'antigravity' ? 'Antigravity' : 'Codex';
    const ageText = (since) => Date.now() - since < 60_000 ? 'just now' : shortDur(Date.now() - since) + ' ago';
    // A session's title is the main label and the project folder goes under it: Claude Code sends it only while
    // Settings › Claude Code › "Show session titles on the phone" is on, and Antigravity only while "Show Antigravity
    // chat titles on the phone" is on; without a title
    // the folder is the label, as before.
    const titleOf = (s) => s.title || s.project || s.name;
    const folderOf = (s) => (s.title ? s.project : '');
    // A Claude Code chat's recent steps, last exchange and message list. The agent sends them only when Settings › Claude Code
    // › "Show the conversation on the phone" is on. Returns the function that stops the refresh.
    const conversationSection = (panel, s) => {
      const box = h('div', 'session-conv');
      panel.append(box);
      let data = null, expanded = false, gone = false, asked = 0, applied = 0;
      let labels = []; // the time label of each step on screen, so they can move on without drawing everything again
      const stepAge = (st) => (st.running ? (st.at ? 'running ' + shortDur(Date.now() - st.at) : 'running') : st.at ? ageText(st.at) : '');
      const refreshLabels = () => { for (const [el, st] of labels) el.textContent = stepAge(st); };
      const toolName = (n) => n.startsWith('mcp__') ? n.slice(5).replace(/__/g, ' › ') : n;
      const clip = (text, n) => text.length > n ? text.slice(0, n) + '…' : text;
      const message = (m, full) => h('div', 'conv-msg ' + m.role,
        h('span', 'conv-who', m.role === 'user' ? tp('You') : 'Claude'),
        h('div', full ? 'conv-text' : 'conv-text clamp', full ? m.text : clip(m.text, 500)));
      const render = () => {
        const prevList = box.querySelector('.conv-list');
        const top = prevList ? prevList.scrollTop : null;
        labels = [];
        if (!data.enabled) {
          box.replaceChildren(h('p', 'session-note', tp('The conversation is off. Turn it on in Settings › Claude Code › Show the conversation on the phone.')));
          return;
        }
        const messages = data.messages || [], steps = data.steps || [];
        const kids = [];
        if (steps.length) {
          kids.push(h('div', 'conv-h', tp('Recent steps')));
          for (const st of [...steps].reverse().slice(0, 6)) {
            const age = h('span', 'cs-a', stepAge(st));
            labels.push([age, st]);
            kids.push(h('div', 'conv-step' + (st.running ? ' on' : ''), h('span', 'cs-t', toolName(st.tool)), h('span', 'cs-d', st.detail || ''), age));
          }
        }
        if (!messages.length) kids.push(h('p', 'session-note', tp('No messages yet.')));
        else if (expanded) {
          kids.push(h('div', 'conv-h', tp('Conversation')), h('div', 'conv-list', messages.map((m) => message(m, true))));
        } else {
          const lastOf = (role) => [...messages].reverse().find((m) => m.role === role);
          kids.push(h('div', 'conv-h', tp('Last exchange')));
          for (const m of [lastOf('user'), lastOf('assistant')]) if (m) kids.push(message(m, false));
        }
        if (messages.length) {
          const toggle = h('button', 'conv-toggle', expanded ? 'Hide the conversation' : `Show the conversation (${messages.length})`);
          toggle.type = 'button';
          toggle.addEventListener('click', () => { haptic(); expanded = !expanded; render(); });
          kids.push(toggle);
        }
        box.replaceChildren(...kids);
        const list = box.querySelector('.conv-list');
        if (list) list.scrollTop = top ?? list.scrollHeight; // a new view starts at the newest message
      };
      const load = async () => {
        const mine = ++asked;
        try {
          const d = await api('/work/conversation?id=' + encodeURIComponent(s.id), 'GET', 5000);
          // A slower earlier request can finish after a newer one: its answer is older, and must not replace it (for
          // example a "turned off" answer that has already been shown).
          if (gone || mine < applied) return;
          applied = mine;
          // the messages are drawn again only when they changed, to keep the scroll position and the focus; the ages
          // of the steps move on with the clock either way
          if (JSON.stringify(d) !== JSON.stringify(data)) { data = d; render(); } else refreshLabels();
        } catch (_) {
          if (!gone && !data) box.replaceChildren(h('p', 'session-note', tp('Could not read the conversation.')));
        }
      };
      load();
      const timer = setInterval(load, 3000);
      return () => { gone = true; clearInterval(timer); };
    };
    const openDetails = (s) => {
      haptic();
      const backdrop = h('div', 'session-backdrop');
      const panel = h('div', 'session-panel');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      const title = h('h2', null, titleOf(s));
      const close = h('button', 'session-close', icon('x'));
      close.setAttribute('aria-label', tp('Close session details'));
      let stopConversation = () => {};
      const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
      const dismiss = () => { stopConversation(); backdrop.remove(); document.removeEventListener('keydown', onKey); };
      close.addEventListener('click', dismiss);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
      panel.append(h('div', 'session-panel-head', h('span', null, toolIcon(s.tool) + ' ' + toolTitle(s.tool)), close), title);
      const rows = [
        ['Folder', folderOf(s) || null],
        ['Status', statusText(s)],
        ['Started', s.startedAt ? ageText(s.startedAt) : null],
        ['Last activity', s.since ? ageText(s.since) : null],
        ['Current turn', s.status === 'busy' && s.turnStartedAt ? shortDur(Date.now() - s.turnStartedAt) : null],
        ['Model', s.model], ['Reasoning', s.effort],
        ['Session tokens', s.totalTokens != null ? tokens(s.totalTokens) : null],
        ['Input / output', s.inputTokens != null || s.outputTokens != null ? `${tokens(s.inputTokens)} / ${tokens(s.outputTokens)}` : null],
        ['Cached input', s.cachedInputTokens != null ? tokens(s.cachedInputTokens) : null],
        ['Reasoning output', s.reasoningTokens != null ? tokens(s.reasoningTokens) : null],
        ['Last input / context window', s.lastInputTokens != null && s.contextWindow ? `${tokens(s.lastInputTokens)} / ${tokens(s.contextWindow)}` : null],
        ['Recent tool', s.lastTool],
      ];
      // a small label over each value, four to a row: the facts take one line instead of four
      panel.append(h('div', 'session-grid', rows.filter(([, value]) => value != null)
        .map(([label, value]) => h('div', 'session-cell', h('span', null, tp(label)), h('strong', null, value)))));
      if (s.tool === 'codex' || (s.tool === 'antigravity' && s.totalTokens != null)) panel.append(h('p', 'session-note', tp('Token totals are for this local session, not your account allowance.')));
      if (s.tool === 'claude') stopConversation = conversationSection(panel, s);
      backdrop.append(panel);
      document.body.append(backdrop);
      close.focus();
      document.addEventListener('keydown', onKey);
    };
    return {
      update() {
        const sessions = D.work?.sessions;
        if (!sessions) return;
        const counts = { waiting: 0, busy: 0, shell: 0, idle: 0 };
        sessions.forEach((s) => (counts[s.status] = (counts[s.status] || 0) + 1));
        sum.textContent = [
          counts.busy + counts.shell ? `${counts.busy + counts.shell} working` : '',
          counts.waiting ? `${counts.waiting} waiting` : '',
          counts.idle ? `${counts.idle} idle` : '',
        ].filter(Boolean).join(' · ') || t('w.noOpenSessions');
        const sorted = [...sessions].sort((a, b) => (S_ORDER[a.status] ?? 9) - (S_ORDER[b.status] ?? 9) || b.since - a.since);
        const rows = sorted.length ? sorted.map((s) => {
          const row = h('button', 'sess ' + s.status,
            h('span', 'st'), h('span', 'tl ' + s.tool, toolIcon(s.tool)),
            h('span', 'sess-main', h('span', 'nm', titleOf(s)), h('span', 'sess-meta', [folderOf(s), [s.model, s.effort].filter(Boolean).join(' · ') || statusText(s)].filter(Boolean).join(' · '))),
            h('span', 'ds', shortDur(Date.now() - s.since)));
          row.type = 'button';
          row.addEventListener('click', () => openDetails(s));
          return row;
        }) : [h('div', 'empty', t('w.noAiSessions'))];
        list.replaceChildren(...rows);
      },
    };
  },
};

W.github = {
  needs: ['work'],
  create(box) {
    box.style.setProperty('--c', '#c9d1d9');
    const user = h('span', 'w-sum'), bell = h('span', 'gh-bell');
    const rc = h('b'), mc = h('b'), rev = h('div', 'gh-list'), mine = h('div', 'gh-list'), err = h('div', 'gh-err', tp('Waiting for GitHub data…'));
    box.append(h('div', 'w-head', h('span', 's-label', 'GitHub'), user, bell),
      h('div', 'gh-sec', h('span', null, tp('Review requests')), rc), rev,
      h('div', 'gh-sec', h('span', null, tp('My pull requests')), mc), mine, err);
    return {
      update() {
        const g = D.work?.github;
        if (!g) return;
        const rows = Math.max(1, Math.floor((box.clientHeight - 90) / 25));
        user.textContent = g.user ? '@' + g.user : '';
        bell.replaceChildren(rich(`🔔 ${g.notifications >= 50 ? '50+' : g.notifications}`));
        rc.textContent = g.reviewRequests.length;
        mc.textContent = g.myPrs.length;
        const nRev = Math.min(g.reviewRequests.length || 1, Math.max(1, Math.floor(rows / 2)));
        rev.replaceChildren(...(g.reviewRequests.length ? g.reviewRequests.slice(0, nRev).map((p) => prRow(p, false)) : [h('div', 'gh-pr', t('w.noReviews'))]));
        mine.replaceChildren(...(g.myPrs.length ? g.myPrs.slice(0, Math.max(1, rows - nRev)).map((p) => prRow(p, true)) : [h('div', 'gh-pr', t('w.noPrs'))]));
        err.textContent = g.error ? 'GitHub: ' + g.error : '';
      },
    };
  },
};

W.processes = {
  needs: ['procs', 'state'],
  create(box, { o }) {
    const canKill = o.allowKill !== false;
    let sort = currentProcessesSort();
    const sum = h('span', 'p-sum');
    const seg = h('div', 'seg', h('button', sort === 'cpu' ? 'on' : null, 'CPU'), h('button', sort === 'mem' ? 'on' : null, 'RAM'));
    const grid = h('div', 'p-grid', h('div', 'empty', t('w.procsWait')));
    box.style.setProperty('--c', '#f472b6');
    box.append(h('div', 'p-head', h('span', 's-label', t('w.processes')), sum, seg), grid);
    const els = new Map();
    const rowEl = (g) => {
      let e = els.get(g.name);
      if (e) return e;
      e = h('div', 'proc');
      e.innerHTML = '<div class="p-ico"></div><div class="p-info"><div class="p-title"><span class="p-t"></span><span class="p-count"></span><span class="p-lock"></span></div>' +
        '<div class="p-bar"><i></i></div></div><div class="p-nums"><b></b><small></small></div>';
      fillIcon(e.querySelector('.p-ico'), g);
      e.addEventListener('click', () => { haptic(); openSheet(e._g, canKill); });
      els.set(g.name, e);
      return e;
    };
    const render = () => {
      const data = D.procs;
      if (!data) return;
      if (!data.groups.length) { sum.textContent = ''; grid.replaceChildren(h('div', 'empty', t('w.measuring'))); return; }
      const cols = box.clientWidth > 460 ? 2 : 1;
      const rows = Math.max(1, Math.floor((box.clientHeight - 46) / 40));
      grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      const list = [...data.groups].sort((a, b) => (sort === 'cpu' ? b.cpu - a.cpu || b.memMb - a.memMb : b.memMb - a.memMb)).slice(0, cols * rows);
      const max = Math.max(0.1, ...list.map((g) => (sort === 'cpu' ? g.cpu : g.memMb)));
      const pc = D.state?.pc;
      const cpuPct = pc && pc.cpu != null ? Math.round(pc.cpu) : null;
      const ramPct = pc && pc.ramTotalGb ? Math.round((pc.ramUsedGb / pc.ramTotalGb) * 100) : null;
      const ramStr = ramPct != null && pc.ramUsedGb != null && pc.ramTotalGb != null
        ? `Total RAM ${ramPct}% (${Math.round(pc.ramUsedGb)}/${Math.round(pc.ramTotalGb)} GB) · `
        : (ramPct != null ? `Total RAM ${ramPct}% · ` : '');
      const loadPart = sort === 'cpu'
        ? (cpuPct != null ? `Total CPU ${cpuPct}% · ` : '')
        : ramStr;
      sum.textContent = box.clientWidth > 380 ? loadPart + t('w.procsSummary', { n: data.total, apps: data.groupCount ?? data.groups.length }) : loadPart + t('w.procsSummaryShort', { n: data.total });
      if (grid.querySelector('.empty')) grid.replaceChildren();
      const keep = new Set(list.map((g) => g.name));
      for (const [n, e] of els) if (!keep.has(n)) { e.remove(); els.delete(n); }
      for (const g of list) {
        const e = rowEl(g);
        e._g = g;
        e.querySelector('.p-t').textContent = g.title;
        e.querySelector('.p-count').textContent = g.count > 1 ? '×' + g.count : '';
        e.querySelector('.p-lock').replaceChildren(...(g.locked ? [emo('🔒')] : []));
        e.querySelector('.p-bar i').style.width = ((sort === 'cpu' ? g.cpu : g.memMb) / max) * 100 + '%';
        e.querySelector('.p-nums b').textContent = sort === 'cpu' ? g.cpu.toFixed(1) + '%' : fmtMem(g.memMb);
        e.querySelector('.p-nums small').textContent = sort === 'cpu' ? fmtMem(g.memMb) : g.cpu.toFixed(1) + '%';
        grid.appendChild(e); // keeps the order
      }
    };
    const setSort = (s) => {
      sort = s === 'mem' ? 'mem' : 'cpu';
      [...seg.children].forEach((x, i) => x.classList.toggle('on', (i === 0 ? 'cpu' : 'mem') === sort));
      render();
    };
    registerProcessesSorter(setSort);
    [...seg.children].forEach((b, i) => b.addEventListener('click', () => {
      haptic();
      setSort(i === 0 ? 'cpu' : 'mem');
    }));
    return { update: render };
  },
};
