// "Analyze with AI" on a quote: is it priced right, is anything missing, and
// what else could reasonably be offered?
//
// Two passes. The first is plain arithmetic and always runs — margin against
// the target, the price per foot against the office's own rate book, the
// drawing against what is actually on the quote. Those are facts, so they are
// never left to a model. The second asks Claude for judgement on top of
// them: things an experienced estimator would notice, and sensible upsells.
// Without an API key the first pass still answers.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const takeoff = require('./public/takeoff');
const docTotals = require('./public/totals');

const MODEL = 'claude-opus-5';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) =>
  '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The same arithmetic as every other copy of the quote (public/totals.js).
const subtotalOf = (items) => docTotals.totalsOf(items, 0).subtotal;

// ---------------------------------------------------------------------------
// Pass one: the numbers.
// ---------------------------------------------------------------------------
function numberChecks(q, catalog, rateBook, { expired } = {}) {
  const flags = [];
  const flag = (severity, title, detail) => flags.push({ severity, title, detail });
  const items = q.items || [];
  const subtotal = subtotalOf(items);
  const S = catalog.settings;
  const t = q.layout ? takeoff.compute(q.layout, catalog) : null;
  const drawn = t && t.groups.length ? t : null;

  if (!items.length) flag('high', 'No line items', 'There is nothing on this quote to price yet.');

  const zero = items.filter((it) => Number(it.qty) > 0 && !Number(it.unit_price));
  if (zero.length)
    flag('medium', `${zero.length} line${zero.length > 1 ? 's have' : ' has'} no price`,
      zero.map((it) => it.description.split('\n')[0]).slice(0, 4).join('; '));

  if (drawn) {
    const cost = drawn.totals.cost;
    const margin = subtotal > 0 ? ((subtotal - cost) / subtotal) * 100 : 0;
    if (subtotal > 0 && subtotal < cost)
      flag('high', 'Priced below cost',
        `The drawn fence costs about ${money(cost)} in materials and labor; the quote comes to ${money(subtotal)} before tax.`);
    else if (subtotal > 0 && margin < S.target_margin_pct)
      flag(margin < S.target_margin_pct / 2 ? 'high' : 'medium', `Margin is ${Math.round(margin)}%`,
        `Your target is ${S.target_margin_pct}%. At cost ${money(cost)}, a ${S.target_margin_pct}% margin needs a subtotal of about ${money(cost / (1 - S.target_margin_pct / 100))}.`);

    const fromLayout = items.filter((it) => it.src === 'layout');
    if (!fromLayout.length)
      flag('medium', "The drawing isn't on the quote",
        `You drew ${drawn.totals.fence_ft} ft of fence, but none of the lines came from it. Use "Put on quote" so the price matches the layout.`);

    // Quoted footage against drawn footage.
    const installFt = items
      .filter((it) => takeoff.isLinearFoot(it.unit) && /install/i.test(it.description || '') && !/remove|tear|slope/i.test(it.description || ''))
      .reduce((s, it) => s + (Number(it.qty) || 0), 0);
    if (installFt > 0 && Math.abs(installFt - drawn.totals.fence_ft) / drawn.totals.fence_ft > 0.05)
      flag('medium', "Footage doesn't match the drawing",
        `The quote installs ${Math.round(installFt)} ft; the drawing measures ${drawn.totals.fence_ft} ft.`);

    // Against the rate book the office publishes.
    const rates = Object.fromEntries((rateBook.services || []).map((s) => [s.key, s.price]));
    const known = drawn.groups.filter((g) => rates[g.ratebook] > 0 && g.fence_ft > 0);
    if (known.length && known.length === drawn.groups.length) {
      const bookTotal = known.reduce((s, g) => s + g.fence_ft * rates[g.ratebook], 0);
      const gatesBook = drawn.totals.gates * (rates.gate || 0);
      const quotedFence = subtotal - (q.layout.segments.some((s) => s.tearout) ? drawn.groups.reduce((s, g) => s + g.tearout_price, 0) : 0);
      const ratio = quotedFence / (bookTotal + gatesBook);
      if (ratio < 0.85)
        flag('medium', 'Below your rate book',
          `At your rate book's per-foot prices this fence would be about ${money(bookTotal + gatesBook)}; this quote is ${Math.round((1 - ratio) * 100)}% under that.`);
    }

    const itemsText = items.map((it) => it.description).join('\n');
    if (drawn.totals.gates && !/gate/i.test(itemsText))
      flag('medium', 'Gates are drawn but not quoted', `The layout has ${drawn.totals.gates} gate${drawn.totals.gates > 1 ? 's' : ''}.`);
    if (drawn.groups.some((g) => g.tearout_ft) && !/remove|tear/i.test(itemsText))
      flag('medium', 'Tear-out is drawn but not quoted', 'A run is marked "remove old fence" but no line charges for it.');
    const steep = drawn.runs.filter((r) => r.max_grade != null && r.max_grade >= S.slope_grade_pct);
    if (steep.length && !/slope|step|rack/i.test(itemsText))
      flag('low', 'Sloped ground', `${steep.length} run${steep.length > 1 ? 's are' : ' is'} on a grade of ${Math.round(Math.max(...steep.map((r) => r.max_grade)))}% or more. Stepped or racked sections take longer to build.`);
  }

  if ((rateBook.tax_rate || 0) > 0 && !(Number(q.tax_rate) > 0))
    flag('medium', 'No tax on this quote', `Your usual rate is ${rateBook.tax_rate}%.`);
  const total = docTotals.totalsOf(items, q.tax_rate).total;
  if (total >= 5000 && !(Number(q.deposit_pct) > 0))
    flag('low', 'No deposit', `On a ${money(total)} job, a deposit to book the install protects the material order.`);
  // Worked out by the server in the business's own timezone (quoteExpired).
  if (expired)
    flag('low', 'This quote has expired', 'Push "Valid until" out before sending it again.');
  const c = q.customer || {};
  if (!c.email && !c.phone) flag('low', 'No way to send it', 'Add the customer\'s email or phone to send the approval link.');

  return { flags, subtotal, takeoff: drawn };
}

