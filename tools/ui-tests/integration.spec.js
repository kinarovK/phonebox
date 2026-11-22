const { test, expect } = require('@playwright/test');

async function layout(page, widgets, extra = {}) {
  await page.goto('/panel/style.css');
  await page.evaluate(({ widgets, extra }) => {
    localStorage.clear();
    // Widget interaction tests must not depend on the host's wall-clock night schedule.
    localStorage.setItem('pb-demo-config', JSON.stringify({ night: { enabled: false }, ...extra, pages: [{ id: 'test', title: 'Test', enabled: true, widgets }], shortcuts: [] }));
  }, { widgets, extra });
  await page.goto('/panel/');
  await expect(page.locator('.w').first()).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/night/);
}
const widget = (type, options = {}) => ({ id: 'test', type, x: 0, y: 0, w: 12, h: 6, options });

test('fixture initialization preserves its layout when default bootstrap completion is delayed', async ({ page }) => {
  const { gatedLayout } = require('./layout-ordering');
  expect(await gatedLayout(page, layout)).toEqual(['test']);
  await expect(page.locator('.w-docker .w-title')).toContainText('owned-layout');
});

test('clock status line can hide quota providers', async ({ page }) => {
  await layout(page, [widget('clock', { providers: ['claude'] })]);
  const status = page.locator('.w-clock .status');
  await expect(status).toContainText('Claude');
  await expect(status).not.toContainText('Codex');
  await layout(page, [widget('clock', { providers: [] })]);
  // An early "no Claude" would pass before /api/quotas answers: wait for a rendered status
  // line and the quota payload, then both providers must be absent.
  await expect(page.locator('.w-clock .status')).toContainText('82%');
  await page.waitForFunction(async () => (await import('/panel/main.js')).D.quotas !== null);
  await expect(page.locator('.w-clock .status')).not.toContainText('Claude');
  await expect(page.locator('.w-clock .status')).not.toContainText('Codex');
});

test('quota selection preserves empty selections and explains missing data', async ({ page }) => {
  await layout(page, [widget('quotas', { providers: [] })]);
  await expect(page.locator('.w-quotas')).toContainText('No quota providers enabled');
  await layout(page, [widget('quotas', { providers: ['antigravity'] })]);
  await expect(page.locator('.w-quotas')).toContainText('Quota data is unavailable');
});

test('session sheet shows counters and keeps prompt content out of the panel', async ({ page }) => {
  await layout(page, [widget('sessions')]);
  await page.evaluate(async () => {
    const { D, emit } = await import('/panel/main.js');
    D.work = { sessions: [{ id: 'codex:test', tool: 'codex', name: 'Test session', project: 'project', status: 'busy', since: Date.now(), model: 'test-model', effort: 'high', totalTokens: 1234, inputTokens: 1000, outputTokens: 234, lastTool: 'read' }] };
    emit('work');
  });
  await page.getByRole('button', { name: /project/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('test-model');
  await expect(dialog.locator('button.session-close svg.ico')).toBeVisible();
  await expect(dialog).toContainText('1.2k');
  await expect(dialog).toContainText('read');
  await page.getByRole('button', { name: 'Close session details' }).click();
  await expect(dialog).toHaveCount(0);
});

test('uncontrollable volume shows the reading with disabled controls', async ({ page }) => {
  await layout(page, [widget('volume')]);
  await page.evaluate(async () => {
    // every later state poll reports the same, so the check does not race the next poll
    const real = window.fetch;
    window.fetch = async (...args) => {
      const r = await real(...args);
      if (!String(args[0]).includes('/api/state')) return r;
      const state = await r.json(); state.audio = { volume: 42, muted: false, canControl: false };
      return new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } });
    };
    const { D, emit } = await import('/panel/main.js');
    D.state.audio = { volume: 42, muted: false, canControl: false };
    emit('state');
  });
  await expect(page.locator('.w-volume')).toContainText('42%');
  for (const button of await page.locator('.w-volume button').all()) await expect(button).toBeDisabled();
});

for (const hour12 of [false, true]) {
  test(`clock times follow display.hour12 (${hour12})`, async ({ browser, baseURL }) => {
    const ctx = await browser.newContext({ baseURL, viewport: { width: 780, height: 360 }, timezoneId: 'UTC' });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date('2026-11-12T14:05:00Z'));
    await layout(page, [
      { id: 'c', type: 'clock', x: 0, y: 0, w: 6, h: 3, options: { status: false } },
    ], { display: { idleReturnSec: 0, hour12 } });
    await expect(page.locator('.clock .hh')).toHaveText(hour12 ? '2' : '14');
    await expect(page.locator('.clock .ap')).toHaveText(hour12 ? 'PM' : '');
    await page.screenshot({ path: `test-results/hour12-${hour12}.png` });
    await ctx.close();
  });
}

