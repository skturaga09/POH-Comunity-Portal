const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  
  // Navigate to live hosted site with cache buster
  await page.goto('https://poh-community-portal.web.app/?v=' + Date.now(), { waitUntil: 'networkidle' });
  
  // Activate portal home UI
  await page.evaluate(() => {
    document.querySelector('.access-wrap').hidden = true;
    const portal = document.querySelector('.portal');
    portal.hidden = false;
    portal.classList.add('home-active');
    if (window.renderHome) window.renderHome();
  });
  
  await page.waitForTimeout(1000);
  
  const screenshotPath = path.join('/Users/turagasanthoshkumar/.gemini/antigravity/brain/ec7a5818-b370-4eca-a06d-6ad186981439', 'verified_hero_clean.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('Saved screenshot to:', screenshotPath);
  
  await browser.close();
})();
