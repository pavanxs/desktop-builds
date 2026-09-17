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

function run(command, args, { cwd, log, env = process.env, label, timeout = 20 * 60000 }) {
  console.log('Starting: ' + label);
  const fd = fs.openSync(log, 'a');
  try {
    const result = spawnSync(command, args, { cwd, env, stdio: ['ignore', fd, fd], shell: false, windowsHide: true, timeout });
    if (result.status !== 0) {
      console.error('Failed: ' + label);
      throw new Error(`${label} failed. Raw output was kept only in the temporary private workspace, not uploaded.`);
    }
    console.log('Passed: ' + label);
  } finally { fs.closeSync(fd); }
}

function build(env = process.env) {
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
  // Change only the disposable checkout. Distinct releases must carry distinct
  // application metadata inside ASAR, not merely renamed copies of one archive.
  const applicationFile = path.join(dirs.source, 'apps/desktop/package.json');
  const application = JSON.parse(fs.readFileSync(applicationFile, 'utf8'));
  application.version = chosen.version;
  fs.writeFileSync(applicationFile, JSON.stringify(application, null, 2) + '\n');
  console.log('The disposable build checkout has the requested release version.');
  // The normal package command prepares generated integrations/tooling before
  // validation; failed checks still prevent any candidate upload.
  pnpmRun(['package'], 'Native packaging');
  pnpmRun(['typecheck'], 'Type checking'); pnpmRun(['lint'], 'Desktop lint');
  const tests = fs.readdirSync(path.join(dirs.source, 'packages/launcher/test')).filter(name => name.endsWith('.test.cjs')).map(name => 'packages/launcher/test/' + name);
  tests.push('tests/desktop-updates.test.cjs', 'tests/desktop-update-service.test.cjs', 'tests/desktop-update-windows.test.cjs', 'tests/desktop-update-mac.test.cjs', 'tests/window-close.test.cjs');
  run(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: dirs.source, log, env: buildEnv, label: 'Release regression tests' });
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
    const action = process.argv[2]; if (process.argv.length !== 3 || !['validate','build','draft','cleanup'].includes(action)) throw new Error('Choose validate, build, draft or cleanup.');
    ({ validate, build, draft, cleanup })[action]();
  } catch {
    // JSON/filesystem exceptions can echo private file contents or paths too.
    console.error('Native candidate operation failed. Private source/logs were not published; inspect the reviewed inputs or reproduce locally.');
    process.exitCode = 1;
  }
}
module.exports = { validate, locations };