test('clock times follow display.hour12 ("auto") via Android.is24Hour bridge and react to system changes', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 780, height: 360 }, timezoneId: 'UTC' });
  await ctx.addInitScript(() => {
    window.__phoneboxKey = 'pb-key-test';
    window.__phone24h = false;
    window.Android = {
      battery: () => '{}',
      transport: () => 'usb',
      version: () => 'test',
      haptic() {},
      buzz() {},
      setBrightness() {},
      setVolumeKeys() {},
      is24Hour: (key) => (key === 'pb-key-test' ? window.__phone24h : true),
    };
  });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-11-12T14:05:00Z'));
  await layout(page, [
    { id: 'c', type: 'clock', x: 0, y: 0, w: 6, h: 3, options: { status: false } },
  ], { display: { idleReturnSec: 0, hour12: 'auto' } });

  await expect(page.locator('.clock .hh')).toHaveText('2');
  await expect(page.locator('.clock .ap')).toHaveText('PM');

  await page.evaluate(() => {
    window.__phone24h = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.clock .hh')).toHaveText('14');
  await expect(page.locator('.clock .ap')).toHaveText('');

  // Calls without a matching panel bridge key fail closed to 24-hour.
  await page.evaluate(() => {
    window.__phone24h = false;
    window.__phoneboxKey = 'wrong-key';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.clock .hh')).toHaveText('14');
  await expect(page.locator('.clock .ap')).toHaveText('');
  await ctx.close();
});

test('settings Display Time format select saves false, true and auto', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await layout(page, [widget('clock')], { display: { idleReturnSec: 0, hour12: 'auto' } });
  await page.goto('/settings/#general');
  const sel = page.locator('[data-bind="display.hour12"]');
  await expect(sel).toBeVisible();
  await expect(sel).toHaveValue('auto');

  await sel.selectOption('true');
  await page.locator('#save').click();
  await expect(page.locator('#save')).toBeDisabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pb-demo-config')).display.hour12)).toBe(true);

  await sel.selectOption('false');
  await page.locator('#save').click();
  await expect(page.locator('#save')).toBeDisabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pb-demo-config')).display.hour12)).toBe(false);

  await sel.selectOption('auto');
  await page.locator('#save').click();
  await expect(page.locator('#save')).toBeDisabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pb-demo-config')).display.hour12)).toBe('auto');

  await page.reload();
  await expect(sel).toHaveValue('auto');
});

// The feeds, cameras, console, Discord and ping editors (and each control action's "enabled") fill in their defaults
// while they render. The unsaved-changes baseline used to be taken before that, so a page that had just loaded already
// offered Save, and Revert could never get back to a clean state.
test('a freshly loaded settings page has nothing to save, and Revert gets back to that', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/settings/#general');
  // the Advanced JSON box is empty in the markup and filled by the changed() at the end of load(): from here on the
  // config is rendered, the form handlers are bound and the baseline is taken (both buttons start disabled anyway)
  await expect(page.locator('#json')).toHaveValue(/"pages"/);
  await expect(page.locator('#save')).toBeDisabled();
  await expect(page.locator('#revert')).toBeDisabled();

  await page.locator('input[data-bind="night.brightness"]').fill('0.1');
  await expect(page.locator('#save')).toBeEnabled();
  await page.locator('#revert').click();
  await expect(page.locator('#save')).toBeDisabled();
  await expect(page.locator('#revert')).toBeDisabled();
  await expect(page.locator('#nbv')).toHaveText('2%');
});

test('multi option preserves saved unlisted quota provider IDs when toggling choices', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await layout(page, [widget('quotas', { providers: ['claude', 'alibaba'] })]);
  await page.goto('/settings/');
  await page.locator('#canvas [title="AI quotas"]').click();
  const codexCheckbox = page.locator('#inspector label.check', { hasText: 'Codex' }).locator('input[type="checkbox"]');
  await expect(codexCheckbox).toBeVisible();
  await codexCheckbox.check();
  await page.locator('#save').click();
  await expect(page.locator('#save')).toBeDisabled();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pb-demo-config')).pages[0].widgets[0].options.providers);
  expect(saved).toContain('claude');
  expect(saved).toContain('codex');
  expect(saved).toContain('alibaba');
});

