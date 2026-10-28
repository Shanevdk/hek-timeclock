// Money on a quote or an invoice, worked out the same way everywhere — the
// editor, the printed copy, the customer's page and the server — so the figure
// a customer signs for is the figure the office sees, to the cent.
//
// Each line is rounded to the cent; the subtotal is the sum of those lines; tax
// is the subtotal's tax rounded to the cent; the total is subtotal + tax. All of
// it in whole cents, so floating point never decides a penny.
//
// Loaded as a plain <script> (window.HEKTotals) and require()d by Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HEKTotals = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A dollar amount as whole cents, rounded the way a person would: 100.575
  // (which a computer holds as 100.57499999…) is 10058, not 10057.
  const toCents = (x) => Math.round(Number(((Number(x) || 0) * 100).toFixed(6)));
  const roundCents = (c) => Math.round(Number((Number(c) || 0).toFixed(6)));

  const lineCents = (it) => toCents((Number(it && it.qty) || 0) * (Number(it && it.unit_price) || 0));
  const lineAmount = (it) => lineCents(it) / 100;

  function totalsOf(items, taxRate) {
    const sub = (items || []).reduce((s, it) => s + lineCents(it), 0);
    const rate = Number(taxRate) || 0;
    const tax = roundCents((sub * rate) / 100);
    return { subtotal: sub / 100, tax: tax / 100, total: (sub + tax) / 100, taxRate: rate };
  }

  // A deposit is a percentage of the total, rounded to the cent.
  const deposit = (total, pct) => roundCents((toCents(total) * (Number(pct) || 0)) / 100) / 100;

  return { totalsOf, lineAmount, deposit, toCents };
});
