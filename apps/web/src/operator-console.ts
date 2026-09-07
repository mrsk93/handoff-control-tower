export const operatorConsoleHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Handoff Control Tower</title>
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #111827; color: #e5e7eb; }
      body { margin: 0; background: radial-gradient(circle at top left, #1f2937, #111827 42%); min-height: 100vh; }
      main { max-width: 1180px; margin: 0 auto; padding: 32px 20px 56px; }
      header { display: flex; flex-wrap: wrap; gap: 16px; align-items: end; justify-content: space-between; }
      h1 { margin: 0; font-size: clamp(1.8rem, 4vw, 3rem); letter-spacing: -0.04em; }
      h2 { margin: 0 0 14px; font-size: 1rem; color: #cbd5e1; }
      p { color: #94a3b8; }
      label { color: #94a3b8; font-size: .8rem; display: grid; gap: 5px; }
      input, button { border: 1px solid #475569; border-radius: 8px; padding: 9px 11px; background: #0f172a; color: #e5e7eb; }
      button { cursor: pointer; background: #2563eb; border-color: #3b82f6; }
      button.secondary { background: #1e293b; border-color: #475569; }
      .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: end; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 30px 0; }
      .card, section { background: rgba(15, 23, 42, .85); border: 1px solid #334155; border-radius: 12px; padding: 16px; box-shadow: 0 12px 30px rgba(0,0,0,.18); }
      .metric { font-size: 1.8rem; font-weight: 700; color: #f8fafc; }
      .metric-label { color: #94a3b8; font-size: .8rem; }
      .columns { display: grid; grid-template-columns: 1.25fr .9fr; gap: 16px; }
      @media (max-width: 820px) { .columns { grid-template-columns: 1fr; } }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 11px 8px; border-bottom: 1px solid #263449; font-size: .9rem; }
      th { color: #94a3b8; font-weight: 500; }
      .status { color: #93c5fd; }
      .error { color: #fca5a5; }
      .empty { color: #94a3b8; padding: 20px 0; }
      .stale { color: #fbbf24; min-height: 1.2em; }
      .simulator { margin-top: 16px; }
      code { color: #a5b4fc; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <p>Operations console</p>
          <h1>Handoff Control Tower</h1>
          <p>Commerce → warehouse → carrier → guarded billing readiness</p>
        </div>
        <div class="toolbar">
          <label>Tenant ID<input id="tenant" value="11111111-1111-4111-8111-111111111111" /></label>
          <button id="refresh">Refresh</button>
        </div>
      </header>
      <div id="stale" class="stale"></div>
      <div id="error" class="error" role="alert"></div>
      <div id="metrics" class="grid" aria-live="polite"></div>
      <div class="columns">
        <section>
          <h2>Orders</h2>
          <div id="orders" class="empty">Loading orders…</div>
        </section>
        <section>
          <h2>Exception queue</h2>
          <div id="exceptions" class="empty">Loading exceptions…</div>
          <div class="simulator"><button id="simulator" class="secondary">Demo Simulator</button></div>
        </section>
      </div>
      <section style="margin-top:16px">
        <h2>Reconciliation</h2>
        <button id="reconcile">Run bounded reconciliation</button>
        <div id="runs" class="empty">No runs loaded.</div>
      </section>
    </main>
    <script>
      const tenant = document.getElementById('tenant');
      const error = document.getElementById('error');
      const stale = document.getElementById('stale');
      const state = { refreshedAt: 0 };
      const headers = () => ({ 'x-tenant-id': tenant.value.trim(), 'x-operator-id': 'synthetic-demo-operator', 'x-operator-role': 'admin' });
      async function request(path, options = {}) {
        const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Request failed');
        return body;
      }
      function renderMetrics(counts) {
        const labels = [['orders','Orders'],['openExceptions','Open exceptions'],['pendingOutbox','Pending outbox'],['reconciliationDrift','Drift findings'],['invoiceEligible','Invoice eligible']];
        document.getElementById('metrics').innerHTML = labels.map(([key, label]) => '<div class="card"><div class="metric">' + (counts[key] ?? 0) + '</div><div class="metric-label">' + label + '</div></div>').join('');
      }
      function renderOrders(data) {
        if (!data.items.length) { document.getElementById('orders').innerHTML = '<div class="empty">No orders in this tenant.</div>'; return; }
        document.getElementById('orders').innerHTML = '<table><thead><tr><th>Order</th><th>Release</th><th>Fulfillment</th><th>Eligibility</th></tr></thead><tbody>' + data.items.map((item) => '<tr><td><code>' + item.orderNumber + '</code><br><small>' + item.sourceOrderId + '</small></td><td class="status">' + item.releaseStatus + '</td><td>' + (item.fulfillmentStatus || 'not started') + '</td><td>' + (item.invoiceEligible ? 'ready' : 'blocked') + '</td></tr>').join('') + '</tbody></table>';
      }
      function renderExceptions(items) {
        if (!items.length) { document.getElementById('exceptions').innerHTML = '<div class="empty">No active exceptions.</div>'; return; }
        document.getElementById('exceptions').innerHTML = '<table><thead><tr><th>Severity</th><th>Type</th><th>Order</th></tr></thead><tbody>' + items.map((item) => '<tr><td class="status">' + item.severity + '</td><td>' + item.type + '</td><td>' + (item.orderNumber || 'unlinked') + '</td></tr>').join('') + '</tbody></table>';
      }
      function renderRuns(items) {
        document.getElementById('runs').innerHTML = items.length ? '<table><thead><tr><th>Pair</th><th>Status</th><th>Findings</th></tr></thead><tbody>' + items.slice(0, 8).map((item) => '<tr><td>' + item.systemPair + '</td><td class="status">' + item.status + '</td><td>' + JSON.stringify(item.counts) + '</td></tr>').join('') + '</tbody></table>' : '<div class="empty">No runs loaded.</div>';
      }
      async function refresh() {
        error.textContent = '';
        stale.textContent = '';
        document.getElementById('orders').textContent = 'Loading orders…';
        document.getElementById('exceptions').textContent = 'Loading exceptions…';
        try {
          const [overview, orders, exceptions, runs] = await Promise.all([request('/api/overview'), request('/api/orders?limit=25'), request('/api/exceptions?status=open&limit=25'), request('/api/reconciliation-runs?limit=8')]);
          renderMetrics(overview.counts); renderOrders(orders); renderExceptions(exceptions); renderRuns(runs);
          state.refreshedAt = Date.now();
        } catch (cause) { error.textContent = cause.message || 'Unable to load operator data'; }
      }
      document.getElementById('refresh').addEventListener('click', refresh);
      document.getElementById('reconcile').addEventListener('click', async () => { try { await request('/api/reconciliation-runs', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }); await refresh(); } catch (cause) { error.textContent = cause.message || 'Reconciliation failed'; } });
      document.getElementById('simulator').addEventListener('click', async () => { try { const result = await request('/simulator/scenario'); alert(result.enabled ? 'Demo Simulator is enabled for this environment.' : 'Demo Simulator is disabled.'); } catch (cause) { error.textContent = 'Demo Simulator is unavailable in this environment.'; } });
      setInterval(() => { if (state.refreshedAt && Date.now() - state.refreshedAt > 30000) stale.textContent = 'Data may be stale — refresh to verify the current handoff state.'; }, 5000);
      refresh();
    </script>
  </body>
</html>`;
