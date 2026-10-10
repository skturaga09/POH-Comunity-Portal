// Pull the UPI transaction reference (12-digit UTR / RRN) out of OCR'd payment-screenshot
// text. GPay says "UPI transaction ID", PhonePe "UTR", Paytm "UPI Ref No" — all print the
// same 12-digit number, so prefer a 12-digit number next to one of those labels, then
// fall back to the only 12-digit number on the screen. Returns "" when unsure.
const LABEL = /(utr|upi\s*(transaction\s*id|ref(erence)?(\s*no\.?|\s*number|\s*id)?)|rrn|bank\s*ref(erence)?(\s*no\.?)?|transaction\s*ref(erence)?(\s*no\.?)?)/i;
const TWELVE = /(?<!\d)\d{12}(?!\d)/g;

function extractUpiReference(text) {
  // Apps print the reference in 4-digit groups ("4123 4567 8901"); join only that shape so
  // unrelated numbers (phone, amount) never merge into a fake 12-digit reference.
  const lines = String(text || "").split(/\r?\n/).map((line) => line.replace(/(?<!\d)(\d{4})[  ](\d{4})[  ](\d{4})(?!\d)/g, "$1$2$3"));
  for (let i = 0; i < lines.length; i += 1) {
    if (!LABEL.test(lines[i])) continue;
    // The value sits on the label's line or the next one.
    const hit = (lines[i].match(TWELVE) || lines[i + 1]?.match(TWELVE) || [])[0];
    if (hit) return hit;
  }
  const all = [...new Set(lines.join("\n").match(TWELVE) || [])];
  return all.length === 1 ? all[0] : "";
}

module.exports = { extractUpiReference };
