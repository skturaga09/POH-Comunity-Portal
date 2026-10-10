// Run: node --test functions/
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractUpiReference } = require("./upi-ref");

test("GPay: label and value on separate lines", () => {
  assert.equal(extractUpiReference("Completed\n₹500\nUPI transaction ID\n412345678901\nTo: POH SPOC"), "412345678901");
});
test("PhonePe: UTR beats the T-prefixed transaction id and phone number", () => {
  assert.equal(extractUpiReference("Transaction ID\nT2410101234567890123\nUTR: 498765432109\nDebited from 9876543210"), "498765432109");
});
test("Paytm: UPI Ref No with OCR-split digits", () => {
  assert.equal(extractUpiReference("UPI Ref No: 4123 4567 8901\nPaid to POH"), "412345678901");
});
test("falls back to the single 12-digit number", () => {
  assert.equal(extractUpiReference("Payment successful\n312345678901\n10 Oct 2026"), "312345678901");
});
test("phone and amount digits are not merged into a reference", () => {
  assert.equal(extractUpiReference("Phone 98765 43210 12"), "");
});
test("ambiguous or absent → empty", () => {
  assert.equal(extractUpiReference("111111111111 and 222222222222"), "");
  assert.equal(extractUpiReference("Paid ₹500 to 9876543210"), "");
  assert.equal(extractUpiReference(""), "");
});
