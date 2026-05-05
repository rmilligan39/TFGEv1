const https = require('https');
const crypto = require('crypto');

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIG & HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

const POLYGON_KEY  = process.env.POLYGON_API_KEY  || '';
const FMP_KEY      = process.env.FMP_API_KEY       || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

function polygonGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.polygon.io${path}${sep}apiKey=${POLYGON_KEY}`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TFG-Research/3.0' } }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.status === 'ERROR' || parsed.error) {
            reject(new Error(parsed.error || parsed.message || `Polygon error on ${path}`));
          } else { resolve(parsed); }
        } catch (e) { reject(new Error(`Parse error on ${path}`)); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function httpsPost(options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(240000, () => req.destroy(new Error('Request timed out after 240s')));
    req.write(payload);
    req.end();
  });
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
function yearsAgo(n) { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); }
function fmtM(v) { return v != null ? (v / 1e6).toFixed(1) : null; }
function fmtPct(v) { return v != null ? (v * 100).toFixed(1) : null; }
function safe(v, dec = 2) { return v != null ? Number(v).toFixed(dec) : null; }
function generateId() { return crypto.randomBytes(7).toString('base64url').slice(0, 9); }

/* ── KV helpers (Upstash REST — no npm needed) ────────────────────────── */
async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) { console.warn('KV not configured — report will not be saved.'); return false; }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(['SET', key, value, 'EX', 7776000]) // 90 day TTL
    });
    return res.ok;
  } catch (e) { console.error('KV SET error:', e.message); return false; }
}


/* ═══════════════════════════════════════════════════════════════════════════
   POLYGON DATA FETCHING
   ═══════════════════════════════════════════════════════════════════════════ */

async function fetchTickerData(ticker) {
  const T = ticker.toUpperCase();

  // 1. Company details
  const detailsRes = await polygonGet(`/v3/reference/tickers/${T}`);
  const co = detailsRes.results || {};

  // 2. Annual financials (last 6 years)
  const finRes = await polygonGet(
    `/vX/reference/financials?ticker=${T}&timeframe=annual&order=desc&limit=6&sort=period_of_report_date`
  );
  const filings = (finRes.results || []).reverse(); // oldest first

  // 3. Quarterly financials (last 8 quarters for TTM)
  const qFinRes = await polygonGet(
    `/vX/reference/financials?ticker=${T}&timeframe=quarterly&order=desc&limit=8&sort=period_of_report_date`
  );
  const quarters = (qFinRes.results || []);

  // 4. Monthly price bars (6 years, for valuation charts)
  const priceRes = await polygonGet(
    `/v2/aggs/ticker/${T}/range/1/month/${yearsAgo(6)}/${todayStr()}?adjusted=true&sort=asc&limit=100`
  );
  const monthlyBars = (priceRes.results || []);

  // 5. Daily bars (6 years, for annual highs/lows + recent price)
  const dailyRes = await polygonGet(
    `/v2/aggs/ticker/${T}/range/1/day/${yearsAgo(6)}/${todayStr()}?adjusted=true&sort=asc&limit=2000`
  );
  const dailyBars = (dailyRes.results || []);

  // 6. S&P 500 monthly bars (for relative valuation)
  const spRes = await polygonGet(
    `/v2/aggs/ticker/SPY/range/1/month/${yearsAgo(6)}/${todayStr()}?adjusted=true&sort=asc&limit=100`
  );
  const spyMonthly = (spRes.results || []);

  // 7. Dividend history
  const divRes = await polygonGet(`/v3/reference/dividends?ticker=${T}&order=desc&limit=30`);
  const divs = (divRes.results || []);

  // 8. Snapshot (may require paid plan — graceful fallback)
  let snapshot = null;
  try {
    const snapRes = await polygonGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${T}`);
    snapshot = snapRes.ticker || null;
  } catch (e) { /* fallback to last daily bar */ }

  return { co, filings, quarters, monthlyBars, dailyBars, spyMonthly, divs, snapshot, ticker: T };
}


/* ═══════════════════════════════════════════════════════════════════════════
   FMP (FINANCIAL MODELING PREP) — FALLBACK DATA SOURCE
   ═══════════════════════════════════════════════════════════════════════════ */

function fmpGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://financialmodelingprep.com${path}${sep}apikey=${FMP_KEY}`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TFG-Research/3.0' } }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed['Error Message']) {
            console.log(`[FMP] Error on ${path}: ${parsed['Error Message']}`);
            resolve([]);
          } else {
            resolve(parsed);
          }
        } catch (e) {
          console.log(`[FMP] Parse error on ${path}: ${body.slice(0, 200)}`);
          reject(new Error(`FMP parse error on ${path}`));
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchTickerDataFMP(ticker) {
  let T = ticker.toUpperCase();

  // 1. Try direct profile lookup using /stable/ endpoint
  let profileArr = await fmpGet(`/stable/profile?symbol=${encodeURIComponent(T)}`);
  let profile = (Array.isArray(profileArr) ? profileArr[0] : profileArr) || {};

  // If direct lookup failed, try search to resolve the symbol
  if (!profile.companyName && !profile.symbol) {
    console.log(`[${T}] FMP direct profile failed, trying search...`);
    const searchRes = await fmpGet(`/stable/search-symbol?query=${encodeURIComponent(T)}`);
    if (Array.isArray(searchRes) && searchRes.length > 0) {
      const match = searchRes[0];
      console.log(`[${T}] FMP search found: ${match.symbol} — ${match.name}`);
      T = match.symbol;
      const retryProfile = await fmpGet(`/stable/profile?symbol=${encodeURIComponent(T)}`);
      profile = (Array.isArray(retryProfile) ? retryProfile[0] : retryProfile) || {};
    }
  }

  // Also try without suffix if still not found
  if (!profile.companyName && !profile.symbol && T.includes('.')) {
    const bare = T.split('.')[0];
    console.log(`[${T}] Trying bare symbol: ${bare}`);
    const bareProfile = await fmpGet(`/stable/profile?symbol=${encodeURIComponent(bare)}`);
    const bp = (Array.isArray(bareProfile) ? bareProfile[0] : bareProfile) || {};
    if (bp.companyName || bp.symbol) {
      T = bare;
      profile = bp;
    }
  }

  if (!profile.companyName && !profile.symbol) {
    console.log(`[${T}] FMP: no profile found. Raw: ${JSON.stringify(profileArr).slice(0, 300)}`);
    return { profile: {}, ticker: T, found: false };
  }

  console.log(`[${T}] FMP profile found: ${profile.companyName}`);

  // 2. Annual income statements
  const incomeStmts = await fmpGet(`/stable/income-statement?symbol=${encodeURIComponent(T)}&period=annual&limit=6`);

  // 3. Annual balance sheets
  const balanceSheets = await fmpGet(`/stable/balance-sheet-statement?symbol=${encodeURIComponent(T)}&period=annual&limit=6`);

  // 4. Annual cash flow statements
  const cashFlows = await fmpGet(`/stable/cash-flow-statement?symbol=${encodeURIComponent(T)}&period=annual&limit=6`);

  // 5. Quarterly income statements (for TTM)
  const qIncome = await fmpGet(`/stable/income-statement?symbol=${encodeURIComponent(T)}&period=quarter&limit=8`);

  // 6. Quarterly cash flows (for TTM)
  const qCashFlow = await fmpGet(`/stable/cash-flow-statement?symbol=${encodeURIComponent(T)}&period=quarter&limit=8`);

  // 7. Historical daily prices (6 years)
  const priceHistory = await fmpGet(`/stable/historical-price-eod/full?symbol=${encodeURIComponent(T)}&from=${yearsAgo(6)}&to=${todayStr()}`);
  const dailyPrices = Array.isArray(priceHistory) ? priceHistory.reverse() :
                      (priceHistory.historical || []).reverse();

  // 8. S&P 500 history (for relative valuation)
  const spHistory = await fmpGet(`/stable/historical-price-eod/full?symbol=%5EGSPC&from=${yearsAgo(6)}&to=${todayStr()}`);
  const spDaily = Array.isArray(spHistory) ? spHistory.reverse() :
                  (spHistory.historical || []).reverse();

  // 9. Dividend history
  let divs = [];
  try {
    const divHistory = await fmpGet(`/stable/historical-price-eod/dividend?symbol=${encodeURIComponent(T)}&from=${yearsAgo(6)}&to=${todayStr()}`);
    divs = Array.isArray(divHistory) ? divHistory : (divHistory.historical || []);
  } catch (e) { console.log(`[${T}] FMP dividend fetch failed: ${e.message}`); }

  return { profile, incomeStmts, balanceSheets, cashFlows, qIncome, qCashFlow, dailyPrices, spDaily, divs, ticker: T, found: true };
}

function computeMetricsFMP(raw) {
  const { profile, incomeStmts, balanceSheets, cashFlows, qIncome, qCashFlow, dailyPrices, spDaily, divs, ticker } = raw;

  const recentPrice = profile.price || (dailyPrices.length ? dailyPrices[dailyPrices.length - 1].close : null);
  const companyName = profile.companyName || ticker;
  const marketCap = profile.mktCap || null;
  const sicDesc = profile.sector ? `${profile.sector} — ${profile.industry || ''}` : '';
  const exchange = profile.exchangeShortName || profile.exchange || '';
  const sharesOut = profile.sharesOutstanding || (incomeStmts[0]?.weightedAverageShsOut) || null;
  const homepage = profile.website || '';
  const beta = profile.beta || null;

  // Align and reverse annual statements (FMP returns newest first)
  const incArr = Array.isArray(incomeStmts) ? [...incomeStmts].reverse() : [];
  const bsArr = Array.isArray(balanceSheets) ? [...balanceSheets].reverse() : [];
  const cfArr = Array.isArray(cashFlows) ? [...cashFlows].reverse() : [];

  // Build annuals by matching on calendar year
  const annuals = incArr.map((inc, i) => {
    const bs = bsArr[i] || {};
    const cf = cfArr[i] || {};
    const year = (inc.calendarYear || inc.date?.slice(0, 4) || '');

    const revenue = inc.revenue || null;
    const netIncome = inc.netIncome || null;
    const opIncome = inc.operatingIncome || null;
    const eps = inc.eps || (netIncome && sharesOut ? netIncome / sharesOut : null);
    const ebitda = inc.ebitda || (opIncome != null ? opIncome + Math.abs(inc.depreciationAndAmortization || 0) : null);

    const totalEquity = bs.totalStockholdersEquity || bs.totalEquity || null;
    const ltDebt = bs.longTermDebt || null;
    const currentAssets = bs.totalCurrentAssets || null;
    const currentLiab = bs.totalCurrentLiabilities || null;
    const workingCap = (currentAssets && currentLiab) ? currentAssets - currentLiab : null;
    const bookVal = totalEquity && sharesOut ? totalEquity / sharesOut : null;

    const opCF = cf.operatingCashFlow || null;
    const capex = cf.capitalExpenditure ? Math.abs(cf.capitalExpenditure) : null;
    const fcf = cf.freeCashFlow || (opCF != null ? opCF - (capex || 0) : null);
    const shares = inc.weightedAverageShsOut || sharesOut;

    return {
      year, revenue, netIncome, opIncome, ebitda, eps, shares,
      totalEquity, ltDebt, currentAssets, currentLiab, workingCap, bookVal,
      opCF, capex, fcf,
      ebitdaMargin: revenue && ebitda ? ebitda / revenue : null,
      opMargin: revenue && opIncome ? opIncome / revenue : null,
      netMargin: revenue && netIncome ? netIncome / revenue : null,
      roe: totalEquity && netIncome ? netIncome / totalEquity : null,
      rotc: (totalEquity && ltDebt && netIncome) ? netIncome / (totalEquity + (ltDebt || 0)) : null,
    };
  });

  // TTM from quarterly
  const ttmQI = Array.isArray(qIncome) ? qIncome.slice(0, 4) : [];
  const ttmQC = Array.isArray(qCashFlow) ? qCashFlow.slice(0, 4) : [];
  let ttmRevenue = 0, ttmNetIncome = 0, ttmEBITDA = 0, ttmFCF = 0;
  ttmQI.forEach((q, i) => {
    ttmRevenue += (q.revenue || 0);
    ttmNetIncome += (q.netIncome || 0);
    ttmEBITDA += (q.ebitda || (q.operatingIncome || 0) + Math.abs(q.depreciationAndAmortization || 0));
    const cf = ttmQC[i] || {};
    ttmFCF += (cf.freeCashFlow || ((cf.operatingCashFlow || 0) - Math.abs(cf.capitalExpenditure || 0)));
  });

  const ttmEPS = sharesOut && ttmNetIncome ? ttmNetIncome / sharesOut : null;

  // Valuation ratios
  const trailingPE = recentPrice && ttmEPS && ttmEPS > 0 ? recentPrice / ttmEPS : null;
  const lastAnnual = annuals.length > 0 ? annuals[annuals.length - 1] : {};
  const ev = marketCap ? marketCap + (lastAnnual.ltDebt || 0) - (lastAnnual.currentAssets || 0) * 0.3 : null;
  const evEbitdaTTM = ev && ttmEBITDA > 0 ? ev / ttmEBITDA : null;
  const priceFCF = marketCap && ttmFCF > 0 ? marketCap / ttmFCF : null;

  // Price ranges from daily data
  const priceRanges = {};
  dailyPrices.forEach(d => {
    const yr = d.date?.slice(0, 4);
    if (!yr) return;
    if (!priceRanges[yr]) priceRanges[yr] = { high: -Infinity, low: Infinity };
    if (d.high > priceRanges[yr].high) priceRanges[yr].high = d.high;
    if (d.low < priceRanges[yr].low) priceRanges[yr].low = d.low;
  });

  // Monthly closing prices (sample one per month from daily)
  const monthlyMap = {};
  dailyPrices.forEach(d => {
    const ym = d.date?.slice(0, 7);
    if (ym) monthlyMap[ym] = d.close; // last day of each month wins
  });
  const monthlyPrices = Object.entries(monthlyMap).sort().map(([ym, close]) => {
    const [y, m] = ym.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return { date: ym, label: months[parseInt(m) - 1] + '-' + y.slice(2), close };
  });

  // SPY monthly
  const spyMonthMap = {};
  spDaily.forEach(d => {
    const ym = d.date?.slice(0, 7);
    if (ym) spyMonthMap[ym] = d.close;
  });
  const spyPrices = Object.entries(spyMonthMap).sort().map(([ym, close]) => ({ date: ym, close }));

  // Dividends
  const annualDivs = {};
  divs.forEach(d => {
    const yr = (d.date || d.paymentDate || '').slice(0, 4);
    if (yr) annualDivs[yr] = (annualDivs[yr] || 0) + (d.dividend || d.adjDividend || 0);
  });
  const recentDivs = divs.slice(0, 4);
  const ttmDiv = recentDivs.reduce((s, d) => s + (d.dividend || d.adjDividend || 0), 0);
  const divYield = recentPrice && ttmDiv ? ttmDiv / recentPrice : null;

  return {
    ticker, companyName, exchange, sicDesc, marketCap, sharesOut, homepage, beta,
    recentPrice, trailingPE, evEbitdaTTM, priceFCF, divYield,
    ttmRevenue, ttmNetIncome, ttmEBITDA, ttmFCF, ttmEPS, ttmDiv, ev,
    annuals, priceRanges, monthlyPrices, spyPrices, annualDivs,
    dataSource: 'financialmodelingprep.com',
  };
}


/* ═══════════════════════════════════════════════════════════════════════════
   COMPUTE DERIVED METRICS
   ═══════════════════════════════════════════════════════════════════════════ */

function computeMetrics(raw) {
  const { co, filings, quarters, monthlyBars, dailyBars, spyMonthly, divs, snapshot, ticker } = raw;

  // Recent price
  let recentPrice = null;
  if (snapshot && snapshot.day) recentPrice = snapshot.day.c || snapshot.lastTrade?.p || null;
  if (!recentPrice && dailyBars.length > 0) recentPrice = dailyBars[dailyBars.length - 1].c;

  // Company info
  const companyName = co.name || ticker;
  const marketCap = co.market_cap || null;
  const sicDesc = co.sic_description || '';
  const exchange = co.primary_exchange || '';
  const sharesOut = co.share_class_shares_outstanding || co.weighted_shares_outstanding || null;
  const homepage = co.homepage_url || '';

  // Process annual financials
  const annuals = filings.map(f => {
    const ic = f.financials?.income_statement || {};
    const bs = f.financials?.balance_sheet || {};
    const cf = f.financials?.cash_flow_statement || {};
    const year = f.fiscal_year || (f.end_date || '').slice(0, 4);
    const shares = ic.basic_average_shares?.value || sharesOut;

    const revenue = ic.revenues?.value || null;
    const netIncome = ic.net_income_loss?.value || null;
    const opIncome = ic.operating_income_loss?.value || null;
    const eps = ic.basic_earnings_per_share?.value || (netIncome && shares ? netIncome / shares : null);

    const totalEquity = bs.equity_attributable_to_parent?.value || null;
    const ltDebt = bs.long_term_debt?.value || bs.noncurrent_liabilities?.value || null;
    const currentAssets = bs.current_assets?.value || null;
    const currentLiab = bs.current_liabilities?.value || null;
    const workingCap = (currentAssets && currentLiab) ? currentAssets - currentLiab : null;
    const bookVal = totalEquity && shares ? totalEquity / shares : null;

    const opCF = cf.net_cash_flow_from_operating_activities?.value || null;
    const capexRaw = cf.net_cash_flow_from_investing_activities?.value || null;
    const capex = capexRaw ? Math.abs(capexRaw) : null;
    const fcf = opCF != null ? opCF - (capex || 0) : null;

    const da = ic.depreciation_and_amortization?.value || cf.depreciation_amortization_and_accretion?.value || 0;
    const ebitda = opIncome != null ? opIncome + Math.abs(da) : null;

    return {
      year, revenue, netIncome, opIncome, ebitda, eps, shares,
      totalEquity, ltDebt, currentAssets, currentLiab, workingCap, bookVal,
      opCF, capex, fcf,
      ebitdaMargin: revenue && ebitda ? ebitda / revenue : null,
      opMargin: revenue && opIncome ? opIncome / revenue : null,
      netMargin: revenue && netIncome ? netIncome / revenue : null,
      roe: totalEquity && netIncome ? netIncome / totalEquity : null,
      rotc: (totalEquity && ltDebt && netIncome) ? netIncome / (totalEquity + (ltDebt || 0)) : null,
    };
  });

  // TTM from quarters
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

  // Valuation ratios
  const trailingPE = recentPrice && ttmEPS && ttmEPS > 0 ? recentPrice / ttmEPS : null;
  const ev = marketCap && annuals.length > 0
    ? marketCap + (annuals[annuals.length - 1].ltDebt || 0) - (annuals[annuals.length - 1].currentAssets || 0) * 0.3
    : null;
  const evEbitdaTTM = ev && ttmEBITDA > 0 ? ev / ttmEBITDA : null;
  const priceFCF = marketCap && ttmFCF > 0 ? marketCap / ttmFCF : null;

  // Annual price ranges
  const priceRanges = {};
  dailyBars.forEach(bar => {
    const yr = new Date(bar.t).getFullYear().toString();
    if (!priceRanges[yr]) priceRanges[yr] = { high: -Infinity, low: Infinity };
    if (bar.h > priceRanges[yr].high) priceRanges[yr].high = bar.h;
    if (bar.l < priceRanges[yr].low) priceRanges[yr].low = bar.l;
  });

  // Monthly closing prices
  const monthlyPrices = monthlyBars.map(b => ({
    date: new Date(b.t).toISOString().slice(0, 7),
    label: new Date(b.t).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
    close: b.c
  }));
  const spyPrices = spyMonthly.map(b => ({
    date: new Date(b.t).toISOString().slice(0, 7),
    close: b.c
  }));

  // Dividends
  const annualDivs = {};
  divs.forEach(d => {
    const yr = (d.pay_date || d.ex_dividend_date || '').slice(0, 4);
    if (yr) annualDivs[yr] = (annualDivs[yr] || 0) + (d.cash_amount || 0);
  });
  const ttmDiv = divs.slice(0, 4).reduce((s, d) => s + (d.cash_amount || 0), 0);
  const divYield = recentPrice && ttmDiv ? ttmDiv / recentPrice : null;

  return {
    ticker, companyName, exchange, sicDesc, marketCap, sharesOut, homepage,
    recentPrice, trailingPE, evEbitdaTTM, priceFCF, divYield,
    ttmRevenue, ttmNetIncome, ttmEBITDA, ttmFCF, ttmEPS, ttmDiv, ev,
    annuals, priceRanges, monthlyPrices, spyPrices, annualDivs,
    dataSource: 'Polygon.io',
  };
}


/* ═══════════════════════════════════════════════════════════════════════════
   BUILD PROMPT — FULL REPORT TEMPLATE WITH PRE-COMPUTED DATA
   ═══════════════════════════════════════════════════════════════════════════ */

function buildPrompt(metrics) {
  const m = metrics;
  const today = todayStr();

  const annualTable = m.annuals.map(a => [
    `Year: ${a.year}`,
    `  Revenue: ${a.revenue ? '$' + fmtM(a.revenue) + 'M' : 'N/A'}`,
    `  Net Income: ${a.netIncome ? '$' + fmtM(a.netIncome) + 'M' : 'N/A'}`,
    `  EPS: ${safe(a.eps)}`,
    `  EBITDA: ${a.ebitda ? '$' + fmtM(a.ebitda) + 'M' : 'N/A'}`,
    `  EBITDA Margin: ${fmtPct(a.ebitdaMargin) || 'N/A'}%`,
    `  Op Margin: ${fmtPct(a.opMargin) || 'N/A'}%`,
    `  Net Margin: ${fmtPct(a.netMargin) || 'N/A'}%`,
    `  Book Value/Share: ${safe(a.bookVal)}`,
    `  Shares (M): ${a.shares ? (a.shares / 1e6).toFixed(1) : 'N/A'}`,
    `  Operating CF: ${a.opCF ? '$' + fmtM(a.opCF) + 'M' : 'N/A'}`,
    `  CapEx: ${a.capex ? '$' + fmtM(a.capex) + 'M' : 'N/A'}`,
    `  FCF: ${a.fcf ? '$' + fmtM(a.fcf) + 'M' : 'N/A'}`,
    `  Long-Term Debt: ${a.ltDebt ? '$' + fmtM(a.ltDebt) + 'M' : 'N/A'}`,
    `  Shareholders Equity: ${a.totalEquity ? '$' + fmtM(a.totalEquity) + 'M' : 'N/A'}`,
    `  Working Capital: ${a.workingCap ? '$' + fmtM(a.workingCap) + 'M' : 'N/A'}`,
    `  ROE: ${fmtPct(a.roe) || 'N/A'}%`,
    `  ROTC: ${fmtPct(a.rotc) || 'N/A'}%`,
  ].join('\n')).join('\n\n');

  const priceRangeStr = Object.entries(m.priceRanges)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([yr, r]) => `${yr}: H $${r.high.toFixed(2)} / L $${r.low.toFixed(2)}`)
    .join('\n');

  const divStr = Object.entries(m.annualDivs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([yr, amt]) => `${yr}: $${amt.toFixed(2)}/share`)
    .join(', ');

  const monthlyJSON = JSON.stringify(m.monthlyPrices);
  const spyJSON = JSON.stringify(m.spyPrices);

  // Build the Chart.js script tag reference safely
  const cjs = '<script src="https://cdn.jsdelivr.net/npm/chart.js"><' + '/script>';

  return `You are a senior equity analyst at The Fedeli Group. Produce a complete, self-contained HTML equity research report for:

**${m.companyName} (${m.ticker})**
Exchange: ${m.exchange} | Sector: ${m.sicDesc}

CRITICAL OUTPUT RULE: Return ONLY valid HTML. Your entire response must begin with <!DOCTYPE html> and end with </html>. Do not output markdown code fences, backticks, or any text outside the HTML document.

The HTML must contain:
- All CSS in an embedded <style> block
- Chart.js loaded exactly as: ${cjs}
- All JavaScript in a <script> block just before </body>
- No other external dependencies
- Flag all estimates with (E) in column headers only, not in individual cells.

══════════════════════════════════════════
PRE-COMPUTED DATA FROM ${(m.dataSource || 'polygon.io').toUpperCase()} — USE ONLY THIS DATA
══════════════════════════════════════════

Do NOT fabricate financial numbers. Use the data below. For forward estimates, project from historical trends and mark with (E).

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

MONTHLY CLOSING PRICES (JSON — for valuation charts):
Stock: ${monthlyJSON}
SPY: ${spyJSON}

══════════════════════════════════════════
STYLING RULES
══════════════════════════════════════════

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

Row 2 — Valuation metrics (white background #ffffff, four cells spanning full width, label in plain text above value in bold):
EV/EBITDA (TTM) | EV/EBITDA +1 Yr (E) | EV/EBITDA +2 Yr (E) | PEG Ratio

LABEL GUARDRAIL: Always write "EV/EBITDA" in full everywhere. Never abbreviate.
For Forward P/E, Beta, Timeliness, Safety, Financial Strength — use analytical judgment. If PEG Ratio is not meaningful, display as N/M.

══════════════════════════════════════════
SECTION 2 — MAIN DATA BLOCK
══════════════════════════════════════════
Flex container class "data-block" with two children:

LEFT — Company Snapshot (class "company-snapshot"):
6-8 sentences: business description, segments, scale, competitive position, key risks, valuation vs history. Close with HQ, CEO, ticker, website.

RIGHT — stacked vertically:

1. Annual Price Range Bar (class "price-range-bar"):
   Columns match the financial table fiscal years. Each cell: [YEAR] / H: $XX.XX / L: $XX.XX
   Navy header background, 13px, center-aligned.

2. Dual-Axis Chart (class "chart-container", canvas, 220px height):
   EPS bars left axis (navy #1a1a2e, estimate years #7f8fa6)
   Relative P/E line right axis (red #c0392b, 2px, estimate years dashed)
   Left Y: "EPS ($)" — Right Y: "Relative P/E"
   Legend shown. No gridlines on right axis.

3. Financial Table (class "financial-table"):
   Columns: 5 most recent fiscal years + current FY (E) + next FY (E) + 3-5yr projection range
   Rows in this EXACT order:
   Revenues per Share | Earnings per Share | Book Value per Share | Shares/Units Outstanding (M) | Avg Ann'l P/E Ratio | Relative P/E Ratio | Avg Ann'l Dist. Yield | Revenues ($mill) | EBITDA ($mill) | EBITDA Margin (%) | Operating Margin (%) | Net Profit ($mill) | Net Profit Margin (%) | Cash Flow ($mill) | Capital Expenditures ($mill) | Free Cash Flow ($mill) | Working Cap'l ($mill) | Long-Term Debt ($mill) | Partners'/Shareholders' Capital ($mill) | Return on Total Cap'l (%) | Return on Equity (%) | Dist. Decl'd per Share | All Dist. to Net Profit (%)
   Use — for unavailable data.

══════════════════════════════════════════
SECTION 3 — HISTORICAL VALUATION CHARTS
══════════════════════════════════════════
Three side-by-side Chart.js panels below data block, above narrative.

Section header: "Historical Absolute & Relative Valuation — Forward P/E | Price / FCF | Forward EV/EBITDA  vs. S&P 500"
Source line: "Source: ${m.dataSource || 'Polygon.io'}, Company Filings, TFG Research | As of ${today}"

Three panels in a CSS grid (1fr 1fr 1fr):
Panel 1: Forward P/E vs S&P 500
Panel 2: P/FCF vs S&P 500
Panel 3: Forward EV/EBITDA vs S&P 500

Each panel has: left axis (absolute multiple), right axis (relative to S&P as %), shaded ±1σ band, average dashed lines, annotation box with current vs avg.

Use the monthly price data to compute multiples. For S&P 500 approximate multiples: Forward P/E ~18-22x, P/FCF ~22-28x, Forward EV/EBITDA ~14-18x, scaled by SPY price movement.

Use the buildValChart function pattern:
function buildValChart(canvasId, stockData, relData, avgAbs, stdAbs, avgRel, leftMax, leftMin, rightMax, rightMin) with datasets: _hi/_lo for σ band, stock line, avg dashed, ±1σ dashed, relative % on right axis, avg rel dashed.
Options: responsive, no animation, interaction mode index intersect false, legend display false, tooltip filter to suppress _hi/_lo, tooltip labels append x or % based on axis.

══════════════════════════════════════════
SECTION 4 — ANALYST NARRATIVE
══════════════════════════════════════════
div class "narrative", three paragraphs, no headers or bullets:
P1 — Recent Results: earnings quality, not just headline
P2 — Outlook: 2-3 key drivers next 12-24 months, specific risks
P3 — Valuation & Recommendation: rating, price target, multiple applied, what changes the view

Close: <p class="analyst-sig">Fedeli Group Research | ${today} | Next Expected Earnings: [estimate]</p>

══════════════════════════════════════════
SECTION 5 — GOOD FOR WHAT?!?
══════════════════════════════════════════
Full-width div: background #1a1a2e, color white, padding 24px 28px, margin-top 40px
<h3 style="color:#AD9551;font-family:Georgia,serif;font-size:18px;font-weight:700;margin-bottom:12px">GOOD FOR WHAT?!?</h3>
3-4 opinionated plain-language sentences: who this stock IS and IS NOT right for. No hedging. Be direct.

══════════════════════════════════════════
FOOTER
══════════════════════════════════════════
Small footer div: "Financial data sourced from ${m.dataSource || 'Polygon.io'}. Report generated ${today}. For internal use only — not investment advice."
Style: font-size 11px, color #999, margin-top 32px, border-top 1px solid #eee, padding-top 12px.
`;
}


