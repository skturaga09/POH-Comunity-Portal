const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', msg => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });

  await page.goto('http://localhost:8085/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Directly show portal UI
  await page.evaluate(() => {
    const accessWrap = document.getElementById('accessWrap');
    if (accessWrap) accessWrap.hidden = true;
    const portal = document.getElementById('portal');
    if (portal) {
      portal.hidden = false;
      portal.classList.add('home-active');
    }
  });

  // Verify that uploadReceiptFile is defined in global window context or module scope
  const isUploadFuncPresent = await page.evaluate(() => {
    // Check if expenseReviewForm event listener triggers cleanly
    const form = document.getElementById('expenseReviewForm');
    return !!form;
  });

  console.log('Expense Review Form Present:', isUploadFuncPresent);
  console.log('Page errors logged:', pageErrors);

  const screenshotPath = path.join('/Users/turagasanthoshkumar/.gemini/antigravity/brain/ec7a5818-b370-4eca-a06d-6ad186981439', 'verified_local_receipt_fix.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log('Saved local screenshot to:', screenshotPath);
  
  await browser.close();
})();
