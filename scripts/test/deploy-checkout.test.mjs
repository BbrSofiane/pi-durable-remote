import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

for (const exitCode of [42, 127]) {
  test(`deploy-checkout rejects empty-output port probe exit ${exitCode} before transfer/install`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'durable-deployment-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, 'bin');
    await mkdir(bin);
    const executable = (name, content) => writeFile(join(bin, name), '#!/bin/bash\nset -eu\n' + content, { mode: 0o700 });
    await executable('systemctl', 'case "$*" in *LoadState*) echo not-found;; esac\n');
    await executable('loginctl', 'echo yes\n');
    await executable('ss', 'printf "%s\\n" "$*" >> "$HOME/ss-commands"\nexit "$PORT_PROBE_EXIT"\n');
    await executable('ssh', 'printf "%s\\n" "$*" >> "$HOME/ssh-commands"\nif [[ ${!#} == "bash -se" ]]; then exec /bin/bash -se; fi\ncat >/dev/null\n');
    // The old fail-open guard must be able to finish preflight, not fail later on a missing runtime.
    const runtime = join(root, '.local/share/mise/installs/node/24.4.1/bin');
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, 'node'), '#!/bin/bash\nexit 0\n', { mode: 0o700 });
    const result = spawnSync('/bin/bash', [resolve('scripts/deploy-checkout.sh')], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, PORT_PROBE_EXIT: String(exitCode) },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Port 7777 probe failed/);
    assert.equal(await readFile(join(root, 'ss-commands'), 'utf8'), '-H -ltn sport = :7777\n');
    const calls = (await readFile(join(root, 'ssh-commands'), 'utf8')).trim().split('\n');
    assert.equal(calls.length, 1, 'Failed production preflight must prevent source transfer and dependency install');
    await assert.rejects(readFile(join(root, 'pi-durable-remote')), { code: 'ENOENT' });
  });
}

test('deploy-checkout source allowlist excludes local dependencies, Git, auth and macOS metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'durable-deployment-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = join(root, 'source.tar.gz');
  // Only transport is doubled: run the production archiving path and inspect the real resulting archive.
  await writeFile(join(root, 'ssh'), '#!/bin/bash\nset -eu\nprintf "%s\\n" "$*" >> "$SSH_COMMANDS"\ncase "$*" in *"tar -xzf"*) cat > "$ARCHIVE_CAPTURE";; *) cat >/dev/null;; esac\n', { mode: 0o700 });
  const commands = join(root, 'ssh-commands');
  const result = spawnSync('/bin/bash', [resolve('scripts/deploy-checkout.sh')], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SSH_COMMANDS: commands, ARCHIVE_CAPTURE: capture } });
  assert.equal(result.status, 0, result.stderr);
  const listing = spawnSync('tar', ['-tzf', capture], { encoding: 'utf8', timeout: 5000 });
  assert.equal(listing.status, 0, listing.stderr);
  assert.ok(listing.stdout.includes('packages/server/src/index.ts'));
  assert.ok(listing.stdout.includes('scripts/check-vm-connection.ts'));
  assert.ok(listing.stdout.includes('package-lock.json'));
  assert.doesNotMatch(listing.stdout, /(?:^|\/)(?:node_modules|\.git|\._[^/]*|auth\.json)(?:\/|$)/m);
  const extracted = join(root, 'extract');
  await mkdir(extracted);
  const extraction = spawnSync('tar', ['-xzf', capture, '-C', extracted], { encoding: 'utf8', timeout: 5000 });
  assert.equal(extraction.status, 0, extraction.stderr);
  assert.equal(extraction.stderr, '', 'Source archive must not emit xattr warnings');
  const calls = (await readFile(commands, 'utf8')).trim().split('\n');
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call, /BatchMode=yes/);
    assert.match(call, /ConnectTimeout=10/);
    assert.match(call, /StrictHostKeyChecking=accept-new/);
    assert.match(call, /sof-sandbox\.exe\.xyz/);
  }
});
