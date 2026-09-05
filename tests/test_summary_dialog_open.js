const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  
  await page.goto('https://poh-community-portal.web.app/?v=' + Date.now(), { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  await page.evaluate(() => {
    window.portalData = {
      events: [{ id: 'independence_2026', name: 'Independence Day Celebration 2026', status: 'Completed', date: '2026-08-15' }],
      finance: {
        independence_2026: {
          collected: 30500,
          spent: 567,
          contributions: Array(61).fill({ flat: '101', amount: 500 }),
          expenses: [
            { id: '1', category: 'Decor & Lights', description: 'Balcony Lights & Flowers', amount: 350, status: 'Approved', paidBy: 'Treasurer' },
            { id: '2', category: 'Refreshments', description: 'Sweets & Tea for residents', amount: 217, status: 'Approved', paidBy: 'Joint Secretary' }
          ]
        }
      },
      residents: Array(147).fill({ flat: '101', floor: '1' })
    };
    window.activeEventId = 'independence_2026';
    window.approvedProfile = { role: 'admin' };
    
    document.getElementById('accessWrap').hidden = true;
    document.getElementById('portal').hidden = false;
    
    window.openEventSummaryReport();

    const d = document.getElementById('eventSummaryReportModal');
    // Ensure form-panel and summaryReportBody have explicit styling for previewing content
    const panel = d.querySelector('.form-panel');
    if (panel) {
      panel.style.maxHeight = 'none';
      panel.style.overflow = 'visible';
    }
    d.removeAttribute('hidden');
    d.setAttribute('open', '');
    d.style.display = 'block';
    d.style.position = 'relative';
    d.style.margin = '40px auto';
    d.style.width = '820px';
    d.style.height = 'auto';
    d.style.maxHeight = 'none';
    d.style.boxShadow = '0 20px 60px rgba(0,0,0,0.5)';
  });

  await page.waitForTimeout(1000);

  const screenshotPath = path.join('/Users/turagasanthoshkumar/.gemini/antigravity/brain/ec7a5818-b370-4eca-a06d-6ad186981439', 'verified_summary_modal_open.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('Saved page screenshot to:', screenshotPath);
  
  await browser.close();
})();
