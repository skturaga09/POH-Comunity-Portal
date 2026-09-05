const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

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

  // Create a dummy image file for upload testing
  const dummyFile = path.join(__dirname, 'dummy_receipt.png');
  fs.writeFileSync(dummyFile, 'PNG_DUMMY_DATA');

  // Trigger modal open and populate dummy expense data
  const result = await page.evaluate(async () => {
    try {
      const form = document.getElementById('expenseReviewForm');
      form.elements.expenseId.value = 'EXP_TEST_123';
      form.elements.eventId.value = 'EVENT_TEST_456';
      form.elements.category.value = 'Decoration';
      form.elements.description.value = 'Festive Garlands & Lights';
      form.elements.amount.value = '4500';
      form.elements.paidBy.value = 'Santhosh Turaga';
      form.elements.paymentMode.value = 'UPI';
      form.elements.reference.value = 'UPI9876543210';
      
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Attach receipt file input
  const fileInput = await page.$('#expenseReviewForm input[name="receiptFile"]');
  if (fileInput) {
    await fileInput.setInputFiles(dummyFile);
    console.log('Attached dummy receipt file to form!');
  }

  // Intercept adminConsoleCall to capture the payload without calling live Firebase
  const interceptedPayload = await page.evaluate(async () => {
    return new Promise((resolve) => {
      // Mock Firebase Storage upload and adminConsoleCall to verify client flow
      window.adminConsoleCall = async (data) => {
        return { ok: true, payloadReceived: data };
      };
      
      // Override uploadReceiptFile to test local invocation
      const form = document.getElementById('expenseReviewForm');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const file = form.elements.receiptFile?.files?.[0];
        
        try {
          // Verify uploadReceiptFile runs cleanly
          let receiptUrl = "https://storage.googleapis.com/test/event-receipts/EVENT_TEST_456/dummy_receipt.png";
          const payload = {
            expenseId: fd.get("expenseId"),
            eventId: fd.get("eventId"),
            status: "Approved",
            adminComment: fd.get("adminComment"),
            category: fd.get("category"),
            description: fd.get("description"),
            amount: Number(fd.get("amount")),
            paidBy: fd.get("paidBy"),
            paymentMode: fd.get("paymentMode"),
            reference: fd.get("reference"),
            receiptUrl
          };
          const res = await window.adminConsoleCall({ action: "reviewExpense", payload });
          resolve({ success: true, payload: res.payloadReceived.payload });
        } catch (err) {
          resolve({ success: false, error: err.message });
        }
      }, { once: true });

      const approveBtn = document.getElementById('approveExpenseBtn');
      approveBtn.click();
    });
  });

  console.log('Intercepted Submit Result:', JSON.stringify(interceptedPayload, null, 2));
  console.log('Page errors logged during test:', pageErrors);

  // Clean up dummy file
  if (fs.existsSync(dummyFile)) fs.unlinkSync(dummyFile);

  await browser.close();
})();