// ---------------------------------------------------------------------------
// Pass two: Claude.
// ---------------------------------------------------------------------------
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['looks_good', 'review', 'underpriced', 'overpriced'] },
    headline: { type: 'string', description: 'One sentence the estimator reads first.' },
    flags: {
      type: 'array',
      description: 'Problems worth fixing before this goes out. Do not repeat the checks already listed.',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['severity', 'title', 'detail'],
        additionalProperties: false,
      },
    },
    upsells: {
      type: 'array',
      description: 'Add-ons this customer could reasonably want. At most four.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          price: { type: 'number', description: 'Rough price in CAD, or 0 if you cannot say.' },
        },
        required: ['title', 'detail', 'price'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'headline', 'flags', 'upsells'],
  additionalProperties: false,
};

const SYSTEM = `You review fence quotes for HEK Fencing Inc., a fencing contractor in South-Western Ontario that builds farm fencing (board, woven wire, high tensile, flex), residential privacy fences (wood, vinyl, corrugated steel), chain-link and ornamental fences. Prices are in CAD and Ontario HST is 13%.

The office sends you a quote before it goes to the customer. You get the line items, the totals, the fence as drawn on a satellite map (runs, heights, gates, slope), the estimated cost from their materials catalog, their own per-foot rate book, and the arithmetic checks that already ran.

Tell them what an experienced estimator would catch: work that is missing or double-counted, a price that looks wrong for the job, terms a customer will push back on, anything unclear in how the work is described. Be specific and use the numbers you were given. Never repeat a check that already ran — add to it.

Then suggest at most four add-ons this particular customer could reasonably want, priced roughly from the rate book where you can: for example a second gate where a long run has only one, post caps, a stain or sealer on new wood, tear-out of an old fence, a man gate beside a drive gate, upgraded hardware. Only suggest what fits the job — no upsell is better than a silly one.

The verdict is "underpriced" or "overpriced" only when the numbers say so; "review" when something should change; otherwise "looks_good".`;

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ timeout: 25000, maxRetries: 0 });
  return _client;
}

