// Dev tool: enters an emulated Quest 3 immersive-AR session (needs `npm run dev` and ?emulate) and checks the XR path.
import { chromium } from 'playwright-core';
const XR = process.env.XR_URL ?? 'https://127.0.0.1:5273';
const out = process.argv[2] ?? '.';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
// headless Chrome ships a native navigator.xr stub, which makes the emulator skip itself
await page.addInitScript(() => { try { delete Navigator.prototype.xr; } catch { /* noop */ } });
await page.goto(XR + '/?emulate=1');
await page.waitForSelector('.card');
await page.waitForTimeout(1500);
console.log('xr supported (emulated):', await page.evaluate(() => navigator.xr?.isSessionSupported('immersive-ar')));
await page.click('button.ghost:has-text("Preview with simulation")');
await page.waitForTimeout(800);
await page.click('button.mr:has-text("Enter Mixed Reality")');
await page.waitForTimeout(3500);
console.log('in session:', await page.evaluate(() => !!document.querySelector('canvas')), 'hud hidden:', (await page.locator('.hud').count()) === 0);
await page.screenshot({ path: `${out}/4-xr-emulated.png` });
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
await browser.close(); process.exit(0);
