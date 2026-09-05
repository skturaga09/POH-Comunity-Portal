const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  
  await page.goto('https://poh-community-portal.web.app/?v=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  await page.evaluate(() => {
    const accessWrap = document.getElementById('accessWrap');
    if (accessWrap) accessWrap.hidden = true;
    const portal = document.getElementById('portal');
    if (portal) {
      portal.hidden = false;
      portal.classList.add('home-active');
    }
  });

  await page.waitForTimeout(1000);

  const screenshotPath = path.join('/Users/turagasanthoshkumar/.gemini/antigravity/brain/ec7a5818-b370-4eca-a06d-6ad186981439', 'verified_no_hero_event.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('Saved screenshot to:', screenshotPath);
  
  await browser.close();
})();
