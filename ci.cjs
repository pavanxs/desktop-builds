'use strict';
// Public build orchestration. Only fixed, reviewed commands; never interpolate
// dispatch input into a shell or echo captured private build/test output.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const REPOSITORY = 'pavanxs/desktop-builds';
const TARGETS = new Set(['win32-x64', 'darwin-x64', 'darwin-arm64']);

function validate(env = process.env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_ACTOR !== 'pavanxs' || env.GITHUB_TRIGGERING_ACTOR !== 'pavanxs' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Only an owner-approved manual run on main is allowed.');
  if (!/^[a-f0-9]{40}$/.test(env.DE_SOURCE_COMMIT || '') || env.DE_SOURCE_COMMIT.length !== 40) throw new Error('Use one exact source commit.');
  if (env.DE_SOURCE_REPOSITORY !== 'pavanxs/design-editor') throw new Error('The approved private source repository is not configured.');
  const version = env.DE_RELEASE_VERSION || '';
  if (version.length > 80 || version.trim() !== version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/.test(version)) throw new Error('Use an exact numbered beta version.');
  if (!TARGETS.has(`${env.DE_BUILD_PLATFORM}-${env.DE_BUILD_ARCH}`)) throw new Error('This native target is not configured.');
  return { version, target: `${env.DE_BUILD_PLATFORM}-${env.DE_BUILD_ARCH}` };
}

function locations(env = process.env) {
  if (!env.GITHUB_WORKSPACE || !env.RUNNER_TEMP || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.GITHUB_REPOSITORY !== REPOSITORY) throw new Error('A hosted builder-run workspace is required.');
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  return { workspace, source: path.join(workspace, 'source'), output: path.join(workspace, 'release-output'), privateWork: path.join(path.resolve(env.RUNNER_TEMP), 'design-editor-private-build') };
}

