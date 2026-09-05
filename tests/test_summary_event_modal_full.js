const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  
  await page.goto('https://poh-community-portal.web.app/?v=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);

  await page.evaluate(() => {
    window.portalData = window.portalData || {};
    window.portalData.events = [{ id: 'independence_2026', name: 'Independence Day Celebration 2026', status: 'Completed', date: '2026-08-15' }];
    window.portalData.finance = { independence_2026: { collected: 30500, spent: 567, contributions: Array(61).fill({ flat: '101', amount: 500 }), expenses: [{ id: '1', category: 'Decor', description: 'Balcony Lights', amount: 567, status: 'Approved', paidBy: 'Treasurer' }] } };
    window.portalData.residents = Array(147).fill({ flat: '101', floor: '1' });
    window.activeEventId = 'independence_2026';

    document.getElementById('accessWrap').hidden = true;
    const portal = document.getElementById('portal');
    portal.hidden = false;
    portal.classList.remove('home-active');
    
    document.getElementById('homePage').hidden = true;
    document.getElementById('eventDashboardPage').hidden = false;
    
    window.openEventSummaryReport();
  });

  await page.waitForTimeout(1500);
  
  const screenshotPath = path.join('/Users/turagasanthoshkumar/.gemini/antigravity/brain/ec7a5818-b370-4eca-a06d-6ad186981439', 'verified_summary_modal_open.png');
  // Take screenshot of modal element specifically using boundingBox or screenshot on element
  const modalHandle = await page.$('#eventSummaryReportModal');
  if (modalHandle) {
    await modalHandle.screenshot({ path: screenshotPath });
  } else {
    await page.screenshot({ path: screenshotPath });
  }
  console.log('Saved summary modal element screenshot to:', screenshotPath);
  
  await browser.close();
})();