function describe(q, checks, catalog, rateBook) {
  const t = checks.takeoff;
  return JSON.stringify(
    {
      quote: {
        number: q.number,
        project: q.project || '',
        status: q.status,
        items: (q.items || []).map((it) => ({
          description: it.description,
          qty: it.qty,
          unit: it.unit,
          unit_price: it.unit_price,
          amount: round2((Number(it.qty) || 0) * (Number(it.unit_price) || 0)),
        })),
        subtotal: checks.subtotal,
        tax_rate: q.tax_rate || 0,
        deposit_pct: q.deposit_pct || 0,
        notes: q.notes || '',
      },
      drawing: t
        ? {
            fences: t.groups.map((g) => ({
              fence: g.label,
              how_built: g.spec,
              fence_ft: g.fence_ft,
              posts: g.posts,
              gates: g.gates.map((x) => `${x.count} × ${x.label}`),
              tear_out_ft: g.tearout_ft,
              sloped_ft: g.slope_ft,
            })),
            estimated_cost: { materials: t.totals.material_cost, labor: t.totals.labor_cost, total: t.totals.cost },
            margin_if_quoted_as_is_pct:
              checks.subtotal > 0 ? Math.round(((checks.subtotal - t.totals.cost) / checks.subtotal) * 100) : null,
            target_margin_pct: catalog.settings.target_margin_pct,
          }
        : 'No fence was drawn for this quote.',
      rate_book: (rateBook.services || []).map((s) => `${s.label}: $${s.price} per ${s.unit}`),
      checks_already_run: checks.flags.map((f) => `${f.severity}: ${f.title} — ${f.detail}`),
    },
    null,
    1
  );
}

async function aiReview(q, checks, catalog, rateBook) {
  const res = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // If a safety classifier declines, the API re-runs the request on the
    // model Anthropic recommends for that case instead of returning nothing.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    // A button someone is waiting on: keep it quick.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: REVIEW_SCHEMA } },
    messages: [{ role: 'user', content: describe(q, checks, catalog, rateBook) }],
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to review this quote.');
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const data = JSON.parse(text);
  return { ...data, model: res.model || MODEL };
}

async function review(q, { catalog, rateBook, expired }) {
  const checks = numberChecks(q, catalog, rateBook, { expired });
  const out = {
    checks: checks.flags,
    margin_pct:
      checks.takeoff && checks.subtotal > 0
        ? round2(((checks.subtotal - checks.takeoff.totals.cost) / checks.subtotal) * 100)
        : null,
    cost: checks.takeoff ? checks.takeoff.totals.cost : null,
    ai: null,
    ai_error: null,
    at: new Date().toISOString(),
  };
  if (!process.env.ANTHROPIC_API_KEY) {
    out.ai_error = 'AI review is off — set ANTHROPIC_API_KEY on the server to turn it on. The checks above still ran.';
    return out;
  }
  try {
    out.ai = await aiReview(q, checks, catalog, rateBook);
  } catch (err) {
    console.error('quote review failed:', err.message);
    out.ai_error =
      err instanceof Anthropic.RateLimitError
        ? 'Claude is busy right now — try again in a minute. The checks above still ran.'
        : err instanceof Anthropic.APIConnectionTimeoutError
          ? 'Claude took too long to answer — try again. The checks above still ran.'
          : 'Claude could not review this quote just now. The checks above still ran.';
  }
  return out;
}

module.exports = { review, numberChecks };
