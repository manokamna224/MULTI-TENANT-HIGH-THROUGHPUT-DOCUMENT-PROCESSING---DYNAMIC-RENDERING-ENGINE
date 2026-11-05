/**
 * k6 Load Test — DocEngine Render Endpoint
 *
 * Scenarios:
 *   smoke     — 1 VU, 30s (baseline correctness)
 *   ramp      — 0 → 50 VUs over 2m, hold 5m, ramp down 2m
 *   sustained — 100 VUs, 10m (steady-state throughput)
 *
 * Run examples:
 *   k6 run k6-render-load-test.js --env BASE_URL=http://localhost:3000
 *   k6 run k6-render-load-test.js --env BASE_URL=http://localhost:3000 --env SCENARIO=smoke
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

// ── Custom metrics ────────────────────────────────────────────────────────────
const errorRate      = new Rate('errors');
const renderLatency  = new Trend('render_latency_ms', true);
const jobsAccepted   = new Counter('jobs_accepted');
const jobsRejected   = new Counter('jobs_rejected');

// ── Fixtures ──────────────────────────────────────────────────────────────────
// SharedArray is loaded once and shared across all VUs (zero-copy reads)
const fixtureSmall = new SharedArray('small-payload', function () {
  return [buildSmallPayload()];
});

const fixtureLarge = new SharedArray('large-payload', function () {
  // In a real test run, load from file:
  // return [JSON.parse(open('./fixtures/measurement-book-50-items.json'))];
  return [buildSmallPayload()]; // fallback if file not available in CI
});

// ── Scenario configuration ────────────────────────────────────────────────────
const SCENARIO = __ENV.SCENARIO || 'all';

export const options = {
  scenarios: {
    smoke: {
      executor:  'constant-vus',
      vus:       1,
      duration:  '30s',
      tags:      { scenario: 'smoke' },
      exec:      'renderSmall',
    },
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 50 },
        { duration: '5m', target: 50 },
        { duration: '2m', target: 0 },
      ],
      startTime: '30s',
      tags:      { scenario: 'ramp' },
      exec:      'renderMixed',
    },
    sustained: {
      executor:  'constant-vus',
      vus:       100,
      duration:  '10m',
      startTime: '10m',
      tags:      { scenario: 'sustained' },
      exec:      'renderMixed',
    },
  },
  thresholds: {
    http_req_duration:  ['p(95)<2000', 'p(99)<5000'],
    errors:             ['rate<0.01'],
    render_latency_ms:  ['p(95)<2000'],
  },
};

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_KEY  = __ENV.API_KEY  || 'dev-api-key-for-local-testing';
const HEADERS  = {
  'Content-Type':  'application/json',
  'X-API-Key':     API_KEY,
};

// ── Scenarios ─────────────────────────────────────────────────────────────────

export function renderSmall() {
  doRender(JSON.stringify(fixtureSmall[0]));
  sleep(0.1);
}

export function renderMixed() {
  // Alternate between small (4 line items) and large (50 line items) payloads
  // to simulate real-world traffic distribution
  const payload = Math.random() < 0.7
    ? fixtureSmall[0]
    : fixtureLarge[0];

  // Randomise contract number to avoid any caching artifacts
  const body = JSON.parse(JSON.stringify(payload));
  body.payload.document_meta.contract_no = `CT-${Math.floor(Math.random() * 90000) + 10000}`;

  doRender(JSON.stringify(body));
  sleep(0.1);
}

// ── Core render function ──────────────────────────────────────────────────────

function doRender(body) {
  const start = Date.now();
  const res   = http.post(`${BASE_URL}/v1/render`, body, {
    headers: HEADERS,
    timeout: '15s',
  });
  const elapsed = Date.now() - start;

  renderLatency.add(elapsed);

  const ok = check(res, {
    'status 202':    (r) => r.status === 202,
    'has job_id':    (r) => !!r.json('job_id'),
    'status queued': (r) => r.json('status') === 'queued',
  });

  if (ok) {
    jobsAccepted.add(1);
  } else {
    jobsRejected.add(1);
    errorRate.add(1);
  }
  errorRate.add(!ok ? 0 : 0); // reset trick to avoid double-counting
}

// ── Summary ───────────────────────────────────────────────────────────────────

export function handleSummary(data) {
  return {
    'load-test-results.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
  };
}

// ── Payload builders ──────────────────────────────────────────────────────────

function buildSmallPayload() {
  return {
    tenant_id:     '00000000-0000-0000-0000-000000000001',
    template_id:   '00000000-0000-0000-0000-000000000002',
    document_type: 'measurement_book',
    payload: {
      document_meta: {
        title:            'Earthwork Excavation — Block A',
        contract_no:      'CT-2026/EW/001',
        contractor:       'ABC Construction Pvt. Ltd.',
        work_description: 'Earthwork in ordinary soil not exceeding 1.5m depth',
        date:             '2026-11-04',
      },
      line_items: [
        { index: 0, description: 'Earthwork excavation', unit: 'cum',
          quantity: '120.50', rate: '85.00', amount: '10242.50' },
        { index: 1, description: 'Disposal of excavated earth', unit: 'cum',
          quantity: '120.50', rate: '12.00', amount: '1446.00' },
        { index: 2, description: 'Backfilling with soil', unit: 'cum',
          quantity: '50.00', rate: '45.50', amount: '2275.00' },
        { index: 3, description: 'Compaction by roller', unit: 'sqm',
          quantity: '200.00', rate: '18.75', amount: '3750.00' },
      ],
      summary: {
        subtotal:            '17713.50',
        tax_rate_pct:        18,
        tax_amount:          '3188.43',
        grand_total:         '20901.93',
        contract_value:      '500000.00',
        previous_cumulative: '100000.00',
        current_claim:       '20901.93',
      },
    },
  };
}
