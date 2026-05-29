// End-to-end smoke + error-capture tests for press-to-hold-to-translate.
//
// These tests:
//   - load the app
//   - go through the language picker
//   - simulate a press-and-hold on the talk button
//   - capture browser console messages, page errors, failed network requests,
//     and any non-2xx responses from our /api/session endpoint
//   - capture WebRTC data-channel events from the OpenAI Realtime session
//
// They use a fake mic via Chromium flags (set in playwright.config.mjs) so
// getUserMedia() resolves without a real audio device.
//
// Requirements to run:
//   1. `npm install`
//   2. `npx playwright install chromium`
//   3. OPENAI_API_KEY in .env
//   4. `npx playwright test`

import { test, expect } from '@playwright/test';

const logs = {
  console: [],
  pageErrors: [],
  failedRequests: [],
  apiSessionResponses: [],
  realtimeEvents: [],
};

test.beforeEach(async ({ page }) => {
  logs.console = [];
  logs.pageErrors = [];
  logs.failedRequests = [];
  logs.apiSessionResponses = [];
  logs.realtimeEvents = [];

  page.on('console', (msg) => {
    logs.console.push({ type: msg.type(), text: msg.text() });
  });

  page.on('pageerror', (err) => {
    logs.pageErrors.push({ message: err.message, stack: err.stack });
  });

  page.on('requestfailed', (req) => {
    logs.failedRequests.push({
      url: req.url(),
      method: req.method(),
      failure: req.failure()?.errorText,
    });
  });

  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.endsWith('/api/session')) {
      let body = '';
      try {
        body = await resp.text();
      } catch {
        body = '<unreadable>';
      }
      logs.apiSessionResponses.push({
        status: resp.status(),
        statusText: resp.statusText(),
        body,
      });
    }
    if (url.includes('api.openai.com')) {
      logs.realtimeEvents.push({
        kind: 'openai-http',
        url,
        status: resp.status(),
      });
    }
  });

  // Mirror Realtime data-channel events into the page console so we capture them.
  await page.addInitScript(() => {
    const origCreate = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...args) {
      const dc = origCreate.apply(this, args);
      const origAddListener = dc.addEventListener.bind(dc);
      dc.addEventListener = function (type, handler, ...rest) {
        if (type === 'message') {
          const wrapped = (ev) => {
            try {
              console.log('[realtime-dc-msg]', ev.data);
            } catch {}
            return handler(ev);
          };
          return origAddListener(type, wrapped, ...rest);
        }
        return origAddListener(type, handler, ...rest);
      };
      Object.defineProperty(dc, 'onmessage', {
        set(fn) {
          this.addEventListener('message', fn);
        },
      });
      return dc;
    };
  });
});

async function pickLanguages(page, a = 'English', b = 'Spanish') {
  // Picker modal shows on first load.
  await expect(page.locator('#picker')).toBeVisible();
  await page.selectOption('#lang-a', a);
  await page.selectOption('#lang-b', b);
  await page.click('#picker-save');
  await expect(page.locator('#picker')).toBeHidden();
}

function dumpLogs(label) {
  console.log(`\n========== ${label} ==========`);
  console.log('\n--- /api/session responses ---');
  for (const r of logs.apiSessionResponses) {
    console.log(`  HTTP ${r.status} ${r.statusText}`);
    console.log(`  body: ${r.body}`);
  }
  console.log('\n--- OpenAI HTTP calls (from browser) ---');
  for (const r of logs.realtimeEvents) {
    console.log(`  ${r.kind} ${r.status} ${r.url}`);
  }
  console.log('\n--- Failed network requests ---');
  for (const r of logs.failedRequests) {
    console.log(`  ${r.method} ${r.url}  -> ${r.failure}`);
  }
  console.log('\n--- Page errors (uncaught JS) ---');
  for (const e of logs.pageErrors) {
    console.log(`  ${e.message}`);
    if (e.stack) console.log(e.stack);
  }
  console.log('\n--- Browser console ---');
  for (const m of logs.console) {
    console.log(`  [${m.type}] ${m.text}`);
  }
  console.log('========== end ==========\n');
}

test('app loads and language picker shows on first visit', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#talk-btn')).toBeVisible();
  await expect(page.locator('#picker')).toBeVisible();
  dumpLogs('load');
  // Sanity: no JS errors during load.
  expect(logs.pageErrors).toEqual([]);
});

test('full press-and-hold flow surfaces session + WebRTC errors', async ({ page }) => {
  await page.goto('/');
  await pickLanguages(page, 'English', 'Spanish');

  const talk = page.locator('#talk-btn');
  await expect(talk).toBeVisible();

  // Press-and-hold for 2.5s, then release. This forces:
  //   1. /api/session call to our server (mints ephemeral OpenAI token)
  //   2. SDP exchange with api.openai.com
  //   3. input_audio_buffer.commit + response.create after release
  const box = await talk.boundingBox();
  if (!box) throw new Error('Talk button not found');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(2500);
  await page.mouse.up();

  // Give the response a chance to come back.
  await page.waitForTimeout(8000);

  dumpLogs('press-and-hold');

  // Don't assert success/failure — the point is to surface what actually
  // happens. The dump above is the diagnostic output.
  // We do assert that the server replied to /api/session in some form.
  expect(logs.apiSessionResponses.length).toBeGreaterThan(0);
});

test('tap-toggle flow also exercises Realtime', async ({ page }) => {
  await page.goto('/');
  await pickLanguages(page, 'English', 'Spanish');

  const talk = page.locator('#talk-btn');
  // Short tap → enters "recording", stays there.
  await talk.click();
  await page.waitForTimeout(2500);
  // Tap again → commits.
  await talk.click();
  await page.waitForTimeout(8000);

  dumpLogs('tap-toggle');
  expect(logs.apiSessionResponses.length).toBeGreaterThan(0);
});
