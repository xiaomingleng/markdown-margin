import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRenderer, main, startReview } from './review.mjs';

test('CLI blocks startup with an outdated renderer before reading a document', async () => {
  const installed = JSON.parse(await readFile(new URL('../node_modules/markdown-it/package.json', import.meta.url)));
  const pinned = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./review.mjs', import.meta.url)), 'start', '/nonexistent-review-fixture.md'], { encoding: 'utf8' });
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

test('renderer disables raw HTML, escapes code, blocks remote images, and isolates links', () => {
  const html = createRenderer().render([
    '<script>alert("private")</script>', '',
    '<img src="https://example.invalid/raw.png" onerror="alert(1)">', '',
    '![A <remote> & "image"](https://example.invalid/private.png)', '',
    '[external](https://example.invalid/) and [unsafe](javascript:alert(1))', '',
    '```html', '<script>unsafe()</script>', '```',
  ].join('\n'), { filePath: join(tmpdir(), 'review.md'), images: new Map() });
  assert.doesNotMatch(html, /<script\b|<img\b[^>]*\bsrc=/i);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.match(html, /<img alt="A &lt;remote&gt; &amp; &quot;image&quot;" hidden>/);
  assert.match(html, /Only relative local images are supported/);
  assert.match(html, /data-image-url=""/);
  assert.match(html, /href="https:\/\/example\.invalid\/" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /href="javascript:/i);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');

test('image review preserves inline, repeated, reference, and table image source anchors', () => {
  const source = 'Before ![same](one.png "title") and ![same][picture] after.\n\n| Image |\n| --- |\n| ![table](two.png) |\n\n[picture]: two.png\n';
  const images = new Map();
  const html = createRenderer().render(source, { filePath: join(tmpdir(), 'review.md'), hash: sha256(source), images });
  assert.equal(images.size, 3);
  assert.match(html, /data-block-id="image-1" data-source-start="1" data-source-end="1" hidden>!\[same\]\(one.png &quot;title&quot;\)/);
  assert.match(html, /data-block-id="image-2"[^>]*>!\[same\]\[picture\]/);
  assert.match(html, /data-block-id="image-3" data-source-start="5" data-source-end="5" hidden>!\[table\]\(two.png\)/);
  assert.match(html, new RegExp(`data-image-url="/api/images/${sha256(source)}/image-1"`));
  assert.doesNotMatch(html, /<img\b[^>]*\bsrc=/);
  const anchors = [...html.matchAll(/data-block-id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(anchors).size, anchors.length);
});

test('local images are authenticated, source-bound, and delivered with exact image comments', async t => {
  const quote = '![A screenshot](shot%20one.png)';
  const source = `# Images\n\n${quote}\n`;
  const review = await fixture(t, { source });
  await writeFile(join(review.directory, 'shot one.png'), PNG);
  const state = await review.api('/api/state');
  const path = `/api/images/${state.hash}/image-1`;
  const response = await review.request(path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  await review.api(path, { headers: { Authorization: null }, status: 401 });
  await review.api(`/api/images/${state.hash}/image-2`, { status: 404 });
  await review.api('/shot%20one.png', { status: 404 });
  const feedback = review.feedback('image-batch');
  feedback.comments[0].quote = quote;
  feedback.comments[0].blocks = [{ id: 'image-1', startLine: 3, endLine: 3 }];
  await review.api('/api/feedback', { body: feedback });
  assert.deepEqual((await review.api('/api/wait?timeout=0.05')).comments, feedback.comments);
  await writeFile(review.file, `${source}\nChanged source.\n`);
  await review.api(path, { status: 409, error: /Document changed/ });
  await review.api('/api/state');
  await review.api(path, { status: 404 });
});

test('image review blocks remote, absolute, and escaped paths without asset requests', () => {
  const images = new Map();
  const html = createRenderer().render([
    '![remote](https://example.invalid/private.png)',
    '![network](//example.invalid/private.png)',
    '![absolute](/private.png)',
    '![drive](C:/private.png)',
    '![escape](../private.png)',
    '![encoded](%2e%2e%2fprivate.png)',
    '![UNC](%5c%5cserver%5cprivate.png)',
  ].join('\n\n'), { filePath: join(tmpdir(), 'review.md'), images });
  assert.equal(images.size, 0);
  assert.equal((html.match(/data-image-url=""/g) || []).length, 7);
  assert.match(html, /outside the allowed image folder/);
  assert.doesNotMatch(html, /<img\b[^>]*\bsrc=/);
});

test('missing, unsupported, and oversized images return explicit errors', async t => {
  const source = '![missing](missing.png)\n\n![unsafe](unsafe.png)\n\n![large](large.png)\n';
  const review = await fixture(t, { source });
  await writeFile(join(review.directory, 'unsafe.png'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await writeFile(join(review.directory, 'large.png'), Buffer.alloc(8 * 1024 * 1024 + 1));
  const state = await review.api('/api/state');
  const path = `/api/images/${state.hash}`;
  await review.api(`${path}/image-1`, { status: 404, error: /not found/ });
  await review.api(`${path}/image-2`, { status: 415, error: /SVG and other formats are blocked/ });
  await review.api(`${path}/image-3`, { status: 413, error: /under 8 MiB/ });
});

test('local image links cannot follow directory symlinks outside the document folder', async t => {
  const outside = await mkdtemp(join(tmpdir(), 'review-image-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'private.png'), PNG);
  const review = await fixture(t, { source: '![linked](linked/private.png)\n' });
  await symlink(outside, join(review.directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const state = await review.api('/api/state');
  await review.api(`/api/images/${state.hash}/image-1`, { status: 403, error: /outside the allowed image folder/ });
});

test('an explicit image root allows parent-relative images but blocks traversal and symlink escapes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'review-image-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const document = join(project, 'docs', 'review.md');
  await mkdir(dirname(document), { recursive: true });
  await writeFile(join(project, 'shared image.png'), PNG);
  await writeFile(join(root, 'private.png'), PNG);
  await writeFile(document, '![shared](../shared%20image.png)\n\n![escape](../../private.png)\n\n![linked](../linked/private.png)\n');
  await symlink(root, join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const review = await startReview(document, { imageRoot: project });
  t.after(() => review.close());
  const headers = { Authorization: `Bearer ${review.token}` };
  const state = await (await fetch(`${review.origin}/api/state`, { headers })).json();
  assert.match(state.html, /outside the allowed image folder/);
  const response = await fetch(`${review.origin}/api/images/${state.hash}/image-1`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  const blocked = await fetch(`${review.origin}/api/images/${state.hash}/image-2`, { headers });
  assert.equal(blocked.status, 404);
  await blocked.text();
  const linked = await fetch(`${review.origin}/api/images/${state.hash}/image-3`, { headers });
  assert.equal(linked.status, 403);
  assert.match((await linked.json()).error, /outside the allowed image folder/);
});

test('image roots reject missing paths, files, and directories that do not contain the document', async t => {
  const review = await fixture(t);
  await assert.rejects(startReview(review.file, { imageRoot: join(review.directory, 'missing') }), { code: 'ENOENT' });
  await assert.rejects(startReview(review.file, { imageRoot: review.file }), /must be a directory/);
  const unrelated = join(review.directory, 'unrelated');
  await mkdir(unrelated);
  await assert.rejects(startReview(review.file, { imageRoot: unrelated }), /must contain the reviewed document/);
  await assert.rejects(main(['serve', review.file, '--image-root', unrelated]), /must contain the reviewed document/);
  await symlink(review.directory, join(unrelated, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(startReview(join(unrelated, 'linked', 'review.md'), { imageRoot: unrelated }), /must contain the reviewed document/);
});

test('Mermaid fences keep exact source and unique anchors alongside graph controls', () => {
  const source = '# Diagrams\n\n```mermaid\nflowchart LR\n  A["<unsafe> & 世界"] --> B\n```\n\n```js\nmermaid is just text here\n```\n\n```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello\n```\n';
  const html = createRenderer().render(source);
  assert.equal((html.match(/class="mermaid-block"/g) || []).length, 2);
  assert.equal((html.match(/data-diagram-comment/g) || []).length, 2);
  assert.match(html, /<pre data-block-id="block-2" data-source-start="3" data-source-end="6" hidden><code class="language-mermaid">flowchart LR\n  A\[&quot;&lt;unsafe&gt; &amp; 世界&quot;\] --&gt; B\n<\/code><\/pre>/);
  assert.match(html, /<pre data-block-id="block-3"[^>]*><code class="language-js">mermaid is just text here/);
  const anchors = [...html.matchAll(/data-block-id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(anchors).size, anchors.length);
  assert.match(html, /id="diagram-block-2"/);
  assert.match(html, /id="diagram-block-4"/);
  assert.doesNotMatch(html, /<unsafe>/);
});

test('Mermaid modules are served locally without exposing other dependency files', async t => {
  const review = await fixture(t);
  const response = await review.request('/vendor/mermaid/mermaid.esm.min.mjs', { headers: { Authorization: null } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/javascript/);
  const module = await response.text();
  const chunk = /["']\.\/(chunks\/mermaid\.esm\.min\/[A-Za-z0-9_-]+\.mjs)["']/.exec(module);
  assert.ok(chunk, 'The local entry point must reference its bundled chunks');
  const chunkResponse = await review.request(`/vendor/mermaid/${chunk[1]}`);
  assert.equal(chunkResponse.status, 200);
  assert.ok((await chunkResponse.text()).length > 0);
  for (const path of ['/vendor/mermaid/package.json', '/vendor/mermaid/../../package.json',
    '/vendor/mermaid/%2e%2e%2fpackage.json', '/vendor/mermaid/chunks/mermaid.core/chunk.mjs',
    '/vendor/mermaid/mermaid.esm.min.mjs.map']) {
    await review.api(path, { status: 404, error: /Not found/ });
  }
});

test('diagram feedback retains raw Mermaid source and fenced line hints through delivery', async t => {
  const code = 'flowchart LR\n  A["世界"] --> B\n';
  const source = `# Diagram\n\n\`\`\`mermaid\n${code}\`\`\`\n`;
  const review = await fixture(t, { source });
  const feedback = review.feedback('diagram-batch');
  feedback.comments[0].quote = code;
  feedback.comments[0].blocks = [{ id: 'block-2', startLine: 3, endLine: 6 }];
  feedback.comments[0].comment = 'Add an explicit no-go branch.';
  await review.api('/api/feedback', { body: feedback });
  const delivered = await review.api('/api/wait?timeout=0.05');
  assert.deepEqual(delivered.comments, feedback.comments);
  assert.equal(await readFile(review.file, 'utf8'), source);
});

test('session metadata and initial state describe the disposable source', async t => {
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

test('session capability file uses owner-only POSIX permissions', {
  skip: process.platform === 'win32' ? 'Windows uses ACLs rather than POSIX mode bits.' : false,
}, async t => {
  const review = await fixture(t);
  assert.equal((await stat(review.sessionFile)).mode & 0o777, 0o600);
});

test('document titles preserve spaces and Unicode without the directory path', async t => {
  const name = 'Review 标题 #1.md';
  const review = await fixture(t, { name });
  assert.equal((await review.api('/api/state')).title, name);
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

test('questions and edits receive separate answers/actions that survive source changes and later batches', async t => {
  const review = await fixture(t);
  const feedback = review.feedback('questions');
  feedback.comments[0].kind = 'question';
  feedback.comments.push({ ...feedback.comments[0], id: 'edit-1', kind: 'edit', comment: 'Fix the typo.' });
  await review.api('/api/feedback', { body: feedback });
  assert.deepEqual((await review.api('/api/wait?timeout=0.05')).comments, feedback.comments);
  await review.api('/api/ack', { body: { id: feedback.id, status: 'applied' }, status: 400, error: /requires answers/ });
  const replies = [
    { id: 'comment-1', status: 'answered', answer: 'Here is why.', action: 'No document changes.' },
    { id: 'edit-1', status: 'applied', answer: 'That was a typo.', action: 'Corrected the typo in the reviewed paragraph.' },
  ];
  await writeFile(review.file, `${SOURCE}\nCorrected.\n`);
  const ack = { id: feedback.id, status: 'completed', replies };
  await review.api('/api/ack', { body: ack });
  await review.api('/api/ack', { body: ack });
  await review.api('/api/ack', { body: { ...ack, replies: replies.map(reply => ({ ...reply, answer: 'Different answer.' })) }, status: 409 });
  const state = await review.api('/api/state');
  assert.notEqual(state.hash, feedback.hash);
  assert.deepEqual(state.reviewedBatches, [{ id: feedback.id, hash: feedback.hash, status: 'completed', comments: feedback.comments, replies }]);
  const next = review.feedback('next', state.hash);
  next.comments[0].kind = 'question';
  await review.api('/api/feedback', { body: next });
  const failure = [{ id: 'comment-1', status: 'failed', answer: 'The source anchor is ambiguous.', action: 'No document changes; reselect the passage.' }];
  await review.api('/api/ack', { body: { id: next.id, status: 'failed', replies: failure } });
  assert.equal((await review.api('/api/state')).reviewedBatches.length, 2);
});

test('structured acknowledgments reject incomplete, invalid, and contradictory replies without resolving feedback', async t => {
  const review = await fixture(t);
  const feedback = review.feedback();
  feedback.comments[0].kind = 'question';
  feedback.comments.push({ ...feedback.comments[0], id: 'question-2' });
  await review.api('/api/feedback', { body: feedback });
  const valid = feedback.comments.map(comment => ({ id: comment.id, status: 'answered', answer: 'An answer.', action: 'No document changes.' }));
  for (const replies of [
    null, [], valid.slice(0, 1), [valid[0], valid[0]],
    valid.map(reply => ({ ...reply, id: 'unknown' })),
    valid.map(reply => ({ ...reply, answer: '' })),
    valid.map(reply => ({ ...reply, action: '' })),
    valid.map(reply => ({ ...reply, status: 'pending' })),
    valid.map(reply => ({ ...reply, answer: 'x'.repeat(8001) })),
    valid.map(reply => ({ ...reply, action: 'x'.repeat(2001) })),
    valid.map(reply => ({ ...reply, status: 'failed' })),
  ]) {
    await review.api('/api/ack', { body: { id: feedback.id, status: 'completed', replies }, status: 400 });
  }
  await review.api('/api/ack', { body: { id: feedback.id, status: 'failed', replies: valid }, status: 400 });
  await review.api('/api/ack', { body: { id: feedback.id, status: 'failed', message: 'Failure without per-comment explanation.' }, status: 400 });
  assert.equal((await review.api('/api/state')).latestBatch.status, 'pending');
});

test('CLI reply files acknowledge question-only feedback without changing the source', async t => {
  const review = await fixture(t);
  const feedback = review.feedback();
  feedback.comments[0].kind = 'question';
  await review.api('/api/feedback', { body: feedback });
  const path = join(review.directory, 'replies.json');
  await writeFile(path, '{invalid');
  const args = ['ack', '--session', review.sessionFile, '--id', feedback.id, '--status', 'completed', '--replies', path];
  await assert.rejects(main(args), /Invalid reply-file JSON/);
  const replies = [{ id: 'comment-1', status: 'answered', answer: 'The wording describes a local-only preview.', action: 'No document changes.' }];
  await writeFile(path, JSON.stringify(replies));
  assert.deepEqual(await main(args), { id: feedback.id, status: 'completed' });
  assert.equal(await readFile(review.file, 'utf8'), SOURCE);
  assert.deepEqual((await review.api('/api/state')).reviewedBatches[0].replies, replies);
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
    assert.match(response.headers.get('content-security-policy'), /img-src blob:;/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const body = await response.text();
    assert.ok(body.length > 0);
    assert.ok(!body.includes(review.token));
    if (path === '/') {
      assert.match(body, /<meta http-equiv="Content-Security-Policy"[^>]*img-src blob:;/);
      assert.doesNotMatch(body, /img-src 'none'/);
    }
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

test('foreign and opaque Origins are rejected; loopback Origins are accepted', async t => {
  const review = await fixture(t);
  const port = new URL(review.origin).port;
  for (const origin of ['https://example.invalid', 'null']) {
    await review.api('/api/state', { headers: { Origin: origin }, status: 403, error: /origin/ });
    await review.api('/review.js', { headers: { Origin: origin }, status: 403, error: /origin/ });
  }
  // Loopback origins on the bound port (127.0.0.1 and localhost) are allowed.
  for (const origin of [review.origin, `http://localhost:${port}`]) {
    await review.api('/api/state', { headers: { Origin: origin }, status: 200 });
  }
  assert.equal((await review.api('/api/state')).hash, sha256(SOURCE));
});

test('Host validation rejects DNS-rebinding hosts but accepts loopback hostnames', async t => {
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
  for (const host of ['example.invalid', '127.0.0.1:1']) {
    for (const path of ['/api/state', '/']) {
      const response = await requestWithHost(path, host);
      assert.equal(response.status, 403);
      assert.match(JSON.parse(response.text).error, /host/);
    }
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    for (const path of ['/api/state', '/']) {
      const response = await requestWithHost(path, host);
      assert.equal(response.status, 200);
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
  ['invalid comment kind', value => { value.comments[0].kind = 'run-command'; }],
  ['null comment kind', value => { value.comments[0].kind = null; }],
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
