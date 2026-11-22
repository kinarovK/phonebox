// A PC clock that steps back does not freeze the state the panel shows.
const { test, expect } = require('@playwright/test');

async function openPanel(page) {
  await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') });
  await page.goto('/panel/style.css');
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('pb-demo-config', JSON.stringify({
      night: { enabled: false }, display: { language: 'en' },
      pages: [{ id: 'one', title: 'One', enabled: true, widgets: [
        { id: 'd1', type: 'docker', x: 0, y: 0, w: 6, h: 3, options: { title: 'Containers' } },
      ] }],
    }));
  });
  await page.goto('/panel/');
  await expect(page.locator('.w-docker .w-title')).toContainText('Containers');
  await page.clock.pauseAt(new Date('2026-01-01T12:01:00Z'));
}

test('a state from a PC clock that stepped back is applied, a slightly late one is not', async ({ page }) => {
  await openPanel(page);
  const hosts = await page.evaluate(async () => {
    const m = await import('/panel/main.js');
    const snap = (ts, host) => ({ ts, host, evSeq: 0, pc: { cpu: 1, ramUsedGb: 1, ramTotalGb: 2 } });
    m.applyState(snap(9000000060000, 'now'));
    m.applyState(snap(9000000058000, 'late answer'));   // 2 s older: a late poll
    const late = m.D.state.host;
    m.applyState(snap(9000000000000, 'clock stepped back')); // a minute older: the PC clock moved
    return { late, stepped: m.D.state.host };
  });
  expect(hosts).toEqual({ late: 'now', stepped: 'clock stepped back' });
});
