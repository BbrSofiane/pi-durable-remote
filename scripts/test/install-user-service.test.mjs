import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// Command doubles only exercise install admission/unit generation; ordinary tests never SSH or use auth.
async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'durable-deployment-test-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const app = join(home, 'pi-durable-remote');
  const bin = join(home, 'node-bin');
  await mkdir(join(app, 'scripts'), { recursive: true });
  await mkdir(bin);
  for (const name of ['install-user-service.sh', 'install-dependencies.sh']) {
    await copyFile(resolve('scripts', name), join(app, 'scripts', name));
  }
  const executable = (name, content) => writeFile(join(bin, name), '#!/bin/bash\nset -eu\n' + content, { mode: 0o700 });
  await executable('node', 'printf "%s\\n" "$*" >> "$HOME/node-commands"\ncat >/dev/null\n[[ ${AUTH_UNAVAILABLE:-0} != 1 ]]\n');
  await executable('npm', 'printf "%s\\n" "$*" >> "$HOME/npm-commands"\n');
  await executable('systemctl', 'printf "%s\\n" "$*" >> "$HOME/systemctl-commands"\ncase "$*" in *LoadState*) echo "${LOAD_STATE:-not-found}";; esac\n');
  await executable('loginctl', 'echo yes\n');
  await executable('ss', 'printf "%s\\n" "$*" >> "$HOME/ss-commands"\nif [[ ${PORT_PROBE_EXIT:-0} != 0 ]]; then exit "$PORT_PROBE_EXIT"; fi\nif [[ ${PORT_COLLISION:-0} == 1 ]]; then echo LISTEN; fi\n');
  const run = (name = 'install-user-service.sh', env = {}) => spawnSync('/bin/bash', [join(app, 'scripts', name), bin, ...(name === 'install-user-service.sh' ? ['test-provider', 'test-model'] : [])], { env: { ...process.env, HOME: home, ...env }, encoding: 'utf8', timeout: 5000 });
  return { home, app, bin, run, unit: join(home, '.config/systemd/user/pi-durable-remote.service'), data: join(home, '.local/share/pi-durable-remote'), workspace: join(home, 'work/pi-durable-remote-smoke') };
}

for (const collision of ['unit', 'data-symlink', 'port', 'loaded-service']) {
  test(`install-user-service rejects ${collision} before model check or mutation`, async t => {
    const f = await fixture(t);
    let env = {};
    if (collision === 'unit') { await mkdir(join(f.home, '.config/systemd/user'), { recursive: true }); await writeFile(f.unit, 'existing-unit'); }
    if (collision === 'data-symlink') { await mkdir(join(f.home, '.local/share'), { recursive: true }); await symlink(join(f.home, 'missing'), f.data); }
    if (collision === 'port') env = { PORT_COLLISION: '1' };
    if (collision === 'loaded-service') env = { LOAD_STATE: 'loaded' };
    const result = f.run('install-user-service.sh', env);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /collision/i);
    await assert.rejects(readFile(join(f.home, 'npm-commands')), { code: 'ENOENT' });
    await assert.rejects(readFile(f.workspace), { code: 'ENOENT' });
    if (collision === 'unit') assert.equal(await readFile(f.unit, 'utf8'), 'existing-unit');
    else await assert.rejects(readFile(f.unit), { code: 'ENOENT' });
  });
}

for (const exitCode of [42, 127]) {
  test(`install-user-service rejects empty-output port probe exit ${exitCode} before model check or mutation`, async t => {
    const f = await fixture(t);
    const result = f.run('install-user-service.sh', { PORT_PROBE_EXIT: String(exitCode) });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Port 7777 probe failed/);
    assert.equal(await readFile(join(f.home, 'ss-commands'), 'utf8'), '-H -ltn sport = :7777\n');
    for (const path of [f.unit, f.data, f.workspace, join(f.home, 'node-commands'), join(f.home, 'npm-commands')]) {
      await assert.rejects(readFile(path), { code: 'ENOENT' });
    }
    assert.doesNotMatch(await readFile(join(f.home, 'systemctl-commands'), 'utf8'), /daemon-reload|enable|is-active/);
  });
}

test('install-user-service writes only dedicated loopback unit and enables it after availability check', async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const unit = await readFile(f.unit, 'utf8');
  assert.match(unit, /KillMode=control-group/);
  assert.match(unit, /Restart=always\nRestartSec=6/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /TimeoutStopSec=30/);
  assert.ok(unit.includes(`--cwd ${f.workspace} --storage ${f.data}/session.sqlite --provider test-provider --model test-model --host 127.0.0.1 --port 7777`));
  assert.ok(unit.includes(`ExecStart=${f.bin}/node --experimental-strip-types ${f.app}/packages/server/src/main.ts`));
  assert.match(await readFile(join(f.home, 'systemctl-commands'), 'utf8'), /enable --now pi-durable-remote\.service/);
  const again = f.run();
  assert.equal(again.status, 1);
  assert.equal(await readFile(f.unit, 'utf8'), unit);
});

test('install-user-service availability failure creates no unit/data/workspace', async t => {
  const f = await fixture(t);
  assert.equal(f.run('install-user-service.sh', { AUTH_UNAVAILABLE: '1' }).status, 1);
  for (const path of [f.unit, f.data, f.workspace]) await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('install-dependencies uses ignore-scripts and existing runtime without global runtime activation', async t => {
  const f = await fixture(t);
  const result = f.run('install-dependencies.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(f.home, 'npm-commands'), 'utf8'), '--version\ninstall --ignore-scripts --no-audit --no-fund\nrun check\nrun server -- --help\nrun client -- --help\n');
});
