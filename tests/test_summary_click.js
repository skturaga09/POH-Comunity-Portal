const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  
  await page.goto('https://poh-community-portal.web.app/?v=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Sign-in bypass by triggering enterPortal mock
  await page.evaluate(() => {
    window.approvedProfile = { role: 'admin', email: 'test@gmail.com', name: 'Test Resident' };
    if (window.enterPortal) {
      window.enterPortal({ displayName: 'Test Resident', email: 'test@gmail.com' });
    }
  });

  await page.waitForTimeout(2000);

  await page.evaluate(() => {
    if (window.activateRoute) window.activateRoute('eventDashboard');
    const exportBtn = document.getElementById('exportEventSummaryAction');
    if (exportBtn) exportBtn.click();
  });
  
  await page.waitForTimeout(1000);
  
  const screenshotPath = path.join('/Users/turagasanthoshkumar/.gemini/antigravity/brain/ec7a5818-b370-4eca-a06d-6ad186981439', 'verified_summary_modal_open.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('Saved summary modal screenshot to:', screenshotPath);
  
  await browser.close();
})();
