// PhoneBox web demo: answers the panel's and the settings page's API calls in the browser with made-up data,
// so both run on a static site (GitHub Pages) without a phone or an agent. Load it before app.js / the settings script.
// The panel and the settings page talk through a BroadcastChannel: layout changes and test notifications show up live.
(() => {
  'use strict';
  const ROOT = new URL('.', document.currentScript.src).href;
  const VERSION = document.currentScript.dataset.version || 'demo'; // stamped by tools/pages/build.py from the agent's version
  const realFetch = window.fetch.bind(window);
  const bc = new BroadcastChannel('phonebox-demo');
  const START = Date.now();
  const now = () => Date.now();
  const rnd = (a, b) => a + Math.random() * (b - a);
  const wave = (period, lo, hi, phase = 0, noise = 0) =>
    lo + (hi - lo) * (0.5 + 0.5 * Math.sin((2 * Math.PI * (now() - START)) / 1000 / period + phase)) + rnd(-noise, noise);

  const PAGES = ['home', 'dashboard', 'ai', 'work', 'system', 'procs', 'status', 'ambient', 'world', 'daily', 'markets', 'feeds', 'focus', 'calm', 'clock', 'automation', 'planner', 'nightstand', 'weekend', 'focuswork',
    'codexbar', 'devops'];

  let catalog = null;
  async function loadCatalog() {
    if (catalog) return catalog;
    const [widgets, templates] = await Promise.all([realFetch(ROOT + 'widgets.json').then((r) => r.json()), realFetch(ROOT + 'templates.json').then((r) => r.json())]);
    return (catalog = { cols: 12, rows: 6, widgets, templates });
  }

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  };

  async function loadConfig() {
    let c = store.get('pb-demo-config', null);
    if (c) return c;
    const { templates } = await loadCatalog();
    // A tab can save a layout while the first catalog request is still pending.
    c = store.get('pb-demo-config', null);
    if (c) return c;
    const byId = Object.fromEntries(templates.map((t) => [t.id, t]));
    // every section the agent serves, with its defaults (Config.cs), so the settings page shows what a real one does
    c = {
      codexBar: { providers: ['claude', 'codex', 'antigravity'], rotate: true, pageSize: 2, rotateInterval: 8 },
      deviceSerial: null, adbPath: null,
      night: { enabled: false, start: '00:30', end: '07:30', brightness: 0.02 },
      display: { appearance: null, showSeconds: true, hour12: false, idleReturnSec: 0, vibrate: true, volumeKeys: true, orientation: 'landscape', theme: 'default', accent: '#2dd4bf',
        pixelShift: false, idleDimMin: 0,
        autoBrightness: false, nightWhenDark: false, nightWhenUnreachable: false, unreachableNightDelayMin: 5, proximityWake: true, pin: false, homeScreen: false, keepAwake: true, openOnConnect: true, followComputerLock: false,
        homePage: null, switchCountdownSec: 3, touchGraceSec: 20, minDwellSec: 15 },
      updates: { auto: true, repo: 'ersinkoc/phonebox' },
      claude: { phoneApprovals: true, timeoutSec: 90, onlyWhenAway: false },
      antigravity: { sessions: false, shareSessionTitles: false },
      pages: PAGES.filter((id) => byId[id]).map((id) => {
        const t = byId[id], seen = {};
        return { appearance: null, id, title: t.title, icon: t.icon, enabled: true, idleSec: null, widgets: t.widgets.map((w) => {
          const n = (seen[w.type] = (seen[w.type] || 0) + 1);
          const control = w.type === 'docker' ? { control: true } : {};
          return { ...w, id: n === 1 ? w.type : `${w.type}-${n}`, options: { ...(w.options || {}), ...control } };
        }) };
      }),
      phones: [],
    };
    c = JSON.parse(JSON.stringify(c, (_, v) => v === null ? undefined : v)); // the agent leaves unset (null) settings out
    store.set('pb-demo-config', c);
    return c;
  }
  async function config() {
    return loadConfig();
  }
  const cfgVersion = () => store.get('pb-demo-version', 1);
  // every widget of the layout (AgentConfig.Widgets)
  const widgets = (c) => (c.pages || []).flatMap((p) => p.widgets || []);
  const allows = (c, test) => widgets(c).some((w) => test(w.type) && w.options?.control === true);

  // What the agent sends to a phone (AgentConfig.ToPublic): no keys, tokens or what a rule matches on.
  function publicConfig(c) {
    const options = (w) => w.options ?? null;
    return {
      codexBar: c.codexBar, night: c.night, display: c.display,
      pages: (c.pages || []).map((p) => ({ id: p.id, title: p.title, icon: p.icon, enabled: p.enabled !== false, idleSec: p.idleSec ?? null, appearance: p.appearance ?? null,
        widgets: (p.widgets || []).map((w) => ({ id: w.id, type: w.type, x: w.x, y: w.y, w: w.w, h: w.h, appearance: w.appearance ?? null, options: options(w) })) })),
    };
  }

  // ---- events (page switches, permission prompts) shared between tabs
  const events = [];
  let seq = 0;
  function emit(kind, data, broadcast = true) {
    const e = { seq: ++seq, kind, data, at: now() };
    events.push(e);
    if (events.length > 50) events.shift();
    if (broadcast) bc.postMessage({ type: 'event', kind, data });
    return e;
  }
  let approvals = [];
  const SAMPLE_PROMPTS = [
    { tool: 'Run a command', detail: 'git push origin main --force-with-lease', description: 'Push the rebased branch', project: 'api-gateway', cwd: '/Users/me/work/api-gateway' },
    { tool: 'Edit a file', detail: 'src/routes/billing.ts\n\n  export const limit = rateLimit({ windowMs: 60_000, max: 120 })', description: '', project: 'docs-site' },
    { tool: 'Fetch a web page', detail: 'https://docs.github.com/en/rest/pulls', description: '', project: 'blog-engine' },
  ];
  function ask(sample, broadcast = true) {
    const s = sample || SAMPLE_PROMPTS[Math.floor(Math.random() * SAMPLE_PROMPTS.length)];
    const a = { id: Math.random().toString(16).slice(2, 10), source: 'Claude Code', session: 'demo', createdAt: now(), expiresAt: now() + 90e3, ...s };
    approvals.push(a);
    if (broadcast) bc.postMessage({ type: 'ask', sample: s, id: a.id });
    emit('approval', { id: a.id }, false);
    return a;
  }
  bc.onmessage = (m) => {
    const d = m.data || {};
    if (d.type === 'ask') { const a = ask(d.sample, false); a.id = d.id; }
    if (d.type === 'decided') { approvals = approvals.filter((x) => x.id !== d.id); emit('approval-done', { id: d.id }, false); }
    if (d.type === 'event') emit(d.kind, d.data, false);
  };

  // ---- made-up computer
  const audio = { volume: 42, muted: false, canControl: true };
  function state(since) {
    return {
      update: null, ts: now(), host: 'DESK-PC', os: window.__demoOs || 'windows', cfgVersion: cfgVersion(), evSeq: seq,
      events: since == null ? [] : events.filter((e) => e.seq > since),
      pc: {
        cpu: Math.max(1, wave(37, 8, 46, 0, 6)), cpuName: 'AMD Ryzen 9 7950X 16-Core Processor', cpuTemp: wave(60, 52, 68),
        ramUsedGb: wave(120, 21, 24), ramTotalGb: 64, netDownBps: Math.max(0, wave(23, 0.2e6, 9e6, 0, 1e6)), netUpBps: Math.max(0, wave(17, 40e3, 600e3, 1, 50e3)),
        uptimeSec: 3 * 86400 + 5 * 3600 + Math.floor((now() - START) / 1000),
        disks: [{ name: 'C:', usedGb: 612, totalGb: 1000 }, { name: 'D:', usedGb: 1450, totalGb: 2000 }, { name: 'E:', usedGb: 310, totalGb: 4000 }],
        ...(() => {
          const gpus = [
            { name: 'NVIDIA GeForce RTX 4080', util: Math.max(0, wave(29, 4, 38, 2, 4)), temp: wave(50, 46, 61), power: wave(29, 38, 140, 2),
              powerLimit: 320, clock: 2520, fan: 34, vramUsed: 5.8, vramTotal: 16, vendor: 'nvidia', source: 'nvidia-smi+windows', integrated: false,
              memClock: 11201, sharedUsed: 0.3, sharedTotal: 31.9, powerPct: null, fanRpm: 1180, tempMax: 90, driver: '596.36', hotSpot: null, memTemp: null },
            { name: 'AMD Radeon(TM) Graphics', util: Math.max(0, wave(41, 0, 6, 0, 1)), temp: wave(60, 50, 58), power: null, powerLimit: null,
              vramUsed: 0.1, vramTotal: 0.5, fan: null, clock: null, vendor: 'amd', source: 'windows', integrated: true, memClock: 2400,
              sharedUsed: 0.2, sharedTotal: 31.9, powerPct: wave(37, 6, 14), fanRpm: null, tempMax: null, driver: '32.0.21045.11001', hotSpot: null, memTemp: null },
          ];
          return { gpu: gpus[0], gpus };
        })(),
      },
      audio: { ...audio },
      ping: { host: '1.1.1.1', ms: wave(13, 9, 16), avgMs: 12, lossPct: 0 },
    };
  }

  // made-up containers; start / stop / restart change them
  const containers = [
    { id: 'a1b2c3d4e5f6', name: 'shop-web-1', image: 'nginx:1.27', project: 'shop', state: 'running', status: 'Up 3 hours', health: null, cpu: 0.4, mem: '12MiB' },
    { id: 'b2c3d4e5f6a1', name: 'shop-api-1', image: 'node:22-alpine', project: 'shop', state: 'running', status: 'Up 3 hours (healthy)', health: 'healthy', cpu: 6.2, mem: '148MiB' },
    { id: 'c3d4e5f6a1b2', name: 'shop-db-1', image: 'postgres:17', project: 'shop', state: 'running', status: 'Up 3 hours', health: null, cpu: 1.1, mem: '86MiB' },
    { id: 'd4e5f6a1b2c3', name: 'shop-worker-1', image: 'node:22-alpine', project: 'shop', state: 'running', status: 'Up 12 minutes (unhealthy)', health: 'unhealthy', cpu: 31.5, mem: '402MiB' },
    { id: 'e5f6a1b2c3d4', name: 'redis', image: 'redis:7', project: null, state: 'exited', status: 'Exited (0) 2 days ago', health: null, cpu: null, mem: null },
  ];
  function docker() {
    const live = containers.map((c) => c.state === 'running' && c.cpu != null ? { ...c, cpu: Math.max(0.1, c.cpu * (0.8 + Math.random() * 0.4)) } : c);
    return { snapshot: { available: true, error: null, containers: live, updated: now() } };
  }

  function quotas() {
    const n = now();
    return { providers: [
      { id: 'claude', name: 'Claude', plan: 'Max 5x', updatedAt: n - 120e3, extra: '', error: null, codex: null, source: 'local', limits: [
        { label: '5-hour session', percent: 34, resetsAt: n + 2.6 * 3600e3, windowSec: 18000 },
        { label: 'Weekly', percent: 52, resetsAt: n + 3.2 * 86400e3, windowSec: 604800 },
        { label: 'Weekly · Fable', percent: 9, resetsAt: n + 3.2 * 86400e3, windowSec: 604800 }] },
      { id: 'codex', name: 'Codex', plan: 'Pro', updatedAt: n - 300e3, extra: 'Credits: 1,250', error: null, source: 'local',
        codex: { model: 'Demo coding model', effort: 'high', totalTokens: 187000, totalInput: 150000, totalOutput: 37000, totalCached: 90000, totalReasoning: 12000, lastInput: 42000, contextWindow: 256000 }, limits: [
        { label: '5-hour session', percent: 12, resetsAt: n + 4.1 * 3600e3, windowSec: 18000 },
        { label: 'Weekly', percent: 27, resetsAt: n + 5.5 * 86400e3, windowSec: 604800 }] },
    ] };
  }

  function work() {
    const n = now();
    const s = (i, tool, name, status, mins, waitingFor = null) => ({ id: `${tool}:${i}`, tool, name, project: name, status, waitingFor, since: n - mins * 60e3, startedAt: n - 3 * 3600e3,
      pid: 4000 + i * 211, outcome: null, model: null, effort: null, totalTokens: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null,
      lastInputTokens: null, contextWindow: null, lastTool: null, turnStartedAt: null,
      ...(tool === 'codex' ? { model: 'Demo coding model', effort: 'high', totalTokens: 187000, inputTokens: 150000, outputTokens: 37000, cachedInputTokens: 90000, reasoningTokens: 12000, lastInputTokens: 42000, contextWindow: 256000, lastTool: 'read', turnStartedAt: n - 45000 } : {}) });
    const pr = (repo, number, title, ci = null, review = null, draft = false, author = null) => ({ repo, number, title, ci, review, draft, author, updated: n - (number % 9 + 1) * 3600e3 });
    return {
      sessions: [s(1, 'claude', 'api-gateway', 'busy', 4), s(2, 'claude', 'docs-site', 'waiting', 2, 'approve a file edit'), s(3, 'codex', 'mobile-app', 'busy', 11),
        s(4, 'claude', 'infra', 'shell', 1), s(5, 'claude', 'blog-engine', 'idle', 38), s(6, 'codex', 'data-pipeline', 'idle', 74), s(7, 'claude', 'design-system', 'idle', 125),
        s(8, 'cursor', 'phonebox', 'busy', 3), s(9, 'cursor', 'fueltrack', 'idle', 1), s(10, 'antigravity', 'phonebox', 'busy', 2)],
      github: { user: 'octocat', notifications: 7, error: null, updatedAt: n - 90e3,
        reviewRequests: [pr('acme/api', 412, 'Rate limiter for public endpoints', null, null, false, 'hubot'), pr('acme/web', 1288, 'Dark mode for the dashboard', null, null, false, 'monalisa'),
          pr('acme/infra', 77, 'Move staging to a new region', null, null, false, 'hubot')],
        myPrs: [pr('acme/api', 409, 'Cache user sessions in Redis', 'SUCCESS', 'APPROVED'), pr('acme/web', 1281, 'Faster image uploads', 'PENDING'),
          pr('acme/cli', 53, 'New "deploy" command', 'FAILURE', 'CHANGES_REQUESTED'), pr('acme/docs', 210, 'Getting started rewrite', null, null, true)] },
    };
  }

  const PROCS = [['code', 'Visual Studio Code', 9, 6.2, 2100], ['chrome', 'Google Chrome', 14, 4.8, 3400], ['node', 'Node.js', 6, 3.9, 1200],
    ['claude', 'Claude', 7, 2.7, 1800], ['docker', 'Docker Desktop', 4, 2.1, 2600], ['spotify', 'Spotify', 5, 1.4, 420], ['discord', 'Discord', 6, 1.1, 610],
    ['explorer', 'Windows Explorer', 3, 0.9, 380], ['obs64', 'OBS Studio', 1, 0.8, 520], ['slack', 'Slack', 5, 0.6, 700], ['steam', 'Steam', 3, 0.4, 340],
    ['onedrive', 'Microsoft OneDrive', 1, 0.3, 120], ['python', 'Python', 2, 0.3, 160], ['figma', 'Figma', 3, 0.2, 640]];
  const procs = () => ({ total: 312, groupCount: 141, groups: PROCS.map(([name, title, count, cpu, memMb]) =>
    ({ name, title, count, cpu: Math.round(cpu * rnd(0.8, 1.2) * 10) / 10, memMb, locked: name === 'explorer', hasIcon: false })) });
  function procDetail(name) {
    const p = PROCS.find((x) => x[0] === name) || PROCS[0];
    return { name: p[0], title: p[1], locked: p[0] === 'explorer', instances: Array.from({ length: p[2] }, (_, i) => ({
      pid: 4100 + i * 37, cpu: Math.round((p[3] / p[2]) * 10) / 10, memMb: Math.round(p[4] / p[2]), startedAt: now() - (i + 1) * 1800e3,
      locked: p[0] === 'explorer', session: p[0] === 'claude' && i < 3 ? ['api-gateway', 'docs-site', 'infra'][i] : null, window: null, args: i ? '--type=renderer' : null })) };
  }

  // ---- router
  const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
  const parse = (body) => { if (body == null || body === '') return null; try { return JSON.parse(body); } catch (_) { return String(body); } };

  async function handle(method, path, q, body, headers) {
    if (path === '/api/state') return json(state(q.has('ev') ? +q.get('ev') : null));
    if (path === '/api/config') return json({ version: cfgVersion(), config: publicConfig(await config()) });
    if (path === '/api/volume' && method === 'POST') {
      // the agent answers with the new volume state (AudioSnapshot)
      const op = q.get('op'), level = q.has('level') ? +q.get('level') : null;
      if (op === 'mute') audio.muted = !audio.muted;
      else if (op === 'up' || op === 'down') audio.volume = Math.max(0, Math.min(100, audio.volume + (op === 'up' ? 5 : -5)));
      else if (Number.isFinite(level)) audio.volume = Math.max(0, Math.min(100, Math.round(level)));
      else return json({}, 400);
      return json({ ...audio });
    }
    if (path === '/api/procs/kill' && method === 'POST') {
      // KillResult; refused unless an enabled page has a processes widget that allows it (AgentConfig.AllowKill)
      const c = await config(), allowed = (c.pages || []).filter((p) => p.enabled !== false).some((p) => widgets({ pages: [p] }).some((w) => w.type === 'processes' && w.options?.allowKill !== false));
      if (!allowed) return json({ killed: 0, failed: 0, error: 'Terminating processes is disabled in the settings' }, 403);
      const i = PROCS.findIndex((x) => x[0] === q.get('name'));
      if (q.has('pid')) { const g = PROCS.find((x) => procDetail(x[0]).instances.some((n) => n.pid === +q.get('pid'))); if (g && g[0] !== 'explorer' && g[2] > 1) { g[2]--; return json({ killed: 1, failed: 0, error: null }); } if (g && g[0] !== 'explorer') { PROCS.splice(PROCS.indexOf(g), 1); return json({ killed: 1, failed: 0, error: null }); } }
      else if (i >= 0 && PROCS[i][0] !== 'explorer') { const [g] = PROCS.splice(i, 1); return json({ killed: g[2], failed: 0, error: null }); }
      return json({ killed: 0, failed: 0, error: i >= 0 || q.has('pid') ? 'That process is protected' : 'No such process' }, 409);
    }
    if (path === '/api/quotas') return json(quotas());
    // made-up recent messages and steps of a Claude Code session (the real ones come from its chat file, and only when switched on)
    if (path === '/api/work/conversation') {
      const n = Date.now();
      return json({ enabled: true,
        messages: [
          { role: 'user', text: 'Add a retry to the upload helper', at: n - 9 * 60e3 },
          { role: 'assistant', text: 'I added three retries with a short pause between them and a test for the failing case.', at: n - 7 * 60e3 },
          { role: 'user', text: 'Does it also cover timeouts?', at: n - 2 * 60e3 },
          { role: 'assistant', text: 'Yes, a timeout counts as a failed attempt and is retried the same way.', at: n - 60e3 },
        ],
        steps: [
          { tool: 'Read', detail: 'upload.js', at: n - 8 * 60e3, running: false },
          { tool: 'Edit', detail: 'upload.js', at: n - 7 * 60e3, running: false },
          { tool: 'Bash', detail: 'npm', at: n - 20e3, running: true },
        ] });
    }
    if (path === '/api/docker') return json({ ...docker(), control: allows(await config(), (t) => t === 'docker') });
    if (path === '/api/phones') return json([
      { id: '3f9a1c0d7b2e', model: 'UMIDIGI BISON', lastSeen: now() - 2000, via: 'USB', webView: 'com.google.android.webview/134.0.6998.135', webviewProblem: null, name: null, pages: null },
      { id: 'c81e728d9d4c', model: 'samsung SM-X200', lastSeen: now() - 140000, via: 'USB', webView: 'com.google.android.webview/134.0.6998.135', webviewProblem: null, name: null, pages: null },
    ]);
    if (path === '/api/network/adapters') return json([{ name: 'Ethernet', description: 'Intel(R) Ethernet Controller I225-V', auto: true },
      { name: 'Wi-Fi', description: 'Intel(R) Wi-Fi 6E AX211 160MHz', auto: true }, { name: 'WireGuard', description: 'WireGuard Tunnel', auto: false }]);
    if (path.startsWith('/api/docker/') && method === 'POST') {
      const [, , , id, action] = path.split('/');
      if (!allows(await config(), (t) => t === 'docker')) return json({ error: "starting and stopping containers is turned off in the widget's settings" }, 400);
      if (!['start', 'stop', 'restart'].includes(action)) return json({ error: 'unknown action' }, 400);
      const c = containers.find((x) => x.id === id);
      if (!c) return json({ error: 'unknown container' }, 400);
      if (c && action === 'stop') Object.assign(c, { state: 'exited', status: 'Exited (0) 1 second ago', cpu: null, mem: null, health: null });
      if (c && (action === 'start' || action === 'restart')) Object.assign(c, { state: 'running', status: 'Up 1 second', cpu: 2, mem: '40MiB', health: null });
      return json({ ok: true });
    }
    if (path === '/api/work') return json(work());
    if (path === '/api/procs') return json(procs());
    if (path === '/api/procs/detail') return json(procDetail(q.get('name')));
    if (path === '/api/approvals' && method === 'GET') return json({ items: approvals.filter((a) => a.expiresAt > now()) });
    if (path.startsWith('/api/approvals/') && method === 'POST') {
      const id = decodeURIComponent(path.slice(15));
      if (!approvals.some((a) => a.id === id)) return json({}, 404);
      approvals = approvals.filter((a) => a.id !== id);
      bc.postMessage({ type: 'decided', id });
      return json({ ok: true });
    }
    if (path.startsWith('/api/goto/') && method === 'POST')
      return json(emit('goto', { page: decodeURIComponent(path.slice(10)), countdown: q.has('countdown') ? Math.max(0, Math.min(30, +q.get('countdown') || 0)) : null }));
    // settings page
    if (path === '/api/catalog') return json(await loadCatalog());
    if (path === '/api/settings') {
      if (method === 'PUT') {
        // a save over settings that changed since this page loaded them is refused, as by the agent (X-Config-Version)
        const loaded = headers.get('X-Config-Version');
        if (loaded && +loaded !== cfgVersion()) return json({ error: 'The settings were changed in another tab or window after this one loaded them. Reload the page to see them; the changes made here were not saved.' }, 409);
        const c = parse(body);
        if (!c || typeof c !== 'object') return json({ error: 'the settings are not valid JSON' }, 400);
        (c.pages || []).forEach((p, i) => { p.id ||= `page-${i + 1}`; p.title ||= 'Page'; const seen = {}; (p.widgets || []).forEach((w) => { if (!w.id) { const n = (seen[w.type] = (seen[w.type] || 0) + 1); w.id = `${w.type}-${Date.now() % 100000}-${n}`; } }); });
        store.set('pb-demo-config', c);
        store.set('pb-demo-version', cfgVersion() + 1);
        return json({ version: cfgVersion() });
      }
      return json(await config(), 200, { 'X-Config-Version': String(cfgVersion()) });
    }
    if (path === '/api/info') return json({ version: VERSION, os: 'windows', configPath: 'browser storage (demo)', logPath: '—', adb: 'demo', connected: true, devices: ['DEMO0001'], appMissing: [], webviewProblem: null });
    if (path === '/api/update') return json({ status: { agentVersion: VERSION, appVersion: VERSION, latest: VERSION, releaseUrl: 'https://github.com/ersinkoc/phonebox/releases/latest', agentUpdate: false, appUpdate: false,
      lastCheck: now() - 3600e3, state: 'idle', error: null }, auto: (await config()).updates?.auto !== false, installed: true });
    if (path === '/api/claude/hook') return json({ installed: false, path: '~/.claude/settings.json' });
    if (method !== 'GET') return json({ ok: true });
    return json({ error: 'not in the demo' }, 404);
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const i = url.pathname.indexOf('/api/');
    if (url.origin !== location.origin || i < 0) return realFetch(input, init);
    return handle((init.method || 'GET').toUpperCase(), url.pathname.slice(i), url.searchParams, init.body, new Headers(init.headers || {}));
  };

  // A pretend Android bridge for phone-only widgets.
  if (!window.Android && document.currentScript.dataset.panel !== undefined)
    window.Android = { battery: () => JSON.stringify({ level: 82, plugged: true, temp: 29.5 }), transport: () => 'usb', version: () => VERSION,
      is24Hour: () => !new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12,
      haptic() {}, buzz() {}, setBrightness() {}, setVolumeKeys() {} };

  // Served by tools/demo-server.py: page switches and prompts sent to that server with curl arrive here. Each tab applies them itself.
  if (document.currentScript.dataset.relay !== undefined && window.EventSource) {
    const es = new EventSource(ROOT + 'demo/events');
    const on = (kind, fn) => es.addEventListener(kind, (m) => fn(JSON.parse(m.data)));
    on('goto', (d) => emit('goto', d, false));
    on('ask', (d) => ask(d || undefined, false));
  }

  window.PhoneBoxDemo = { emit, ask,
    reset() { localStorage.removeItem('pb-demo-config'); store.set('pb-demo-version', cfgVersion() + 1); },
    // the agent restarted: PushStore keeps events in memory only, so its counter and backlog start over
    restart() { seq = 0; events.length = 0; } };
})();
