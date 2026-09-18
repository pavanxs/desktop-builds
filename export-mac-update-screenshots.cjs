'use strict';
// Do not export private test reports, logs, paths, databases or source. Read only
// reviewed fixture screenshots, and construct a new, small public result.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const SOURCE = '0e0ff94459629736e1f8be20e98156b6f804ac4d';
const FROM = '0.1.0-beta.2', TO = '0.1.0-beta.3';
const IMAGES = Object.freeze(['hosted-before.png', 'hosted-ready.png', 'hosted-after.png']);
const SOURCE_HASHES = Object.freeze({
  'tests/hosted-update-smoke.cjs': '7523b5e85399bedf7ba8c543d37263ac65fc22a967b7e6fe9e0f0a9a9a229b64',
  'tests/hosted-bootstrap-smoke.cjs': 'c9dccdd5fa7adc1624d32e5732322aedc4b3f75ffa72205e981985cf7c926b66',
  'tests/helpers/cdp.cjs': '2280f5659c5fe1d136bf2bc61e8812921984c00385315a89c6e12689ec635ed9',
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function guard(env = process.env, platform = process.platform, arch = process.arch) {
  assert.equal(platform, 'darwin'); assert.ok(['arm64', 'x64'].includes(arch));
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: 'pavanxs/desktop-builds', GITHUB_ACTOR: 'pavanxs', GITHUB_TRIGGERING_ACTOR: 'pavanxs',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', DE_SOURCE_REPOSITORY: 'pavanxs/design-editor',
    DE_SOURCE_COMMIT: SOURCE, DE_PREVIOUS_VERSION: FROM, DE_RELEASE_VERSION: TO, DE_BUILD_PLATFORM: 'darwin', DE_BUILD_ARCH: arch })) {
    assert.equal(env[key], value);
  }
  assert.match(env.GITHUB_RUN_ID || '', /^\d+$/); assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  for (const key of ['RUNNER_TEMP', 'GITHUB_WORKSPACE']) assert.ok(typeof env[key] === 'string' && path.isAbsolute(env[key]));
}
async function readBounded(file, maxBytes) {
  const info = await fs.lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= maxBytes);
  const bytes = await fs.readFile(file); assert.equal(bytes.length, info.size);
  return bytes;
}
function imageInfo(bytes) {
  assert.ok(bytes.length > 32 && bytes.length <= 10 * 1024 * 1024);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.subarray(12, 16).toString(), 'IHDR');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.ok(width >= 900 && height >= 500 && width <= 8192 && height <= 8192);
  return { width, height, bytes: bytes.length, sha256: digest(bytes) };
}
function summarize(update, bootstrap, arch) {
  assert.equal(update.passed, true); assert.equal(update.cleaned, true);
  assert.equal(update.platform, 'darwin'); assert.equal(update.arch, arch);
  assert.equal(update.fromVersion, FROM); assert.equal(update.toVersion, TO);
  assert.equal(update.before.version, FROM); assert.equal(update.after.version, TO);
  for (const value of [update.before.asarSha256, update.after.asarSha256]) assert.match(value, /^[a-f0-9]{64}$/);
  assert.notEqual(update.before.asarSha256, update.after.asarSha256);
  assert.ok(Array.isArray(update.checks) && update.checks.length === 5);
  assert.equal(bootstrap.passed, true); assert.equal(bootstrap.cleaned, true);
  assert.equal(bootstrap.version, TO); assert.equal(bootstrap.platform, 'darwin'); assert.equal(bootstrap.arch, arch);
  for (const key of ['profileRegistration', 'registeredCommand', 'repeatInstallation', 'nativeLaunch']) assert.equal(bootstrap[key], true);
  assert.equal(bootstrap.asarSha256, update.after.asarSha256);
  return {
    fromVersion: FROM, toVersion: TO,
    beforeAsarSha256: update.before.asarSha256, afterAsarSha256: update.after.asarSha256,
    hostedUpdate: true, guardedRestart: true, sameProjectAndProfile: true,
    terminalUpdate: true, publicBootstrap: true, nativeLaunch: true, cleaned: true,
    updateCheckGroups: 5,
  };
}
async function collect() {
  guard();
  const temporary = await fs.realpath(process.env.RUNNER_TEMP);
  const workspace = await fs.realpath(process.env.GITHUB_WORKSPACE);
  const output = path.join(temporary, 'de-mac-update-visual-evidence');
  await fs.mkdir(output, { recursive: false });
  const report = { passed: false, runId: process.env.GITHUB_RUN_ID, testCommit: process.env.GITHUB_SHA,
    sourceCommit: SOURCE, platform: process.platform, arch: process.arch, screenshots: [],
    method: 'Screenshots captured from the real native Mac app during a hosted beta.2-to-beta.3 update',
    modelCalled: false, applicationRebuilt: false, privateSourceUploaded: false,
    limitations: 'A manually requested update and real restart, not a 30-minute wall-clock wait, live model test or substantive data migration.' };
  let stage = 'test result';
  try {
    assert.equal(process.env.DE_ACCEPTANCE_OUTCOME, 'success');
    stage = 'reviewed test source';
    const source = path.join(workspace, 'source');
    for (const [name, hash] of Object.entries(SOURCE_HASHES)) assert.equal(digest(await readBounded(path.join(source, name), 100000)), hash);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', timeout: 5000 }).trim();
    assert.equal(commit, SOURCE);
    stage = 'update evidence';
    const privateWork = path.join(temporary, 'design-editor-private-build');
    const evidence = path.join(privateWork, 'hosted-update');
    const update = JSON.parse(await readBounded(path.join(evidence, 'hosted-update-result.json'), 65536));
    const bootstrap = JSON.parse(await readBounded(path.join(privateWork, 'public-bootstrap/bootstrap-result.json'), 65536));
    Object.assign(report, summarize(update, bootstrap, process.arch));
    const macOS = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 5000 }).trim();
    assert.match(macOS, /^\d+\.\d+(\.\d+)?$/); report.macOS = macOS;
    stage = 'screenshots';
    // Validate the complete image set before publishing any of it.
    const images = await Promise.all(IMAGES.map(async name => {
      const bytes = await readBounded(path.join(evidence, name), 10 * 1024 * 1024);
      return { name, bytes, info: imageInfo(bytes) };
    }));
    for (const image of images) {
      await fs.writeFile(path.join(output, image.name), image.bytes, { flag: 'wx' });
      report.screenshots.push({ file: image.name, ...image.info });
    }
    report.passed = true;
  } catch {
    report.failedStage = stage; process.exitCode = 1;
    // Never copy error messages or arbitrary test fields into public output.
  } finally {
    report.recordedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(report.passed ? 'Verified Mac update screenshots retained.' : 'Mac update screenshot export failed at a recorded fixed stage.');
  }
}
module.exports = { guard, readBounded, imageInfo, summarize, SOURCE, FROM, TO, IMAGES };
if (require.main === module) {
  Promise.resolve().then(() => {
    if (process.argv.length !== 3) throw new Error('Select validate or collect.');
    if (process.argv[2] === 'validate') { guard(); console.log('Fixed Mac upgrade screenshot scope verified.'); }
    else if (process.argv[2] === 'collect') return collect();
    else throw new Error('Select validate or collect.');
  }).catch(() => { console.error('Mac upgrade screenshot operation could not start.'); process.exitCode = 1; });
}
