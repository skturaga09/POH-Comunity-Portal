const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  
  await page.goto('https://poh-community-portal.web.app/?v=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);

  await page.evaluate(() => {
    document.getElementById('accessWrap').hidden = true;
    const portal = document.getElementById('portal');
    portal.hidden = false;
    portal.classList.remove('home-active');
    
    // Hide home page and show event dashboard page
    document.getElementById('homePage').hidden = true;
    document.getElementById('eventDashboardPage').hidden = false;
    
    if (window.openEventSummaryReport) {
      window.openEventSummaryReport();
    }
  });

  await page.waitForTimeout(1000);
  
  const screenshotPath = path.join('/Users/turagasanthoshkumar/.gemini/antigravity/brain/ec7a5818-b370-4eca-a06d-6ad186981439', 'verified_summary_modal_open.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('Saved summary modal screenshot to:', screenshotPath);
  
  await browser.close();
})();
