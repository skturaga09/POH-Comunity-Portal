const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  
  await page.goto('https://poh-community-portal.web.app/?v=' + Date.now(), { waitUntil: 'networkidle' });
  
  // Wait 4 seconds for full Firestore data loading
  await page.waitForTimeout(4000);

  await page.evaluate(() => {
    document.querySelector('.access-wrap').hidden = true;
    const portal = document.querySelector('.portal');
    portal.hidden = false;
    
    // Switch to event dashboard directly and open modal
    if (window.renderEventDashboard) {
      window.renderEventDashboard();
      const exportBtn = document.getElementById('exportEventSummaryAction');
      if (exportBtn) exportBtn.click();
    }
  });
  
  await page.waitForTimeout(1000);
  
  const screenshotPath = path.join('/Users/turagasanthoshkumar/.gemini/antigravity/brain/ec7a5818-b370-4eca-a06d-6ad186981439', 'verified_summary_modal_open.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('Saved summary modal screenshot to:', screenshotPath);
  
  await browser.close();
})();
