import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRenderer, startReview } from './review.mjs';

test('CLI blocks startup with an outdated renderer before reading a document', async () => {
  const installed = JSON.parse(await readFile(new URL('../node_modules/markdown-it/package.json', import.meta.url)));
  const pinned = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const result = spawnSync(process.execPath, [new URL('./review.mjs', import.meta.url).pathname, 'start', '/nonexistent-review-fixture.md'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  if (installed.version !== pinned.dependencies['markdown-it']) assert.match(result.stderr, /Renderer does not match the pinned version/);
  else assert.match(result.stderr, /ENOENT/);
});

const SOURCE = '# Review 标题\n\nHello 世界 & <friends>.\n';
const sha256 = text => createHash('sha256').update(text).digest('hex');

async function waitForRemoval(path) {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await access(path);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    assert.ok(Date.now() < deadline, `Expected cleanup of ${path}`);
    await delay(10);
  }
}

async function fixture(t, { source = SOURCE, name = 'review.md', ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'review-test-'));
  let review;
  t.after(async () => {
    try {
      if (review) {
        await review.close();
        await waitForRemoval(dirname(review.sessionFile));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const file = join(directory, name);
  await writeFile(file, source);
  review = await startReview(file, { idleMs: 60000, finishGraceMs: 60000, ...options });

  async function request(path, options = {}) {
    const { body, rawBody, headers: overrides = {}, ...rest } = options;
    const payload = rawBody === undefined ? (body === undefined ? undefined : JSON.stringify(body)) : rawBody;
    const headers = new Headers({ Authorization: `Bearer ${review.token}`, Origin: review.origin });
    if (payload !== undefined) headers.set('Content-Type', 'application/json');
    for (const [name, value] of Object.entries(overrides)) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
    return fetch(`${review.origin}${path}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers,
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      ...rest,
    });
  }

  async function api(path, options = {}) {
    const { status = 200, error, ...requestOptions } = options;
    const response = await request(path, requestOptions);
    const value = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`);
    if (error) assert.match(value.error, error);
    return value;
  }

  function feedback(id = 'batch-1', hash = sha256(source)) {
    return {
      id,
      hash,
      comments: [{
        id: 'comment-1',
        quote: '世界 & <friends>',
        prefix: 'Hello ',
        suffix: '.',
        blocks: [{ id: 'block-2', startLine: 3, endLine: 3 }],
        comment: 'Keep the Unicode text; clarify this sentence.',
      }],
    };
  }

  return { ...review, directory, file, request, api, feedback };
}

async function startWait(t, review) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = review.api('/api/wait?timeout=3', { signal: controller.signal });
  // Attach a rejection handler immediately, including when a later assertion fails.
  response.catch(() => {});
  // A completed request provides an event-loop/network barrier without a fixed sleep.
  await review.api('/api/state');
  return { response };
}

test('renderer assigns stable, unique source anchors across Markdown block formats', () => {
  const source = [
    '# 标题 & heading', '',
    'Unicode 世界, café, 😀 and **strong** text.', '',
    '> quoted text', '',
    '- first', '- second', '',
    '| Left | Right |', '| --- | --- |', '| A | B |', '',
    '```js', 'const value = "<tag>";', '```', '',
    '    indented <code>', '',
    '---', '',
    'Last paragraph.',
  ].join('\n');
  const renderer = createRenderer();
  const html = renderer.render(source);
  assert.equal(renderer.render(source), html);
  for (const tag of ['h1', 'p', 'blockquote', 'ul', 'li', 'table', 'tr', 'pre', 'hr']) {
    assert.match(html, new RegExp(`<${tag}(?:\\s|>)`), `Missing ${tag}`);
  }
  assert.match(html, /Unicode 世界, café, 😀/);
  assert.match(html, /const value = &quot;&lt;tag&gt;&quot;/);
  assert.match(html, /indented &lt;code&gt;/);
  assert.match(html, /<h1 data-block-id="block-1" data-source-start="1" data-source-end="1">/);
  assert.match(html, /<pre[^>]*data-source-start="14"[^>]*data-source-end="16"/);
  assert.match(html, /<pre[^>]*data-source-start="18"[^>]*data-source-end="18"/);
  const anchors = [...html.matchAll(/data-block-id="([^"]+)"/g)].map(match => match[1]);
  assert.ok(anchors.length >= 14);
  assert.equal(new Set(anchors).size, anchors.length, 'Every block ID must identify exactly one element');
  // Tight-list paragraphs are hidden by MarkdownIt, so visible block IDs may have gaps.
  const numbers = anchors.map(id => Number(id.replace(/^block-/, '')));
  assert.ok(numbers.every((number, index) => Number.isInteger(number) && number > (numbers[index - 1] ?? 0)));
  for (const match of html.matchAll(/data-source-start="(\d+)" data-source-end="(\d+)"/g)) {
    assert.ok(Number(match[1]) > 0 && Number(match[2]) >= Number(match[1]));
    assert.ok(Number(match[2]) <= source.split('\n').length);
  }
});

test('renderer disables raw HTML, escapes code, replaces images, and isolates links', () => {
  const html = createRenderer().render([
    '<script>alert("private")</script>', '',
    '<img src="https://example.invalid/raw.png" onerror="alert(1)">', '',
    '![A <remote> & "image"](https://example.invalid/private.png)', '',
    '[external](https://example.invalid/) and [unsafe](javascript:alert(1))', '',
    '```html', '<script>unsafe()</script>', '```',
  ].join('\n'));
  assert.doesNotMatch(html, /<(?:script|img)\b/i);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.match(html, /<span class="image-placeholder">\[Image: A &lt;remote&gt; &amp; &quot;image&quot;\]<\/span>/);
  assert.doesNotMatch(html, /private\.png/);
  assert.match(html, /href="https:\/\/example\.invalid\/" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /href="javascript:/i);
});

test('session metadata, private capability file, and initial state describe the disposable source', async t => {
  const review = await fixture(t, { targetSession: 'editing-session' });
  assert.match(review.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(review.token, /^[a-f0-9]{64}$/);
  assert.equal(review.url, `${review.origin}/#token=${review.token}`);
  assert.equal(review.filePath, await realpath(review.file));
  const session = JSON.parse(await readFile(review.sessionFile, 'utf8'));
  assert.equal(session.origin, review.origin);
  assert.equal(session.token, review.token);
  assert.equal(session.filePath, review.filePath);
  assert.equal(session.targetSession, 'editing-session');
  assert.equal(session.pid, process.pid);
  assert.equal((await stat(review.sessionFile)).mode & 0o777, 0o600);
  const state = await review.api('/api/state');
  assert.equal(state.filePath, review.filePath);
  assert.equal(state.title, 'review.md');
  assert.equal(state.targetSession, 'editing-session');
  assert.equal(state.hash, sha256(SOURCE));
  assert.equal(state.finished, false);
  assert.equal(state.latestBatch, null);
  assert.match(state.html, /Hello 世界 &amp; &lt;friends&gt;/);
  assert.ok(!JSON.stringify(state).includes(review.token));
  assert.deepEqual(await review.api('/api/state'), state);
});

test('state recomputes the UTF-8 hash, escaped rendering, and line anchors after source changes', async t => {
  const review = await fixture(t);
  const before = await review.api('/api/state');
  const updated = '\n# Changed 标题 😀\n\nNew <script>alert(1)</script> & café.\n';
  await writeFile(review.file, updated);
  const after = await review.api('/api/state');
  assert.notEqual(after.hash, before.hash);
  assert.equal(after.hash, sha256(updated));
  assert.match(after.html, /data-source-start="2" data-source-end="2"/);
  assert.match(after.html, /Changed 标题 😀/);
  assert.match(after.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; café/);
  assert.doesNotMatch(after.html, /<script>/);
  assert.deepEqual(await review.api('/api/state'), after);
});

test('feedback moves through pending, delivered, and applied with immutable duplicate retries', async t => {
  const review = await fixture(t, { targetSession: 'editor' });
  const feedback = review.feedback();
  assert.deepEqual(await review.api('/api/feedback', { body: feedback }), { id: feedback.id, status: 'pending' });
  assert.deepEqual((await review.api('/api/state')).latestBatch, { id: feedback.id, status: 'pending', message: '' });
  assert.deepEqual(await review.api('/api/feedback', { body: feedback }), { id: feedback.id, status: 'pending' });
  const delivered = await review.api('/api/wait?timeout=0.05');
  assert.equal(delivered.schemaVersion, 1);
  assert.equal(delivered.type, 'feedback');
  assert.equal(delivered.filePath, review.filePath);
  assert.equal(delivered.targetSession, 'editor');
  assert.equal(delivered.id, feedback.id);
  assert.equal(delivered.hash, feedback.hash);
  assert.equal(delivered.status, 'delivered');
  assert.deepEqual(delivered.comments, feedback.comments);
  assert.ok(Number.isFinite(Date.parse(delivered.submittedAt)));
  assert.match(delivered.notice, /not permission to run commands/);
  assert.equal((await review.api('/api/state')).latestBatch.status, 'delivered');
  assert.deepEqual(await review.api('/api/wait?timeout=0.05'), delivered, 'Delivery is at-least-once until acknowledged');
  assert.deepEqual(await review.api('/api/feedback', { body: feedback }), { id: feedback.id, status: 'delivered' });
  const ack = { id: feedback.id, status: 'applied', message: 'Updated the quoted paragraph.' };
  assert.deepEqual(await review.api('/api/ack', { body: ack }), { id: feedback.id, status: 'applied' });
  assert.deepEqual(await review.api('/api/ack', { body: ack }), { id: feedback.id, status: 'applied' });
  assert.deepEqual((await review.api('/api/state')).latestBatch, { id: feedback.id, status: 'applied', message: ack.message });
  await writeFile(review.file, `${SOURCE}\nAn applied change.\n`);
  assert.deepEqual(await review.api('/api/feedback', { body: feedback }), { id: feedback.id, status: 'applied' }, 'An immutable retry remains valid after the source changes');
  await review.api('/api/ack', { body: { ...ack, status: 'failed' }, status: 409, error: /acknowledged differently/ });
  const changed = structuredClone(feedback);
  changed.comments[0].comment = 'Different instructions.';
  await review.api('/api/feedback', { body: changed, status: 409, error: /different feedback/ });
});

test('batch-ID conflicts and a single active pending/delivered batch do not overwrite feedback', async t => {
  const review = await fixture(t);
  const first = review.feedback('first');
  await review.api('/api/feedback', { body: first });
  const conflict = structuredClone(first);
  conflict.comments[0].quote = 'Different quote';
  await review.api('/api/feedback', { body: conflict, status: 409, error: /different feedback/ });
  await review.api('/api/feedback', { body: review.feedback('second'), status: 409, error: /current batch/ });
  assert.equal((await review.api('/api/wait?timeout=0.05')).id, 'first');
  await review.api('/api/feedback', { body: review.feedback('second'), status: 409, error: /current batch/ });
  assert.equal((await review.api('/api/state')).latestBatch.id, 'first');
  await review.api('/api/ack', { body: { id: 'first', status: 'failed', message: 'Source changed; reselect.' } });
  assert.deepEqual(await review.api('/api/ack', { body: { id: 'first', status: 'failed' } }), { id: 'first', status: 'failed' });
  assert.deepEqual((await review.api('/api/state')).latestBatch, { id: 'first', status: 'failed', message: 'Source changed; reselect.' });
  await review.api('/api/ack', { body: { id: 'first', status: 'applied' }, status: 409 });
  assert.deepEqual(await review.api('/api/feedback', { body: review.feedback('second') }), { id: 'second', status: 'pending' });
  // An old retry must not replace the newer active batch.
  assert.deepEqual(await review.api('/api/feedback', { body: first }), { id: 'first', status: 'failed' });
  assert.equal((await review.api('/api/state')).latestBatch.id, 'second');
});

test('simultaneous feedback submissions still allow only one active batch', async t => {
  const review = await fixture(t);
  const responses = await Promise.all([
    review.request('/api/feedback', { body: review.feedback('concurrent-first') }),
    review.request('/api/feedback', { body: review.feedback('concurrent-second') }),
  ]);
  const outcomes = await Promise.all(responses.map(async response => ({ status: response.status, value: await response.json() })));
  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), [200, 409], 'Concurrent requests must not overwrite the first pending batch');
  const accepted = outcomes.find(outcome => outcome.status === 200).value;
  const state = await review.api('/api/state');
  assert.equal(state.latestBatch.id, accepted.id);
  assert.equal((await review.api('/api/wait?timeout=0.05')).id, accepted.id);
});

test('simultaneous conflicting uses of one batch ID do not replace immutable feedback', async t => {
  const review = await fixture(t);
  const first = review.feedback('same-batch');
  const second = structuredClone(first);
  second.comments[0].comment = 'Different concurrent instructions.';
  const responses = await Promise.all([
    review.request('/api/feedback', { body: first }),
    review.request('/api/feedback', { body: second }),
  ]);
  const outcomes = await Promise.all(responses.map(async response => ({ status: response.status, value: await response.json() })));
  assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), [200, 409]);
  const accepted = outcomes[0].status === 200 ? first : second;
  const rejected = outcomes[0].status === 409 ? first : second;
  assert.deepEqual((await review.api('/api/wait?timeout=0.05')).comments, accepted.comments);
  await review.api('/api/feedback', { body: rejected, status: 409, error: /different feedback/ });
});

test('simultaneous exact duplicate submissions return the same immutable batch', async t => {
  const review = await fixture(t);
  const feedback = review.feedback('concurrent-retry');
  const responses = await Promise.all([
    review.api('/api/feedback', { body: feedback }),
    review.api('/api/feedback', { body: feedback }),
  ]);
  assert.deepEqual(responses, [{ id: feedback.id, status: 'pending' }, { id: feedback.id, status: 'pending' }]);
  const delivered = await review.api('/api/wait?timeout=0.05');
  assert.deepEqual(delivered.comments, feedback.comments);
  await review.api('/api/ack', { body: { id: feedback.id, status: 'applied' } });
  assert.equal((await review.api('/api/wait?timeout=0.05')).type, 'timeout');
});

test('finishing and submitting concurrently cannot leave feedback pending in a finished review', async t => {
  const review = await fixture(t);
  const [feedback, finish] = await Promise.all([
    review.request('/api/feedback', { body: review.feedback() }),
    review.request('/api/finish', { body: {} }),
  ]);
  await Promise.all([feedback.text(), finish.text()]);
  assert.ok(
    (feedback.status === 200 && finish.status === 409) || (feedback.status === 410 && finish.status === 200),
    `Expected exactly one operation to win; feedback=${feedback.status}, finish=${finish.status}`,
  );
  const state = await review.api('/api/state');
  assert.ok(!state.finished || state.latestBatch === null);
});

test('stale feedback is rejected without mutation, while a refreshed hash is accepted', async t => {
  const review = await fixture(t);
  const stale = review.feedback();
  const changed = `${SOURCE}\nNew Unicode 内容.\n`;
  await writeFile(review.file, changed);
  await review.api('/api/feedback', { body: stale, status: 409, error: /Document changed/ });
  assert.equal((await review.api('/api/state')).latestBatch, null);
  const fresh = { ...stale, hash: sha256(changed) };
  assert.deepEqual(await review.api('/api/feedback', { body: fresh }), { id: fresh.id, status: 'pending' });
  await writeFile(review.file, `${changed}\nAnother external change.\n`);
  const delivered = await review.api('/api/wait?timeout=0.05');
  assert.equal(delivered.hash, fresh.hash, 'Pending feedback retains its original source snapshot');
  assert.notEqual(delivered.hash, (await review.api('/api/state')).hash);
});

test('wait times out without changing state and validates timeout bounds', async t => {
  const review = await fixture(t);
  assert.deepEqual(await review.api('/api/wait?timeout=0.05'), { type: 'timeout', filePath: review.filePath });
  assert.equal((await review.api('/api/state')).latestBatch, null);
  for (const timeout of ['0', '-1', '0.049', '541', 'NaN', 'Infinity', '', 'hello']) {
    await review.api(`/api/wait?timeout=${encodeURIComponent(timeout)}`, { status: 400, error: /wait timeout/ });
  }
});

test('a waiting consumer receives new feedback and concurrent waiters are rejected', async t => {
  const review = await fixture(t);
  const waiting = await startWait(t, review);
  await review.api('/api/wait?timeout=0.05', { status: 409, error: /Another waiter/ });
  const submitted = await review.api('/api/feedback', { body: review.feedback() });
  assert.equal(submitted.status, 'delivered');
  assert.equal((await waiting.response).id, 'batch-1');
  assert.equal((await review.api('/api/wait?timeout=0.05')).id, 'batch-1');
});

test('acknowledgment rejects unknown batches, invalid states, and oversized messages', async t => {
  const review = await fixture(t);
  await review.api('/api/ack', { body: { id: 'unknown', status: 'applied' }, status: 404 });
  for (const body of [null, {}, { id: 'unknown' }, { id: 'unknown', status: 'pending' }, { status: 'applied' }]) {
    await review.api('/api/ack', { body, status: body?.status === 'applied' ? 404 : 400 });
  }
  await review.api('/api/feedback', { body: review.feedback() });
  await review.api('/api/ack', { body: { id: 'batch-1', status: 'applied', message: 'x'.repeat(2001) }, status: 400 });
  assert.equal((await review.api('/api/state')).latestBatch.status, 'pending');
  assert.deepEqual(await review.api('/api/ack', { body: { id: 'batch-1', status: 'failed' } }), { id: 'batch-1', status: 'failed' });
  assert.equal((await review.api('/api/wait?timeout=0.05')).type, 'timeout');
});

test('finish refuses active feedback, then is idempotent and rejects further submissions', async t => {
  const review = await fixture(t);
  await review.api('/api/feedback', { body: review.feedback() });
  await review.api('/api/finish', { body: {}, status: 409 });
  assert.equal((await review.api('/api/state')).finished, false);
  await review.api('/api/wait?timeout=0.05');
  await review.api('/api/finish', { body: {}, status: 409 });
  await review.api('/api/ack', { body: { id: 'batch-1', status: 'applied' } });
  assert.deepEqual(await review.api('/api/finish', { body: {} }), { status: 'finished' });
  assert.deepEqual(await review.api('/api/finish', { body: {} }), { status: 'finished' });
  const state = await review.api('/api/state');
  assert.equal(state.finished, true);
  assert.equal(state.latestBatch.status, 'applied');
  assert.deepEqual(await review.api('/api/wait?timeout=0.05'), { type: 'finished', filePath: review.filePath, targetSession: null });
  await review.api('/api/feedback', { body: review.feedback('new-batch'), status: 410, error: /finished/ });
  await review.api('/api/ack', { body: { id: 'batch-1', status: 'applied' } });
});

test('finish releases an outstanding waiter and cleans up after its grace period', async t => {
  const review = await fixture(t, { finishGraceMs: 80, targetSession: 'finish-target' });
  const waiting = await startWait(t, review);
  await review.api('/api/finish', { body: {} });
  assert.deepEqual(await waiting.response, { type: 'finished', filePath: review.filePath, targetSession: 'finish-target' });
  await waitForRemoval(dirname(review.sessionFile));
  await assert.rejects(review.request('/api/state'));
});

test('stop releases an outstanding waiter, removes its session directory, and preserves the source', async t => {
  const review = await fixture(t);
  const waiting = await startWait(t, review);
  assert.deepEqual(await review.api('/api/stop', { body: {} }), { status: 'stopped' });
  assert.equal((await waiting.response).type, 'finished');
  await waitForRemoval(dirname(review.sessionFile));
  assert.equal(await readFile(review.file, 'utf8'), SOURCE);
  await assert.rejects(review.request('/api/state'));
  await review.close();
});

test('stop can abandon pending feedback without changing the document', async t => {
  const review = await fixture(t);
  await review.api('/api/feedback', { body: review.feedback() });
  assert.deepEqual(await review.api('/api/stop', { body: {} }), { status: 'stopped' });
  await waitForRemoval(dirname(review.sessionFile));
  assert.equal(await readFile(review.file, 'utf8'), SOURCE);
});

test('explicit close is idempotent, releases waiters, and removes temporary capability files', async t => {
  const review = await fixture(t);
  const waiting = await startWait(t, review);
  await review.close();
  assert.equal((await waiting.response).type, 'finished');
  await review.close();
  await waitForRemoval(dirname(review.sessionFile));
  assert.equal(await readFile(review.file, 'utf8'), SOURCE);
});

test('an idle session closes and removes its capability directory', async t => {
  const review = await fixture(t, { idleMs: 100 });
  await waitForRemoval(dirname(review.sessionFile));
  await assert.rejects(review.request('/api/state'));
});

test('fixed assets have restrictive headers and arbitrary files cannot be read', async t => {
  const review = await fixture(t);
  for (const [path, type] of [['/', 'text/html'], ['/review.js', 'text/javascript'], ['/review.css', 'text/css']]) {
    const response = await review.request(path, { headers: { Authorization: null } });
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /img-src 'none'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const body = await response.text();
    assert.ok(body.length > 0);
    assert.ok(!body.includes(review.token));
  }
  for (const path of ['/session.json', '/review.md', '/review.mjs', '/assets/review.html', '/etc/passwd', '/%2e%2e%2freview.mjs', '/review.js/extra']) {
    await review.api(path, { status: 404, error: /Not found/ });
  }
  await review.api('/', { body: {}, status: 404 });
  await review.api('/api/unknown', { status: 404 });
  await review.api('/api/state', { body: {}, status: 404 });
});

test('prototype property names are not asset routes', async t => {
  const review = await fixture(t);
  for (const path of ['/constructor', '/__proto__', '/toString', '/hasOwnProperty']) {
    await review.api(path, { status: 404, error: /Not found/ });
  }
});

test('all API routes require the exact Bearer capability, not query or cookie tokens', async t => {
  const review = await fixture(t);
  for (const authorization of [null, '', review.token, `Basic ${review.token}`, `Bearer ${'0'.repeat(64)}`, `Bearer ${review.token}extra`]) {
    await review.api('/api/state', { headers: { Authorization: authorization }, status: 401 });
  }
  await review.api(`/api/state?token=${review.token}`, { headers: { Authorization: null, Cookie: `token=${review.token}` }, status: 401 });
  for (const path of ['/api/feedback', '/api/ack', '/api/finish', '/api/stop']) {
    await review.api(path, { body: {}, headers: { Authorization: null }, status: 401 });
  }
  await review.api('/api/wait?timeout=0.05', { headers: { Authorization: null }, status: 401 });
  assert.equal((await review.api('/api/state')).finished, false);
  assert.equal((await review.api('/api/state', { headers: { Origin: null } })).hash, sha256(SOURCE),
    'Same-origin GETs without Origin remain allowed when capability and Host are valid');
});

test('foreign, opaque, and same-port localhost Origins are rejected on API and assets', async t => {
  const review = await fixture(t);
  const port = new URL(review.origin).port;
  for (const origin of ['https://example.invalid', 'null', `http://localhost:${port}`, `${review.origin}/`]) {
    await review.api('/api/state', { headers: { Origin: origin }, status: 403, error: /origin/ });
    await review.api('/review.js', { headers: { Origin: origin }, status: 403, error: /origin/ });
  }
  assert.equal((await review.api('/api/state')).hash, sha256(SOURCE));
});

test('Host validation rejects DNS-rebinding hosts even with valid Origin and authorization', async t => {
  const review = await fixture(t);
  const port = new URL(review.origin).port;
  // Native fetch in newer Node releases discards Host overrides. Use HTTP only here.
  function requestWithHost(path, host) {
    return new Promise((resolve, reject) => {
      const request = httpRequest(`${review.origin}${path}`, {
        headers: { Host: host, Origin: review.origin, Authorization: `Bearer ${review.token}` },
        agent: false,
        signal: AbortSignal.timeout(5000),
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
      request.end();
    });
  }
  for (const host of ['example.invalid', `localhost:${port}`, '127.0.0.1:1']) {
    for (const path of ['/api/state', '/']) {
      const response = await requestWithHost(path, host);
      assert.equal(response.status, 403);
      assert.match(JSON.parse(response.text).error, /host/);
    }
  }
});

test('JSON endpoints reject malformed, empty, wrong-content-type, and oversized requests', async t => {
  const review = await fixture(t);
  for (const path of ['/api/feedback', '/api/ack', '/api/finish', '/api/stop']) {
    await review.api(path, { rawBody: '{"unfinished":', status: 400, error: /Invalid JSON/ });
    await review.api(path, { rawBody: '', status: 400, error: /Invalid JSON/ });
    await review.api(path, { rawBody: '{}', headers: { 'Content-Type': 'text/plain' }, status: 415 });
    await review.api(path, { rawBody: '{}', headers: { 'Content-Type': null }, status: 415 });
    await review.api(path, { rawBody: JSON.stringify({ padding: 'x'.repeat(256 * 1024) }), status: 413, error: /too large/ });
  }
  assert.equal((await review.api('/api/state')).finished, false);
});

const invalidFeedback = [
  ['missing batch ID', value => { delete value.id; }],
  ['null batch ID', value => { value.id = null; }],
  ['numeric batch ID', value => { value.id = 7; }],
  ['array batch ID', value => { value.id = ['batch']; }],
  ['empty batch ID', value => { value.id = ''; }],
  ['unsafe batch ID', value => { value.id = '../batch'; }],
  ['oversized batch ID', value => { value.id = 'x'.repeat(81); }],
  ['missing hash', value => { delete value.hash; }],
  ['invalid hash', value => { value.hash = 'not-a-hash'; }],
  ['missing comments', value => { delete value.comments; }],
  ['empty comments', value => { value.comments = []; }],
  ['non-array comments', value => { value.comments = {}; }],
  ['too many comments', value => { value.comments = Array.from({ length: 51 }, (_, index) => ({ ...value.comments[0], id: `c-${index}` })); }],
  ['null comment', value => { value.comments = [null]; }],
  ['missing comment ID', value => { delete value.comments[0].id; }],
  ['null comment ID', value => { value.comments[0].id = null; }],
  ['numeric comment ID', value => { value.comments[0].id = 7; }],
  ['array comment ID', value => { value.comments[0].id = ['comment']; }],
  ['duplicate comment IDs', value => { value.comments.push(structuredClone(value.comments[0])); }],
  ['missing quote', value => { delete value.comments[0].quote; }],
  ['blank quote', value => { value.comments[0].quote = ' \n '; }],
  ['non-string quote', value => { value.comments[0].quote = 42; }],
  ['oversized quote', value => { value.comments[0].quote = 'x'.repeat(20001); }],
  ['missing prefix', value => { delete value.comments[0].prefix; }],
  ['oversized prefix', value => { value.comments[0].prefix = 'x'.repeat(501); }],
  ['missing suffix', value => { delete value.comments[0].suffix; }],
  ['non-string suffix', value => { value.comments[0].suffix = null; }],
  ['missing block hints', value => { delete value.comments[0].blocks; }],
  ['non-array block hints', value => { value.comments[0].blocks = {}; }],
  ['too many block hints', value => { value.comments[0].blocks = Array.from({ length: 65 }, () => ({ id: 'block-1', startLine: 1, endLine: 1 })); }],
  ['null block hint', value => { value.comments[0].blocks = [null]; }],
  ['missing block ID', value => { delete value.comments[0].blocks[0].id; }],
  ['numeric block ID', value => { value.comments[0].blocks[0].id = 7; }],
  ['null block ID', value => { value.comments[0].blocks[0].id = null; }],
  ['invalid start line', value => { value.comments[0].blocks[0].startLine = 0; }],
  ['non-integer start line', value => { value.comments[0].blocks[0].startLine = 1.5; }],
  ['missing end line', value => { delete value.comments[0].blocks[0].endLine; }],
  ['backwards line range', value => { value.comments[0].blocks[0].endLine = 2; }],
  ['missing comment text', value => { delete value.comments[0].comment; }],
  ['blank comment text', value => { value.comments[0].comment = ' \t'; }],
  ['oversized comment text', value => { value.comments[0].comment = 'x'.repeat(8001); }],
];

test('invalid feedback fields return 400 without creating an active batch', async t => {
  for (const [name, mutate] of invalidFeedback) {
    await t.test(name, async t => {
      const review = await fixture(t);
      const feedback = review.feedback();
      mutate(feedback);
      await review.api('/api/feedback', { body: feedback, status: 400 });
      assert.equal((await review.api('/api/state')).latestBatch, null);
    });
  }
  for (const [name, body] of [['null', null], ['array', []], ['string', 'feedback'], ['empty object', {}]]) {
    await t.test(name, async t => {
      const review = await fixture(t);
      await review.api('/api/feedback', { body, status: 400 });
      assert.equal((await review.api('/api/state')).latestBatch, null);
    });
  }
});

test('empty context and block hints are valid for document-wide feedback', async t => {
  const review = await fixture(t);
  const feedback = review.feedback();
  Object.assign(feedback.comments[0], { prefix: '', suffix: '', blocks: [] });
  await review.api('/api/feedback', { body: feedback });
  assert.deepEqual((await review.api('/api/wait?timeout=0.05')).comments, feedback.comments);
});

test('source validation rejects unsupported, missing, and oversized files before opening a session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'review-validation-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unsupported = join(directory, 'document.txt');
  await writeFile(unsupported, 'text');
  await assert.rejects(startReview(unsupported), /\.md or \.markdown/);
  await assert.rejects(startReview(join(directory, 'missing.md')), { code: 'ENOENT' });
  const oversized = join(directory, 'oversized.md');
  await writeFile(oversized, '界'.repeat(Math.ceil(2 * 1024 * 1024 / 3)));
  await assert.rejects(startReview(oversized), error => error.status === 413);
  const valid = join(directory, 'valid.md');
  await writeFile(valid, SOURCE);
  await assert.rejects(startReview(valid, { targetSession: '' }), /target session/);
});

test('uppercase Markdown extensions and empty sources are supported', async t => {
  const review = await fixture(t, { name: 'EMPTY.MARKDOWN', source: '' });
  const state = await review.api('/api/state');
  assert.equal(state.title, 'EMPTY.MARKDOWN');
  assert.equal(state.hash, sha256(''));
  assert.equal(state.html, '');
});
