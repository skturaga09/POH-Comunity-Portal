const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  
  await page.goto('https://poh-community-portal.web.app/?v=' + Date.now(), { waitUntil: 'networkidle' });
  
  // Wait for portal launcher scripts to initialize
  await page.waitForTimeout(2000);

  await page.evaluate(() => {
    document.querySelector('.access-wrap').hidden = true;
    const portal = document.querySelector('.portal');
    portal.hidden = false;
    
    // Trigger route to eventDashboard
    const exploreBtn = document.getElementById('homeExploreEvents');
    if (exploreBtn) exploreBtn.click();
    
    const firstEventBtn = document.querySelector('[data-open-event]');
    if (firstEventBtn) firstEventBtn.click();
    
    setTimeout(() => {
      const exportBtn = document.getElementById('exportEventSummaryAction');
      if (exportBtn) exportBtn.click();
    }, 500);
  });
  
  await page.waitForTimeout(2000);
  
  const screenshotPath = path.join('/Users/turagasanthoshkumar/.gemini/antigravity/brain/ec7a5818-b370-4eca-a06d-6ad186981439', 'verified_summary_modal.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('Saved summary modal screenshot to:', screenshotPath);
  
  await browser.close();
})();