function diagnosticCategories(text) {
  // Return fixed categories, never private paths, source text or raw exceptions.
  return [
    ['windows-path-length', /Filename too long|ENAMETOOLONG/i],
    ['missing-path', /\bENOENT\b/],
    ['disk-space', /\bENOSPC\b/],
    ['permission', /\b(?:EACCES|EPERM)\b/],
    ['package-lock-mismatch', /ERR_PNPM_(?:OUTDATED_LOCKFILE|FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE|LOCKFILE_CONFIG_MISMATCH)/],
    ['package-resolution', /ERR_PNPM_(?:NO_MATCHING_VERSION|FETCH_404|FETCH_403|FETCH_401)/],
    ['missing-dependency', /Cannot find module|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED/],
    ['type-check', /error TS\d+|TS\d+:|TypeScript.*(?:failed|error)/i],
    ['toolchain-pin-mismatch', /does not match the selected versions|do not match the selected versions|integrity check failed/],
    ['connection', /ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/],
    ['offline-package-missing', /ERR_PNPM_NO_OFFLINE_(?:TARBALL|META)/],
    ['preview-linked-files', /Portable preview staging must not contain links/],
    ['test-assertion', /ERR_ASSERTION|AssertionError/],
    ['test-timeout', /testTimeoutFailure|test timed out|Test timed out/],
  ].filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function testStages(text) {
  const allowed = new Set(['fixture-ready', 'first-start', 'first-spawned', 'first-stdout', 'first-stderr', 'first-exit', 'first-close', 'installed', 'restart-verified', 'second-start', 'second-spawned', 'second-stdout', 'second-stderr', 'second-exit', 'second-close', 'recovery-verified', 'helper-enter', 'helper-imported', 'module-enter', 'module-ready', 'before-compression', 'after-compression', 'before-http', 'after-http', 'channel-read', 'archive-copy']);
  return [...text.matchAll(/^# DE_UPDATE_TEST_STAGE=([a-z-]+)\r?$/gm)].map(match => match[1]).filter(stage => allowed.has(stage)).slice(0, 32);
}

function run(command, args, { cwd, log, env = process.env, label, timeout = 20 * 60000 }) {
  console.log('Starting: ' + label);
  const fd = fs.openSync(log, 'a');
  const startSize = fs.fstatSync(fd).size;
  try {
    const result = spawnSync(command, args, { cwd, env, stdio: ['ignore', fd, fd], shell: false, windowsHide: true, timeout });
    if (result.status !== 0) {
      console.error('Failed: ' + label);
      const size = fs.fstatSync(fd).size, input = fs.openSync(log, 'r');
      try {
        const bytes = Buffer.alloc(Math.min(size - startSize, 262144));
        fs.readSync(input, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
        const text = bytes.toString('utf8');
        console.error('Diagnostic categories: ' + (diagnosticCategories(text).join(', ') || 'unclassified'));
        // Test numbers locate a failure in the private checkout without exposing
        // its test names, paths, assertions or exception values to public logs.
        const failedChecks = [...text.matchAll(/^not ok ([0-9]{1,4}) - /gm)].slice(0, 50).map(match => match[1]);
        if (failedChecks.length) console.error('Failed check numbers: ' + failedChecks.join(', '));
        const stages = testStages(text);
        if (stages.length) console.error('Observed helper stages: ' + stages.join(', '));
      } finally { fs.closeSync(input); }
      throw new Error(`${label} failed. Raw output was kept only in the temporary private workspace, not uploaded.`);
    }
    console.log('Passed: ' + label);
  } finally { fs.closeSync(fd); }
}

function prepareBuild(env) {
  const chosen = validate(env), dirs = locations(env);
  if (process.platform !== env.DE_BUILD_PLATFORM || process.arch !== env.DE_BUILD_ARCH) throw new Error('The runner does not match the requested native target.');
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dirs.source, encoding: 'utf8', timeout: 5000 });
  if (sha.status !== 0 || sha.stdout.trim() !== env.DE_SOURCE_COMMIT) throw new Error('Private checkout does not match the reviewed commit.');
  fs.mkdirSync(dirs.privateWork, { recursive: true, mode: 0o700 }); fs.mkdirSync(dirs.output, { recursive: true });
  const log = path.join(dirs.privateWork, 'raw-build.log'), buildEnv = { ...env };
  for (const key of Object.keys(buildEnv)) if (/TOKEN|SECRET|PASSWORD|SSH_KEY|SOURCE_READ_KEY|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE/i.test(key)) delete buildEnv[key];
  const npm = process.platform === 'win32' ? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
  if (!fs.existsSync(npm)) throw new Error('The pinned Node installation does not include the expected npm CLI.');
  const tools = path.join(dirs.privateWork, 'tools');
  run(process.execPath, [npm, 'install', '--prefix', tools, '--ignore-scripts', '--no-audit', '--no-fund', 'pnpm@10.28.1'], { cwd: dirs.privateWork, log, env: buildEnv, label: 'Build-tool preparation' });
  const pnpm = path.join(tools, 'node_modules/pnpm/bin/pnpm.cjs');
  const pnpmRun = (args, label) => run(process.execPath, [pnpm, ...args], { cwd: dirs.source, log, env: buildEnv, label });
  // Root scripts may invoke pnpm recursively. The shim directory belongs only to
  // this disposable build machine, never a designer's global tools.
  const oldPathKey = Object.keys(buildEnv).find(key => key.toLowerCase() === 'path') || 'PATH';
  buildEnv[oldPathKey] = path.join(tools, 'node_modules/.bin') + path.delimiter + (buildEnv[oldPathKey] || '');
  pnpmRun(['install', '--frozen-lockfile'], 'Dependency installation');
  return { chosen, dirs, log, buildEnv, pnpmRun };
}

function build(env = process.env) {
  const { chosen, dirs, log, buildEnv, pnpmRun } = prepareBuild(env);
  // Change only the disposable checkout. Distinct releases must carry distinct
  // application metadata inside ASAR, not merely renamed copies of one archive.
  const applicationFile = path.join(dirs.source, 'apps/desktop/package.json');
  const application = JSON.parse(fs.readFileSync(applicationFile, 'utf8'));
  application.version = chosen.version;
  fs.writeFileSync(applicationFile, JSON.stringify(application, null, 2) + '\n');
  console.log('The disposable build checkout has the requested release version.');
  // Preserve the root package stages but report each failing boundary separately.
  run(process.execPath, ['--input-type=module', '-e', "import {checkUpstream} from './scripts/build/t3-dependencies.mjs'; await checkUpstream({obtain:true});"], { cwd: dirs.source, log, env: buildEnv, label: 'Pinned upstream checkout' });
  run(process.execPath, ['scripts/build/t3-toolchain.mjs'], { cwd: dirs.source, log, env: buildEnv, label: 'Pinned agent toolchain' });
  run(process.execPath, ['scripts/build/t3-dependencies.mjs'], { cwd: dirs.source, log, env: buildEnv, label: 'Pinned agent dependencies' });
  run(process.execPath, ['scripts/build/t3-prepare.mjs'], { cwd: dirs.source, log, env: buildEnv, label: 'Agent bundle and validation' });
  pnpmRun(['preview:stage'], 'Component runtime staging');
  pnpmRun(['--filter', 'desktop', 'package'], 'Native packaging');
  pnpmRun(['typecheck'], 'Type checking'); pnpmRun(['lint'], 'Desktop lint');
  const tests = fs.readdirSync(path.join(dirs.source, 'packages/launcher/test')).filter(name => name.endsWith('.test.cjs')).map(name => 'packages/launcher/test/' + name);
  tests.push('tests/desktop-updates.test.cjs', 'tests/desktop-update-service.test.cjs', 'tests/desktop-update-windows.test.cjs', 'tests/desktop-update-mac.test.cjs', 'tests/window-close.test.cjs');
  for (const [index, file] of tests.entries()) {
    run(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', file], { cwd: dirs.source, log, env: buildEnv, label: 'Release regression group ' + (index + 1) });
  }
  pnpmRun(['cli:stage'], 'Payload staging');
  const desktop = JSON.parse(fs.readFileSync(path.join(dirs.source, 'apps/desktop/package.json'), 'utf8'));
  const nativeDirectory = path.join(dirs.source, 'apps/desktop/out', `${desktop.productName || desktop.name}-${process.platform}-${process.arch}`);
  run(process.execPath, ['packages/launcher/release/check-release-version.cjs', nativeDirectory, chosen.version], { cwd: dirs.source, log, env: buildEnv, label: 'Compiled release-version check' });
  run(process.execPath, ['packages/launcher/release/pack-native.cjs', chosen.version, nativeDirectory, dirs.output], { cwd: dirs.source, log, env: buildEnv, label: 'Native archive inspection' });
  if (process.platform === 'darwin') {
    run(process.execPath, ['packages/launcher/release/check-mac-install.cjs', path.join(dirs.output, 'native-package-result.json'), dirs.privateWork], { cwd: dirs.source, log, env: buildEnv, label: 'Mac archive installation and launch checks', timeout: 180000 });
  } else {
    run(process.execPath, ['packages/launcher/release/check-native.cjs', nativeDirectory, dirs.privateWork], { cwd: dirs.source, log, env: buildEnv, label: 'Native launch smoke check', timeout: 90000 });
  }
  const report = JSON.parse(fs.readFileSync(path.join(dirs.output, 'native-package-result.json'), 'utf8'));
  const summary = { schemaVersion: 1, version: chosen.version, platform: process.platform, arch: process.arch, filename: report.artifact.filename, bytes: report.artifact.bytes, sha256: report.artifact.sha256, nativeLaunch: true };
  fs.writeFileSync(path.join(dirs.output, 'candidate.json'), JSON.stringify(summary, null, 2) + '\n');
  // Remove the private-path diagnostic report before any upload step.
  fs.unlinkSync(path.join(dirs.output, 'native-package-result.json'));
  console.log('Native candidate built and launch-checked. No customer release has been published.');
}

function validateHosted(env = process.env) {
  const chosen = validate(env), previous = env.DE_PREVIOUS_VERSION || '';
  if (previous.length > 80 || previous.trim() !== previous || previous === chosen.version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/.test(previous)) throw new Error('Choose distinct exact baseline and target beta versions.');
  return { ...chosen, previous };
}

function windowsCheck(env = process.env) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This check requires native Windows x64.');
  const { dirs, log, buildEnv } = prepareBuild(env);
  run(process.execPath, ['--test', '--test-reporter=tap', 'tests/desktop-update-windows.test.cjs'], {
    cwd: dirs.source, log, env: buildEnv, label: 'Windows installed helper regression', timeout: 180000,
  });
}

function hosted(env = process.env) {
  const chosen = validateHosted(env);
  const { dirs, log, buildEnv } = prepareBuild(env);
  const evidence = path.join(dirs.privateWork, 'hosted-update');
  run(process.execPath, ['tests/hosted-update-smoke.cjs', chosen.previous, chosen.version, evidence], {
    cwd: dirs.source, log, env: buildEnv, label: 'Real hosted installation and update acceptance', timeout: 20 * 60000,
  });
  const report = JSON.parse(fs.readFileSync(path.join(evidence, 'hosted-update-result.json'), 'utf8'));
  if (report.passed !== true || report.cleaned !== true || report.fromVersion !== chosen.previous || report.toVersion !== chosen.version ||
      report.platform !== process.platform || report.arch !== process.arch || report.before?.version !== chosen.previous || report.after?.version !== chosen.version ||
      !/^[a-f0-9]{64}$/.test(report.before?.asarSha256 || '') || !/^[a-f0-9]{64}$/.test(report.after?.asarSha256 || '') || report.before.asarSha256 === report.after.asarSha256) throw new Error('Hosted acceptance did not prove two different native versions.');
  console.log(`Hosted update passed: ${chosen.target} ${chosen.previous} -> ${chosen.version}. Test files and windows were cleaned up.`);
}

function draft(env = process.env) {
  const chosen = validate(env), dirs = locations(env);
  if (!env.GH_TOKEN || !/^\d+$/.test(env.GITHUB_RUN_ID || '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT || '')) throw new Error('Draft staging requires the current builder-run token and identity.');
  const summaryFile = path.join(dirs.output, 'candidate.json');
  const summaryStat = fs.lstatSync(summaryFile);
  if (!summaryStat.isFile() || summaryStat.isSymbolicLink() || summaryStat.size > 65536) throw new Error('Invalid candidate summary file.');
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  const keys = ['schemaVersion','version','platform','arch','filename','bytes','sha256','nativeLaunch'];
  if (Object.keys(summary).sort().join() !== [...keys].sort().join() || summary.schemaVersion !== 1 || summary.version !== chosen.version || summary.nativeLaunch !== true || `${summary.platform}-${summary.arch}` !== chosen.target) throw new Error('The build summary is not the expected public allowlist.');
  const filename = `design-editor-${chosen.version}-${chosen.target}.${summary.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  if (summary.filename !== filename || !Number.isSafeInteger(summary.bytes) || summary.bytes <= 0 || summary.bytes >= 2 ** 31 || !/^[a-f0-9]{64}$/.test(summary.sha256)) throw new Error('Invalid candidate archive metadata.');
  const artifact = path.join(dirs.output, filename); const stat = fs.lstatSync(artifact);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== summary.bytes) throw new Error('Candidate archive size/type changed.');
  const fd = fs.openSync(artifact, 'r'), digest = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count)); } finally { fs.closeSync(fd); }
  if (digest.digest('hex') !== summary.sha256) throw new Error('Candidate archive hash changed.');
  const tag = `candidate-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${chosen.target}`;
  const log = path.join(dirs.privateWork, 'draft-upload.log');
  run('gh', ['release', 'create', tag, '--repo', REPOSITORY, '--draft', '--title', `Candidate ${chosen.version} ${chosen.target}`, '--notes', 'Maintainer review only. Not a customer release or update-channel promotion.', artifact, summaryFile], { cwd: dirs.workspace, log, env, label: 'Draft staging', timeout: 10 * 60000 });
  console.log('Candidate stored as a draft in the builder repository. Customer downloads are unchanged.');
}

function cleanup(env = process.env) {
  const dirs = locations(env);
  // Fixed children of the fresh hosted workspace only, never paths from input.
  fs.rmSync(dirs.source, { recursive: true, force: true, maxRetries: 3 });
  fs.rmSync(dirs.privateWork, { recursive: true, force: true, maxRetries: 3 });
}

if (require.main === module) {
  try {
    const action = process.argv[2]; if (process.argv.length !== 3 || !['validate','validate-hosted','build','draft','hosted','windows-check','cleanup'].includes(action)) throw new Error('Choose a fixed native build or validation action.');
    ({ validate, 'validate-hosted': validateHosted, build, draft, hosted, 'windows-check': windowsCheck, cleanup })[action]();
  } catch {
    // JSON/filesystem exceptions can echo private file contents or paths too.
    console.error('Native candidate operation failed. Private source/logs were not published; inspect the reviewed inputs or reproduce locally.');
    process.exitCode = 1;
  }
}
module.exports = { validate, validateHosted, locations, diagnosticCategories, testStages };
