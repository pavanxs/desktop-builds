'use strict';
// Public, dependency-free native smoke test. Never imports private app source.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const assert = require('node:assert/strict');
const exec = promisify(execFile);
const VERSION = '0.1.0-beta.3';
const INSTALLER_URL = 'https://raw.githubusercontent.com/pavanxs/design-editor-downloads/main/install.sh';
const INSTALLER_SHA = 'a1c5aa6c7e3bf07161d443d2fb8ea36488eef646fc4c0f214d2ef517f66d1565';
const ARCHIVES = Object.freeze({
  x64: { sha256: 'e5391f6469fd3cc2352d982a222568d256f4b8ae943735393a47fb4fedeeacbc', bytes: 192175992 },
  arm64: { sha256: 'd7ec5d845e55ac34d6a13ee50aaced21a3bda9789f37ff2c52b1a8c8bb015153', bytes: 187169786 },
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function guard(env = process.env, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || !Object.hasOwn(ARCHIVES, arch) ||
      env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      env.GITHUB_REPOSITORY !== 'pavanxs/desktop-builds' || env.GITHUB_ACTOR !== 'pavanxs' ||
      env.GITHUB_TRIGGERING_ACTOR !== 'pavanxs' || env.GITHUB_REF !== 'refs/heads/main' ||
      env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.DE_SCREENSHOT_ARCH !== arch ||
      env.DE_SCREENSHOT_VERSION !== VERSION || !env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) {
    throw new Error('Requires the owner-approved native hosted Mac test and reviewed version.');
  }
}
async function until(check, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(150); }
  throw new Error('Test readiness deadline exceeded.');
}
function pngSize(bytes) {
  assert.ok(bytes.length > 32);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.subarray(12, 16).toString(), 'IHDR');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.ok(width >= 100 && height >= 100 && width <= 20000 && height <= 20000);
  return { width, height };
}
async function connect(port) {
  assert.match(String(port), /^\d{1,5}$/);
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  const targets = await response.json();
  const target = targets.find(item => item.type === 'page' && item.url.startsWith('file:') && item.url.includes('/main_window/'));
  assert.ok(target);
  const url = new URL(target.webSocketDebuggerUrl);
  assert.equal(url.hostname, '127.0.0.1');
  const socket = new WebSocket(url.href), pending = new Map();
  let sequence = 0, exceptions = 0;
  await Promise.race([
    new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }),
    delay(5000).then(() => { if (socket.readyState !== 1) { socket.close(); throw new Error('Debugger connection deadline exceeded.'); } }),
  ]);
  socket.addEventListener('message', event => {
    const item = JSON.parse(String(event.data));
    if (item.method === 'Runtime.exceptionThrown') exceptions++;
    const call = pending.get(item.id);
    if (call) { pending.delete(item.id); clearTimeout(call.timer); item.error ? call.reject(new Error('Native debugger request failed.')) : call.resolve(item.result); }
  });
  socket.addEventListener('close', () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Native window closed.')); } pending.clear(); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native debugger deadline exceeded.')); }, 12000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw new Error('Native page inspection failed.');
    return value.result.value;
  };
  const click = selector => evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)throw Error('Control unavailable');b.click()})()`);
  const clickText = text => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&b.getClientRects().length);if(!b||b.disabled)throw Error('Control unavailable');b.click()})()`);
  return { send, evaluate, click, clickText, targetId: target.id, exceptions: () => exceptions, close: () => socket.close() };
}
async function main() {
  guard();
  const output = path.join(process.env.RUNNER_TEMP, 'de-mac-visual-evidence');
  await fs.mkdir(output, { recursive: true });
  const work = await fs.realpath(await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, 'de-mac-download-')));
  await fs.writeFile(path.join(work, '.owned-mac-screenshot-test'), 'public-download-only', { flag: 'wx' });
  const home = path.join(work, 'empty-home'), project = path.join(work, 'Example project');
  await fs.mkdir(home); await fs.mkdir(project);
  const env = { HOME: home, USERPROFILE: home, TMPDIR: work, TMP: work, TEMP: work,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CACHE_HOME: path.join(home, 'cache'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8' };
  const report = { startedAt: new Date().toISOString(), version: VERSION, platform: process.platform, arch: process.arch,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, testCommit: process.env.GITHUB_SHA,
    passed: false, stage: 'environment', checks: [], screenshots: [], modelCalled: false, privateSourceRead: false,
    limitations: 'Cloud macOS app/download proof using a small source-only sample project; not a live model, real page-runtime or universal Gatekeeper certification.' };
  let child, c, normalPid, executable, bundle, backendOrigin, rawLog = '';
  const execOwn = (cmd, args, options = {}) => exec(cmd, args, { cwd: work, env, timeout: 30000, maxBuffer: 65536, ...options });
  async function pids() {
    const { stdout } = await execOwn('/bin/ps', ['-axww', '-o', 'pid=,comm=']);
    return stdout.split('\n').flatMap(line => { const match = /^\s*(\d+)\s+(.+)$/.exec(line); return match && match[2] === executable ? [Number(match[1])] : []; });
  }
  async function stopPid(pid) {
    if (!pid || !(await pids()).includes(pid)) return;
    process.kill(pid, 'SIGTERM');
    await until(async () => !(await pids()).includes(pid), 15000);
  }
  async function capture(name, method) {
    const file = path.join(output, name + '.png');
    if (method === 'macOS desktop') await execOwn('/usr/sbin/screencapture', ['-x', file], { timeout: 15000 });
    else { const image = await c.send('Page.captureScreenshot', { format: 'png', fromSurface: true }); await fs.writeFile(file, Buffer.from(image.data, 'base64')); }
    const bytes = await fs.readFile(file);
    report.screenshots.push({ file: name + '.png', method, ...pngSize(bytes), bytes: bytes.length, sha256: digest(bytes) });
  }
  async function desktopShot(name) {
    // An ordinary activation request. Never changes Screen Recording permissions.
    try { await execOwn('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(bundle)} to activate`], { timeout: 10000 }); }
    catch { report.activationRequestFailed = true; }
    await delay(1500);
    try { await capture(name, 'macOS desktop'); }
    catch { report.desktopCaptureUnavailable = true; }
  }
  try {
    report.macOS = (await execOwn('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim();
    report.kernelArchitecture = (await execOwn('/usr/bin/uname', ['-m'])).stdout.trim();
    assert.equal(report.kernelArchitecture, process.arch === 'x64' ? 'x86_64' : 'arm64');
    report.stage = 'download installer';
    const response = await fetch(INSTALLER_URL, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200);
    let length = 0; const chunks = [];
    for await (const chunk of response.body) { length += chunk.length; assert.ok(length <= 524288); chunks.push(Buffer.from(chunk)); }
    const bytes = Buffer.concat(chunks); assert.equal(digest(bytes), INSTALLER_SHA);
    const installer = path.join(work, 'install.sh'); await fs.writeFile(installer, bytes, { flag: 'wx', mode: 0o600 });
    report.installerSha256 = INSTALLER_SHA;
    report.stage = 'run public installer';
    await execOwn('/bin/bash', [installer], { timeout: 600000, maxBuffer: 262144 });
    const installRoot = path.join(home, 'Library/Application Support/DesignEditorBeta');
    const current = JSON.parse(await fs.readFile(path.join(installRoot, 'current.json'), 'utf8'));
    assert.equal(current.version, VERSION); assert.equal(current.platform, 'darwin'); assert.equal(current.arch, process.arch);
    assert.equal(current.directory, `versions/${VERSION}-darwin-${process.arch}`);
    assert.equal(current.archiveSha256, ARCHIVES[process.arch].sha256);
    assert.match(current.executable, /^app\/[A-Za-z][A-Za-z0-9 _-]*\.app\/Contents\/MacOS\/[A-Za-z][A-Za-z0-9 _-]*$/);
    const directory = path.join(installRoot, current.directory);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'design-editor-build.json'), 'utf8'));
    assert.equal(manifest.executable, current.executable); assert.equal(manifest.asar, current.asar);
    const asarEntry = manifest.files.find(file => file.path === current.asar);
    assert.ok(asarEntry && asarEntry.type === 'file');
    const asarFile = path.join(directory, current.asar);
    const asarHash = digest(await fs.readFile(asarFile)); assert.equal(asarHash, asarEntry.sha256);
    report.archiveSha256 = current.archiveSha256; report.asarSha256 = asarHash;
    const command = path.join(installRoot, 'bin/design-editor');
    const registration = await execOwn('/bin/zsh', ['-c', 'source "$HOME/.zprofile"; command -v design-editor; design-editor --version']);
    assert.deepEqual(registration.stdout.trim().split(/\r?\n/), [command, VERSION]);
    report.checks.push('Exact public installer downloaded, verified and run; architecture, installed archive identity, app hash and terminal command verified');
    const sourceFiles = {
      'package.json': '{"name":"mac-download-example","dependencies":{"next":"scanner-only"}}\n',
      'src/app/page.tsx': 'export default function Home(){return <main>Home source sample</main>}\n',
      'src/app/settings/page.tsx': 'export default function Settings(){return <main>Settings source sample</main>}\n',
      'src/app/library/page.tsx': 'export default function Library(){return <main>Library source sample</main>}\n',
    };
    for (const [file, text] of Object.entries(sourceFiles)) { await fs.mkdir(path.dirname(path.join(project, file)), { recursive: true }); await fs.writeFile(path.join(project, file), text, { flag: 'wx' }); }
    executable = path.join(directory, current.executable);
    bundle = executable.slice(0, executable.indexOf('.app/Contents/MacOS/') + 4);
    report.stage = 'normal command launch';
    await execOwn('/bin/bash', [command, project], { timeout: 300000 });
    normalPid = await until(async () => (await pids())[0]);
    await desktopShot('mac-desktop-normal-launch');
    await stopPid(normalPid); normalPid = null;
    report.checks.push('The installed design-editor command starts the downloaded native Mac executable');
    report.stage = 'native window inspection';
    const profile = path.join(installRoot, 'user-data');
    child = spawn(executable, [`--design-editor-project=${project}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], {
      cwd: work, env: { ...env, DESIGN_EDITOR_CLI_LAUNCH: '1', DESIGN_EDITOR_CLI_USER_DATA: profile }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { rawLog = (rawLog + data).slice(-65536); });
    const port = await until(() => { if (spawnError || child.exitCode !== null) throw new Error('Native process failed to start.'); return rawLog.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]; }, 45000);
    c = await until(async () => { try { return await connect(port); } catch { return null; } });
    await c.send('Runtime.enable'); await c.send('Page.enable'); await c.send('Page.bringToFront');
    await until(() => c.evaluate('document.querySelectorAll(".screen-frame").length===3'));
    const display = await c.evaluate('({width:screen.availWidth,height:screen.availHeight,left:screen.availLeft,top:screen.availTop})');
    try { const win = await c.send('Browser.getWindowForTarget', { targetId: c.targetId }); await c.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { width: Math.min(1280, display.width), height: Math.min(850, display.height), left: display.left || 0, top: display.top || 0, windowState: 'normal' } }); }
    catch { report.nativeWindowResizeUnavailable = true; }
    await delay(500);
    const updates = await c.evaluate('window.updates.status().then(s=>({version:s.currentVersion,phase:s.phase,interval:s.intervalMinutes}))');
    assert.equal(updates.version, VERSION); assert.equal(updates.interval, 30); assert.notEqual(updates.phase, 'unavailable');
    report.updateStatus = updates;
    assert.equal(await c.evaluate('typeof require'), 'undefined');
    await capture('editor-pages', 'native app renderer');
    report.stage = 'page selection';
    await c.evaluate(`(()=>{const b=[...document.querySelectorAll('[role="treeitem"]')].find(b=>b.querySelector('.tree-label')?.textContent==='Settings');if(!b)throw Error('Settings missing');b.click()})()`);
    await until(() => c.evaluate('document.querySelector(".screen-frame.is-selected .frame-title")?.textContent.includes("Settings")'));
    report.checks.push('Downloaded renderer displays three discovered pages; selecting Settings works; installed version and 30-minute updater are recognized');
    await capture('editor-settings', 'native app renderer');
    report.stage = 'agent sidebar';
    await c.click('[aria-label="Workspace layout"]'); await c.click('[data-layout-option="agent-right"]');
    await c.clickText('Connect agents');
    await until(() => c.evaluate('document.querySelector(".agent-status")?.textContent.includes("Connected")'), 60000);
    backendOrigin = await c.evaluate('window.agent.connect().then(b=>b.origin)');
    const agentSettings = JSON.parse(await fs.readFile(path.join(profile, 'agents/userdata/settings.json'), 'utf8'));
    assert.ok(Object.values(agentSettings.providers).every(provider => !provider.enabled));
    assert.equal(await c.evaluate('document.querySelector("[aria-label=\\"Send to agent\\"]").disabled'), true);
    await capture('editor-agent', 'native app renderer');
    await desktopShot('mac-desktop-agent');
    report.checks.push('Real bundled T3 backend connects in the native sidebar; every provider remains disabled and no model is called');
    report.stage = 'cleanup checks';
    await c.clickText('Disconnect agents');
    await until(() => c.evaluate('document.querySelector(".agent-status")?.textContent.includes("Not connected")'));
    await until(async () => { try { await fetch(backendOrigin + '/.well-known/t3/environment', { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; } });
    backendOrigin = null;
    assert.equal(c.exceptions(), 0);
    for (const [file, text] of Object.entries(sourceFiles)) assert.equal(await fs.readFile(path.join(project, file), 'utf8'), text);
    assert.equal(digest(await fs.readFile(asarFile)), asarHash);
    assert.equal(digest(await fs.readFile(installer)), INSTALLER_SHA);
    report.checks.push('No renderer exceptions; sample source, installed app and public installer bytes unchanged; owned backend disconnects');
    report.rendererPassed = true;
    report.passed = report.screenshots.some(image => image.method === 'macOS desktop') && report.screenshots.filter(image => image.method === 'native app renderer').length === 3;
    if (!report.passed) process.exitCode = 1;
    report.stage = 'complete';
  } catch {
    report.error = 'Native download/window check failed at the recorded stage; no raw private logs are uploaded.';
    process.exitCode = 1;
    if (c) await capture('editor-failure', 'native app renderer').catch(() => {});
  } finally {
    if (c) { await c.evaluate('window.agent?.disconnect()').catch(() => {}); c.close(); }
    try {
      if (normalPid) await stopPid(normalPid);
      if (child?.pid && child.exitCode === null) await stopPid(child.pid);
      if (executable) assert.equal((await pids()).length, 0);
      if (backendOrigin) await until(async () => { try { await fetch(backendOrigin + '/.well-known/t3/environment', { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; } });
      assert.equal(await fs.readFile(path.join(work, '.owned-mac-screenshot-test'), 'utf8'), 'public-download-only');
      await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      report.cleaned = true;
    } catch { report.cleaned = false; report.passed = false; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Mac visual test ${report.passed ? 'passed' : 'failed'}: ${process.arch}, stage ${report.stage}, ${report.screenshots.length} screenshots.`);
  }
}
module.exports = { guard, pngSize, VERSION, INSTALLER_SHA, ARCHIVES };
if (require.main === module) main().catch(() => { console.error('Mac visual test could not start.'); process.exitCode = 1; });
