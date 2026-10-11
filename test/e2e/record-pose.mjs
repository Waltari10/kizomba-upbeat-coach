// Plays a video through the app ("Analyse a video" mode) and saves raw pose landmarks and the
// beat grid for offline analysis:  node test/e2e/record-pose.mjs <video> <out.json>
import { chromium } from 'playwright';
const [file, outFile] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.goto('http://localhost:8080/');
await page.evaluate(() => (window.kizomba.recordPose = true));
await page.check('input[name=source][value=file]');
await page.setInputFiles('#file', file);
await page.check('input[name=sound][value=off]', { force: true });
await page.click('button[type=submit]');
await page.waitForFunction(() => window.kizomba.state === 'summary', null, { timeout: 600000, polling: 1000 });
const data = await page.evaluate(() => ({ pose: window.kizomba.poseLog, log: window.kizomba.log }));
const fs = await import('node:fs');
fs.writeFileSync(outFile, JSON.stringify(data));
console.log('frames', data.pose.length);
await browser.close();