/* ═══════════════════════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════════════════════ */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: 'Missing ticker in request body.' });
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured in Vercel environment variables.' });

  const ticker = query.trim().toUpperCase();
  // Detect likely non-US tickers: contains a dot (CSU.TO, SHOP.TO, etc.)
  const likelyNonUS = ticker.includes('.');

  let metrics = null;
  let usedSource = 'polygon.io';

  try {
    // ── Strategy: Polygon first for US tickers, FMP first for non-US ────
    if (!likelyNonUS && POLYGON_KEY) {
      // Try Polygon for US tickers
      try {
        console.log(`[${ticker}] Trying Polygon.io...`);
        const rawData = await fetchTickerData(ticker);
        if (rawData.co.name) {
          console.log(`[${ticker}] Polygon.io found: ${rawData.co.name}`);
          metrics = computeMetrics(rawData);
          metrics.dataSource = 'Polygon.io';
          usedSource = 'polygon.io';
        }
      } catch (polyErr) {
        console.log(`[${ticker}] Polygon.io failed: ${polyErr.message}`);
      }
    }

    // Fallback to FMP (or primary for non-US)
    if (!metrics && FMP_KEY) {
      try {
        console.log(`[${ticker}] Trying Financial Modeling Prep...`);
        const fmpData = await fetchTickerDataFMP(ticker);
        if (fmpData.found) {
          console.log(`[${ticker}] FMP found: ${fmpData.profile.companyName}`);
          metrics = computeMetricsFMP(fmpData);
          usedSource = 'financialmodelingprep.com';
        }
      } catch (fmpErr) {
        console.log(`[${ticker}] FMP failed: ${fmpErr.message}`);
      }
    }

    // If Polygon failed for US ticker and FMP wasn't tried yet, try FMP as last resort
    if (!metrics && !likelyNonUS && FMP_KEY) {
      try {
        console.log(`[${ticker}] Last resort — trying FMP for US ticker...`);
        const fmpData = await fetchTickerDataFMP(ticker);
        if (fmpData.found) {
          metrics = computeMetricsFMP(fmpData);
          usedSource = 'financialmodelingprep.com';
        }
      } catch (e) {
        console.log(`[${ticker}] FMP last resort also failed: ${e.message}`);
      }
    }

    if (!metrics) {
      const sources = [POLYGON_KEY ? 'Polygon.io' : null, FMP_KEY ? 'FMP' : null].filter(Boolean).join(' and ');
      return res.status(404).json({
        error: `Ticker "${ticker}" not found in ${sources || 'any configured data source'}. Check the symbol and try again. For Canadian stocks, use the .TO suffix (e.g., CSU.TO).`
      });
    }

    // ── Build prompt and call Claude ─────────────────────────────────
    console.log(`[${ticker}] Generating report via Claude (data from ${usedSource})...`);
    const prompt = buildPrompt(metrics);
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 32000,
      messages: [{ role: 'user', content: prompt }]
    });

    const anthropicRes = await httpsPost({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, payload);

    const parsed = JSON.parse(anthropicRes.body);
    if (anthropicRes.status !== 200) {
      const msg = parsed?.error?.message || `Anthropic returned HTTP ${anthropicRes.status}`;
      return res.status(anthropicRes.status).json({ error: msg });
    }

    let html = (parsed.content || [])
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

    // ── Save to KV for sharing ──────────────────────────────────────
    const id = generateId();
    const saved = await kvSet('report:' + id, html);
    console.log(`[${ticker}] Report saved to KV: ${saved ? id : 'SKIPPED'}`);

    return res.status(200).json({
      html,
      id: saved ? id : null,
      dataSource: usedSource,
      ticker: metrics.ticker,
      companyName: metrics.companyName
    });

  } catch (err) {
    console.error(`[${ticker}] Error:`, err.message);
    return res.status(500).json({ error: 'Report generation failed: ' + err.message });
  }
};
