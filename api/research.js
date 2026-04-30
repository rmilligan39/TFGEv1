const https = require('https');

/* ═══════════════════════════════════════════════════════════════════════════
   POLYGON.IO DATA LAYER
   ═══════════════════════════════════════════════════════════════════════════ */

const POLYGON_KEY = process.env.POLYGON_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const POLYGON_BASE = 'https://api.polygon.io';

function polygonGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${POLYGON_BASE}${path}${sep}apiKey=${POLYGON_KEY}`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TFG-Research/1.0' } }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.status === 'ERROR' || parsed.error) {
            reject(new Error(parsed.error || parsed.message || `Polygon error on ${path}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Failed to parse Polygon response for ${path}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function anthropicPost(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (e) { reject(new Error('Failed to parse Anthropic response')); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/* ── Date helpers ─────────────────────────────────────────────────────── */
function todayStr() { return new Date().toISOString().slice(0, 10); }
function yearsAgo(n) {
  const d = new Date(); d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}
function fmtM(v) { return v != null ? (v / 1e6).toFixed(1) : null; }
function fmtPct(v) { return v != null ? (v * 100).toFixed(1) : null; }
function safe(v, dec = 2) { return v != null ? Number(v).toFixed(dec) : null; }

/* ═══════════════════════════════════════════════════════════════════════════
   FETCH ALL DATA FOR A TICKER
   ═══════════════════════════════════════════════════════════════════════════ */

async function fetchTickerData(ticker) {
  const T = ticker.toUpperCase();

  // ── 1. Company details ──────────────────────────────────────────────
  const detailsRes = await polygonGet(`/v3/reference/tickers/${T}`);
  const co = detailsRes.results || {};

  // ── 2. Annual financials (last 6 years) ─────────────────────────────
  const finRes = await polygonGet(
    `/vX/reference/financials?ticker=${T}&timeframe=annual&order=desc&limit=6&sort=period_of_report_date`
  );
  const filings = (finRes.results || []).reverse(); // oldest first

  // ── 3. Quarterly financials (last 8 quarters for TTM) ───────────────
  const qFinRes = await polygonGet(
    `/vX/reference/financials?ticker=${T}&timeframe=quarterly&order=desc&limit=8&sort=period_of_report_date`
  );
  const quarters = (qFinRes.results || []);

  // ── 4. Price history (6 years of monthly bars for valuation charts) ──
  const priceRes = await polygonGet(
    `/v2/aggs/ticker/${T}/range/1/month/${yearsAgo(6)}/${todayStr()}?adjusted=true&sort=asc&limit=100`
  );
  const monthlyBars = (priceRes.results || []);

  // ── 5. Daily bars for annual highs/lows + recent price ──────────────
  const dailyRes = await polygonGet(
    `/v2/aggs/ticker/${T}/range/1/day/${yearsAgo(6)}/${todayStr()}?adjusted=true&sort=asc&limit=2000`
  );
  const dailyBars = (dailyRes.results || []);

  // ── 6. S&P 500 monthly bars (for relative valuation) ────────────────
  const spRes = await polygonGet(
    `/v2/aggs/ticker/SPY/range/1/month/${yearsAgo(6)}/${todayStr()}?adjusted=true&sort=asc&limit=100`
  );
  const spyMonthly = (spRes.results || []);

  // ── 7. Dividend history ─────────────────────────────────────────────
  const divRes = await polygonGet(`/v3/reference/dividends?ticker=${T}&order=desc&limit=30`);
  const divs = (divRes.results || []);

  // ── 8. Snapshot (current price, volume) ─────────────────────────────
  let snapshot = null;
  try {
    const snapRes = await polygonGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${T}`);
    snapshot = snapRes.ticker || null;
  } catch (e) { /* snapshot may require paid plan — fall back to last daily bar */ }

  return { co, filings, quarters, monthlyBars, dailyBars, spyMonthly, divs, snapshot, ticker: T };
}


/* ═══════════════════════════════════════════════════════════════════════════
   COMPUTE DERIVED METRICS
   ═══════════════════════════════════════════════════════════════════════════ */

function computeMetrics(raw) {
  const { co, filings, quarters, monthlyBars, dailyBars, spyMonthly, divs, snapshot, ticker } = raw;

  // ── Recent price ────────────────────────────────────────────────────
  let recentPrice = null;
  if (snapshot && snapshot.day) {
    recentPrice = snapshot.day.c || snapshot.lastTrade?.p || null;
  }
  if (!recentPrice && dailyBars.length > 0) {
    recentPrice = dailyBars[dailyBars.length - 1].c;
  }

  // ── Company info ────────────────────────────────────────────────────
  const companyName = co.name || ticker;
  const marketCap = co.market_cap || null;
  const sicDesc = co.sic_description || '';
  const exchange = co.primary_exchange || '';
  const sharesOut = co.share_class_shares_outstanding || co.weighted_shares_outstanding || null;
  const homepage = co.homepage_url || '';

  // ── Process annual financials ───────────────────────────────────────
  const annuals = filings.map(f => {
    const ic = f.financials?.income_statement || {};
    const bs = f.financials?.balance_sheet || {};
    const cf = f.financials?.cash_flow_statement || {};
    const period = f.fiscal_period || '';
    const year = f.fiscal_year || (f.end_date || '').slice(0, 4);
    const so = ic.basic_average_shares?.value || bs.equity_attributable_to_parent?.value ? null : null;
    const shares = f.financials?.income_statement?.basic_average_shares?.value || sharesOut;

    const revenue = ic.revenues?.value || null;
    const netIncome = ic.net_income_loss?.value || null;
    const opIncome = ic.operating_income_loss?.value || null;
    const grossProfit = ic.gross_profit?.value || null;
    const eps = ic.basic_earnings_per_share?.value || (netIncome && shares ? netIncome / shares : null);

    const totalAssets = bs.assets?.value || null;
    const totalEquity = bs.equity_attributable_to_parent?.value || null;
    const ltDebt = bs.long_term_debt?.value || bs.noncurrent_liabilities?.value || null;
    const currentAssets = bs.current_assets?.value || null;
    const currentLiab = bs.current_liabilities?.value || null;
    const workingCap = (currentAssets && currentLiab) ? currentAssets - currentLiab : null;
    const bookVal = totalEquity && shares ? totalEquity / shares : null;

    const opCF = cf.net_cash_flow_from_operating_activities?.value || null;
    const capex = cf.net_cash_flow_from_investing_activities?.value || null; // typically negative
    const actualCapex = capex ? Math.abs(capex) : null; // approximate — polygon doesn't split capex cleanly
    const fcf = opCF != null ? opCF - (actualCapex || 0) : null;

    // EBITDA approximation: operating income + D&A
    const da = ic.depreciation_and_amortization?.value || cf.depreciation_amortization_and_accretion?.value || 0;
    const ebitda = opIncome != null ? opIncome + Math.abs(da) : null;

    return {
      year,
      revenue, netIncome, opIncome, grossProfit, ebitda,
      eps, shares,
      totalEquity, ltDebt, currentAssets, currentLiab, workingCap, bookVal,
      opCF, capex: actualCapex, fcf,
      ebitdaMargin: revenue && ebitda ? ebitda / revenue : null,
      opMargin: revenue && opIncome ? opIncome / revenue : null,
      netMargin: revenue && netIncome ? netIncome / revenue : null,
      roe: totalEquity && netIncome ? netIncome / totalEquity : null,
      rotc: (totalEquity && ltDebt && netIncome) ? netIncome / (totalEquity + (ltDebt || 0)) : null,
    };
  });

  // ── TTM from quarters ───────────────────────────────────────────────
  const ttmQ = quarters.slice(0, 4);
  let ttmRevenue = 0, ttmNetIncome = 0, ttmEBITDA = 0, ttmFCF = 0;
  ttmQ.forEach(q => {
    const ic = q.financials?.income_statement || {};
    const cf = q.financials?.cash_flow_statement || {};
    ttmRevenue += (ic.revenues?.value || 0);
    ttmNetIncome += (ic.net_income_loss?.value || 0);
    const opInc = ic.operating_income_loss?.value || 0;
    const da = ic.depreciation_and_amortization?.value || cf.depreciation_amortization_and_accretion?.value || 0;
    ttmEBITDA += (opInc + Math.abs(da));
    const opcf = cf.net_cash_flow_from_operating_activities?.value || 0;
    const capx = Math.abs(cf.net_cash_flow_from_investing_activities?.value || 0);
    ttmFCF += (opcf - capx);
  });

  const ttmEPS = sharesOut && ttmNetIncome ? ttmNetIncome / sharesOut : null;

  // ── Valuation ratios ────────────────────────────────────────────────
  const trailingPE = recentPrice && ttmEPS && ttmEPS > 0 ? recentPrice / ttmEPS : null;
  const ev = marketCap && annuals.length > 0 ?
    marketCap + (annuals[annuals.length - 1].ltDebt || 0) - (annuals[annuals.length - 1].currentAssets || 0) * 0.3 : null;
  const evEbitdaTTM = ev && ttmEBITDA > 0 ? ev / ttmEBITDA : null;
  const priceFCF = marketCap && ttmFCF > 0 ? marketCap / ttmFCF : null;

  // ── Annual price ranges from daily bars ─────────────────────────────
  const priceRanges = {};
  dailyBars.forEach(bar => {
    const yr = new Date(bar.t).getFullYear().toString();
    if (!priceRanges[yr]) priceRanges[yr] = { high: -Infinity, low: Infinity };
    if (bar.h > priceRanges[yr].high) priceRanges[yr].high = bar.h;
    if (bar.l < priceRanges[yr].low) priceRanges[yr].low = bar.l;
  });

  // ── Monthly closing prices for valuation chart ──────────────────────
  const monthlyPrices = monthlyBars.map(b => ({
    date: new Date(b.t).toISOString().slice(0, 7),
    label: new Date(b.t).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
    close: b.c
  }));

  const spyPrices = spyMonthly.map(b => ({
    date: new Date(b.t).toISOString().slice(0, 7),
    close: b.c
  }));

  // ── Dividends ───────────────────────────────────────────────────────
  const annualDivs = {};
  divs.forEach(d => {
    const yr = (d.pay_date || d.ex_dividend_date || '').slice(0, 4);
    if (yr) annualDivs[yr] = (annualDivs[yr] || 0) + (d.cash_amount || 0);
  });
  const ttmDiv = divs.slice(0, 4).reduce((s, d) => s + (d.cash_amount || 0), 0);
  const divYield = recentPrice && ttmDiv ? ttmDiv / recentPrice : null;

  return {
    ticker,
    companyName,
    exchange,
    sicDesc,
    marketCap,
    sharesOut,
    homepage,
    recentPrice,
    trailingPE,
    evEbitdaTTM,
    priceFCF,
    divYield,
    ttmRevenue, ttmNetIncome, ttmEBITDA, ttmFCF, ttmEPS, ttmDiv,
    ev,
    annuals,
    priceRanges,
    monthlyPrices,
    spyPrices,
    annualDivs,
  };
}


/* ═══════════════════════════════════════════════════════════════════════════
   BUILD PROMPT WITH PRE-COMPUTED DATA
   ═══════════════════════════════════════════════════════════════════════════ */

function buildPrompt(metrics) {
  const m = metrics;
  const today = todayStr();

  // Format annuals into a readable table for Claude
  const annualTable = m.annuals.map(a => {
    return [
      `Year: ${a.year}`,
      `  Revenue: ${a.revenue ? '$' + fmtM(a.revenue) + 'M' : 'N/A'}`,
      `  Net Income: ${a.netIncome ? '$' + fmtM(a.netIncome) + 'M' : 'N/A'}`,
      `  EPS: ${safe(a.eps)}`,
      `  EBITDA: ${a.ebitda ? '$' + fmtM(a.ebitda) + 'M' : 'N/A'}`,
      `  EBITDA Margin: ${fmtPct(a.ebitdaMargin) || 'N/A'}%`,
      `  Op Margin: ${fmtPct(a.opMargin) || 'N/A'}%`,
      `  Net Margin: ${fmtPct(a.netMargin) || 'N/A'}%`,
      `  Book Value/Share: ${safe(a.bookVal)}`,
      `  Shares (M): ${a.shares ? fmtM(a.shares * 1e6) : 'N/A'}`,
      `  Operating CF: ${a.opCF ? '$' + fmtM(a.opCF) + 'M' : 'N/A'}`,
      `  CapEx: ${a.capex ? '$' + fmtM(a.capex) + 'M' : 'N/A'}`,
      `  FCF: ${a.fcf ? '$' + fmtM(a.fcf) + 'M' : 'N/A'}`,
      `  Long-Term Debt: ${a.ltDebt ? '$' + fmtM(a.ltDebt) + 'M' : 'N/A'}`,
      `  Shareholders Equity: ${a.totalEquity ? '$' + fmtM(a.totalEquity) + 'M' : 'N/A'}`,
      `  Working Capital: ${a.workingCap ? '$' + fmtM(a.workingCap) + 'M' : 'N/A'}`,
      `  ROE: ${fmtPct(a.roe) || 'N/A'}%`,
      `  ROTC: ${fmtPct(a.rotc) || 'N/A'}%`,
    ].join('\n');
  }).join('\n\n');

  // Price ranges
  const priceRangeStr = Object.entries(m.priceRanges)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([yr, r]) => `${yr}: H $${r.high.toFixed(2)} / L $${r.low.toFixed(2)}`)
    .join('\n');

  // Dividend by year
  const divStr = Object.entries(m.annualDivs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([yr, amt]) => `${yr}: $${amt.toFixed(2)}/share`)
    .join(', ');

  // Monthly price series for valuation charts (JSON for embedding)
  const monthlyJSON = JSON.stringify(m.monthlyPrices);
  const spyJSON = JSON.stringify(m.spyPrices);

  return `You are a senior equity analyst at The Fedeli Group. Produce a complete, self-contained HTML equity research report for:

**${m.companyName} (${m.ticker})**
Exchange: ${m.exchange} | Sector: ${m.sicDesc}

CRITICAL OUTPUT RULE: Return ONLY valid HTML. Your entire response must begin with <!DOCTYPE html> and end with </html>. Do not output markdown code fences, backticks, or any text outside the HTML document.

The HTML must contain:
- All CSS in an embedded <style> block
- Chart.js loaded from https://cdn.jsdelivr.net/npm/chart.js (script tag in <head>)
- All JavaScript in a <script> block just before </body>
- No other external dependencies

══════════════════════════════════════════
PRE-COMPUTED DATA FROM POLYGON.IO
══════════════════════════════════════════

Use ONLY the data below. Do NOT fabricate or hallucinate any financial numbers. If a field shows N/A, display "—" in the report. For forward estimates, you may project based on historical trends and state assumptions — mark all estimates with (E).

CURRENT METRICS (as of ${today}):
  Recent Price: $${safe(m.recentPrice)}
  Market Cap: $${m.marketCap ? (m.marketCap / 1e9).toFixed(1) + 'B' : 'N/A'}
  Shares Outstanding: ${m.sharesOut ? (m.sharesOut / 1e6).toFixed(1) + 'M' : 'N/A'}
  Trailing P/E (TTM): ${safe(m.trailingPE, 1) || 'N/M'}
  EV/EBITDA (TTM): ${safe(m.evEbitdaTTM, 1) || 'N/A'}
  Price/FCF: ${safe(m.priceFCF, 1) || 'N/A'}
  TTM Dividend: $${safe(m.ttmDiv)}/share
  Dividend Yield: ${m.divYield ? (m.divYield * 100).toFixed(2) + '%' : '0.00%'}
  TTM Revenue: $${fmtM(m.ttmRevenue)}M
  TTM Net Income: $${fmtM(m.ttmNetIncome)}M
  TTM EBITDA: $${fmtM(m.ttmEBITDA)}M
  TTM FCF: $${fmtM(m.ttmFCF)}M
  TTM EPS: $${safe(m.ttmEPS)}
  Enterprise Value: $${m.ev ? (m.ev / 1e9).toFixed(1) + 'B' : 'N/A'}
  Website: ${m.homepage}

HISTORICAL ANNUAL FINANCIALS:
${annualTable}

ANNUAL PRICE RANGES:
${priceRangeStr}

DIVIDENDS BY YEAR:
${divStr || 'None found'}

MONTHLY CLOSING PRICES (for valuation charts — JSON):
Stock: ${monthlyJSON}
SPY: ${spyJSON}

══════════════════════════════════════════
REPORT FORMAT INSTRUCTIONS
══════════════════════════════════════════

Follow these formatting rules exactly. Flag all estimates with (E) in column headers only, not in individual cells.

STYLING RULES — use this CSS as your base:

body { font-family: Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #111; max-width: 1200px; margin: 40px auto; padding: 0 24px; }
.header-table { width: 100%; font-size: 15px; border-collapse: collapse; margin-bottom: 32px; }
.header-table th { background-color: #1a1a2e; color: white; padding: 10px 12px; text-align: left; }
.header-table td { padding: 10px 12px; border: 1px solid #ccc; }
.data-block { display: flex; gap: 32px; margin-bottom: 40px; }
.company-snapshot { flex: 0 0 280px; font-size: 16px; line-height: 1.7; }
.company-snapshot h2 { font-size: 18px; margin-bottom: 10px; }
.financial-table { flex: 1; width: 100%; border-collapse: collapse; font-size: 15px; }
.financial-table th { background-color: #1a1a2e; color: white; padding: 8px 10px; text-align: right; white-space: nowrap; }
.financial-table th:first-child { text-align: left; }
.financial-table td { padding: 7px 10px; border-bottom: 1px solid #e0e0e0; text-align: right; white-space: nowrap; }
.financial-table td:first-child { text-align: left; font-weight: 500; }
.financial-table tr:nth-child(even) { background-color: #f7f7f7; }
.narrative { font-size: 17px; line-height: 1.85; max-width: 960px; border-top: 2px solid #1a1a2e; padding-top: 24px; }
.narrative p { margin-bottom: 20px; }
.analyst-sig { font-size: 15px; color: #555; margin-top: 24px; font-style: italic; }
.price-range-bar { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 0; }
.price-range-bar th { background-color: #1a1a2e; color: white; padding: 6px 8px; text-align: center; }
.price-range-bar td { padding: 6px 8px; text-align: center; border: 1px solid #ccc; line-height: 1.4; white-space: nowrap; }
.chart-container { width: 100%; height: 220px; margin-bottom: 0; }

Valuation section CSS:
.valuation-section { margin-bottom: 40px; }
.valuation-section-header { background: #e8eaf0; border: 1px solid #c8ccda; border-bottom: none; padding: 10px 14px 8px; }
.valuation-section-header h2 { font-size: 14px; font-weight: 700; color: #1a1a2e; letter-spacing: 0.01em; margin-bottom: 2px; }
.valuation-section-header .date-range { font-size: 11px; color: #666; font-style: italic; }
.val-charts-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0; border: 1px solid #c8ccda; }
.val-chart-panel { background: white; border-right: 1px solid #d0d5e0; overflow: hidden; }
.val-chart-panel:last-child { border-right: none; }
.val-chart-panel-header { background: #f2f3f7; padding: 8px 12px 6px; border-bottom: 1px solid #d0d5e0; }
.val-chart-panel-header h3 { font-size: 12px; font-weight: 700; color: #1a1a2e; margin-bottom: 1px; }
.val-chart-panel-header .val-date { font-size: 10px; color: #777; font-style: italic; }
.val-chart-area { padding: 8px 10px 4px; position: relative; height: 240px; }
.val-annotation { position: absolute; font-size: 10.5px; line-height: 1.45; color: #1a1a2e; pointer-events: none; background: rgba(255,255,255,0.82); padding: 3px 5px; }
.val-annotation .v-metric { font-weight: 700; }
.val-annotation .v-rel { color: #2563eb; font-weight: 600; }
.val-chart-legend { display: flex; gap: 10px; padding: 5px 10px 8px; font-size: 10px; color: #444; border-top: 1px solid #eee; flex-wrap: wrap; }
.val-legend-item { display: flex; align-items: center; gap: 4px; }
.val-legend-swatch { width: 18px; height: 2.5px; border-radius: 2px; flex-shrink: 0; }
.valuation-note { font-size: 10.5px; color: #888; padding: 7px 0 0; font-style: italic; }

══════════════════════════════════════════
SECTION 1 — HEADER
══════════════════════════════════════════
Single HTML table, class "header-table", two rows.

Row 1 — Primary metrics:
Company & Ticker | Recent Price | Trailing P/E | Forward P/E | Dividend Yield | Market Cap | Beta | Timeliness (1-5) | Safety (1-5) | Financial Strength

Row 2 — Valuation metrics (white background, four cells spanning full width):
EV/EBITDA (TTM) | EV/EBITDA +1 Yr (E) | EV/EBITDA +2 Yr (E) | PEG Ratio

Always write "EV/EBITDA" in full. Never abbreviate.

For Forward P/E, Beta, Timeliness, Safety, Financial Strength — use your analytical judgment based on the data provided. For forward EV/EBITDA estimates, project from historical trends.

══════════════════════════════════════════
SECTION 2 — MAIN DATA BLOCK
══════════════════════════════════════════
Flex container, class "data-block", two children:

LEFT — Company Snapshot (class "company-snapshot"):
6-8 sentences: business description, segments, scale, competitive position, key risks, valuation vs history. Close with HQ, CEO, ticker, website.

RIGHT — stacked vertically:
1. Annual Price Range Bar (class "price-range-bar") — use the ANNUAL PRICE RANGES data above
2. Dual-Axis Chart (class "chart-container", height 220px):
   - EPS bars (navy #1a1a2e, estimate years lighter #7f8fa6)
   - Relative P/E line (red #c0392b, estimate years dashed)
   - Left Y: "EPS ($)", Right Y: "Relative P/E"
3. Financial Table (class "financial-table"):
   Columns: 5 most recent fiscal years + current FY (E) + next FY (E) + 3-5yr projection
   Rows in this exact order:
   Revenues per Share | Earnings per Share | Book Value per Share | Shares/Units Outstanding (M) | Avg Ann'l P/E Ratio | Relative P/E Ratio | Avg Ann'l Dist. Yield | Revenues ($mill) | EBITDA ($mill) | EBITDA Margin (%) | Operating Margin (%) | Net Profit ($mill) | Net Profit Margin (%) | Cash Flow ($mill) | Capital Expenditures ($mill) | Free Cash Flow ($mill) | Working Cap'l ($mill) | Long-Term Debt ($mill) | Partners'/Shareholders' Capital ($mill) | Return on Total Cap'l (%) | Return on Equity (%) | Dist. Decl'd per Share | All Dist. to Net Profit (%)

══════════════════════════════════════════
SECTION 3 — HISTORICAL VALUATION CHARTS
══════════════════════════════════════════
Three side-by-side Chart.js panels below the data block, above the narrative.

Use the MONTHLY CLOSING PRICES data to compute valuation multiples over time.

For each month:
- Forward P/E ≈ price / (TTM EPS × growth factor) — use most recent annual EPS scaled
- P/FCF = market cap at that price / TTM FCF
- Forward EV/EBITDA ≈ EV at that price / forward EBITDA estimate

For S&P 500 (SPY), use approximate index-level multiples: Forward P/E ~18-22x range, P/FCF ~22-28x, Forward EV/EBITDA ~14-18x. Scale these by SPY price movement from the data.

Relative series = stock multiple / S&P multiple × 100

Use the buildValChart function pattern with these datasets on each panel:
- ±1σ shaded band, stock absolute line, avg dashed, relative % on right axis

Panel 1: Forward P/E | Panel 2: P/FCF | Panel 3: Forward EV/EBITDA

══════════════════════════════════════════
SECTION 4 — ANALYST NARRATIVE
══════════════════════════════════════════
div class "narrative", three paragraphs, no headers or bullets:
¶1 — Recent Results: earnings quality assessment
¶2 — Outlook: 2-3 key drivers, specific risks
¶3 — Valuation & Recommendation: rating, price target, multiple applied, what changes the view

Close with: <p class="analyst-sig">Fedeli Group Research | ${today} | Next Expected Earnings: [estimate]</p>

══════════════════════════════════════════
SECTION 5 — GOOD FOR WHAT?!?
══════════════════════════════════════════
Full-width div: background #1a1a2e, color white, padding 24px 28px, margin-top 40px
<h3 style="color:#AD9551;font-family:Georgia,serif;font-size:18px;font-weight:700;margin-bottom:12px">GOOD FOR WHAT?!?</h3>
3-4 opinionated plain-language sentences: who this stock IS and IS NOT right for. No hedging. Be direct.

DATA SOURCE NOTICE: Add a small footer: "Financial data sourced from Polygon.io. Report generated ${today}."
`;
}


/* ═══════════════════════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════════════════════ */

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Missing ticker in request body.' });
  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_API_KEY not configured.' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured.' });

  const ticker = query.trim().toUpperCase();

  try {
    // ── Phase 1: Fetch all data from Polygon ──────────────────────────
    console.log(`[${ticker}] Fetching data from Polygon.io...`);
    const rawData = await fetchTickerData(ticker);

    if (!rawData.co.name) {
      return res.status(404).json({ error: `Ticker "${ticker}" not found in Polygon.io.` });
    }

    // ── Phase 2: Compute derived metrics ──────────────────────────────
    console.log(`[${ticker}] Computing metrics...`);
    const metrics = computeMetrics(rawData);

    // ── Phase 3: Build prompt and call Claude ─────────────────────────
    console.log(`[${ticker}] Generating report via Claude...`);
    const prompt = buildPrompt(metrics);

    const anthropicRes = await anthropicPost({
      model: 'claude-sonnet-4-6',
      max_tokens: 32000,
      messages: [{ role: 'user', content: prompt }]
    });

    if (anthropicRes.status !== 200) {
      const msg = anthropicRes.body?.error?.message || `Anthropic returned HTTP ${anthropicRes.status}`;
      return res.status(anthropicRes.status).json({ error: msg });
    }

    let html = (anthropicRes.body.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    if (!html) {
      return res.status(500).json({ error: 'Claude returned an empty response.' });
    }

    // Return both HTML and the raw metrics for debugging
    return res.status(200).json({
      html,
      dataSource: 'polygon.io',
      ticker: metrics.ticker,
      companyName: metrics.companyName
    });

  } catch (err) {
    console.error(`[${ticker}] Error:`, err.message);
    return res.status(500).json({ error: 'Report generation failed: ' + err.message });
  }
};