// Apply JSON used to assign the paste verbatim: a fragment without sections every renderer reads
// (pages, display, night…) threw inside renderPages and left cfg broken until a reload.
test('Apply JSON fills defaults for a partial config instead of breaking the editor', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/settings/#general');
  // move away from the defaults first, so the checks below prove Apply JSON put them back
  await page.locator('input[data-bind="night.brightness"]').fill('0.1');
  await expect(page.locator('#nbv')).toHaveText('10%');
  await page.locator('input[data-bind="display.showSeconds"]').setChecked(false, { force: true });
  await page.locator('a[href="#advanced"]').click();
  await page.locator('#json').fill('{"display": {"theme": "midnight"}}');
  await page.locator('#applyJson').click();
  await expect(page.locator('#jsonErr')).toHaveText('');
  // the fragment has no pages array: defaults keep renderPages working — the empty list still shows its buttons
  await page.locator('a[href="#pages"]').click();
  await expect(page.locator('#pageTabs button', { hasText: 'New page' })).toBeVisible();
  // and the form keeps answering: the night screen slider read its (defaulted) section without throwing
  await page.locator('a[href="#general"]').click();
  await expect(page.locator('#nbv')).toHaveText('2%'); // the agent's NightConfig default, not NaN%
  await expect(page.locator('input[data-bind="display.showSeconds"]')).toBeChecked(); // DisplayConfig.ShowSeconds
});

// Apply JSON and page-file imports can drop a widget without a grid position. A drag then wrote NaN into
// x/y/w/h, JSON.stringify turned that into null and the server refused the whole save as invalid JSON.
test('Apply JSON gives pasted widgets a valid grid position', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/settings/#advanced');
  await page.locator('#json').fill('{"pages": [{"id": "p", "title": "P", "widgets": [{"id": "w1", "type": "clock"}]}]}');
  await page.locator('#applyJson').click();
  await expect(page.locator('#jsonErr')).toHaveText('');
  await page.locator('a[href="#pages"]').click();
  const wb = page.locator('#canvas .wb');
  await expect(wb).toHaveCount(1);
  // a positionless clock takes its catalog default size at the top-left cell instead of an invalid gridArea
  expect(await page.evaluate(() => { const { x, y, w, h } = cfg.pages[0].widgets[0]; return [x, y, w, h]; }))
    .toEqual([0, 0, 6, 4]);
  // a drag writes integer coordinates — before the fix it wrote NaN, which JSON.stringify saved as null
  const cell = await page.locator('#canvas .cell').first().boundingBox();
  const box = await wb.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 20 + cell.width, box.y + 20 + cell.height, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => { const { x, y } = cfg.pages[0].widgets[0]; return [x, y]; })).toEqual([1, 1]);
  expect(await page.evaluate(() => JSON.stringify(cfg))).not.toContain('"x":null');
});

// #58: switch between the computers paired over Wi-Fi with one tap; a USB cable always wins.
test('the Computers widget lists paired computers and switches between them', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 780, height: 360 } });
  await ctx.addInitScript(() => {
    window.__phoneboxKey = 'pb-key-test';
    window.__route = 'wifi';
    window.__selected = [];
    window.Android = {
      battery: () => '{}', version: () => 'test', haptic() {}, buzz() {}, setBrightness() {}, setVolumeKeys() {}, is24Hour: () => true,
      transport: () => window.__route,
      pcs: (key) => (key === 'pb-key-test' ? JSON.stringify([{ id: 'a', name: 'Desk PC', active: true }, { id: 'b', name: 'MacBook', active: false }]) : '[]'),
      selectPc: (key, id) => { if (key === 'pb-key-test') window.__selected.push(id); },
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await layout(page, [widget('pcswitch')]);

  const pcs = page.locator('.w-pcswitch .ov-pc');
  await expect(pcs).toHaveText(['Desk PC', 'MacBook']);
  await expect(pcs.locator('svg.ico')).toHaveCount(2); // a stroke icon, not the emoji an old WebView draws however it likes
  await expect(pcs.nth(0)).toHaveClass(/\bon\b/);
  await pcs.nth(0).click();
  await pcs.nth(1).click();
  await expect.poll(() => page.evaluate(() => window.__selected)).toEqual(['b']);
  await page.screenshot({ path: 'test-results/pcswitch-wifi.png' });

  await page.evaluate(() => { window.__route = 'usb'; });
  await expect(pcs.nth(1)).toBeDisabled({ timeout: 10_000 });
  await expect(page.locator('.w-pcswitch .pcs-sub')).toContainText('USB');
  await page.screenshot({ path: 'test-results/pcswitch-usb.png' });
  expect(errors).toEqual([]);
  await ctx.close();
});

test('docker widget clears loading state when filtered or stopped containers yield an empty list', async ({ page }) => {
  await layout(page, [widget('docker', { title: 'Podman', filter: 'redis', stopped: false })]);
  await expect(page.locator('.w-docker .w-title')).toContainText('Podman 0/1');
  await expect(page.locator('.w-docker .empty')).toHaveText('No running containers (1 stopped)');

  await layout(page, [widget('docker', { title: 'Podman', filter: 'missing', stopped: false })]);
  await expect(page.locator('.w-docker .w-title')).toContainText('Podman 0/0');
  await expect(page.locator('.w-docker .empty')).toHaveText('No containers match "missing"');
});
