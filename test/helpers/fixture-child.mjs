// Cleanup for test-owned children. Detached fixtures lead their own process group.
export async function killFixtureChild(child, { detached = true } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const close = new Promise((resolve) => child.once('close', resolve));
  try {
    process.kill(detached ? -child.pid : child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code === 'EPERM' && detached) child.kill('SIGKILL');
    else if (error.code !== 'ESRCH') throw error;
  }
  await close;
}

// Inline JS fixtures use this before their workload. A missed cleanup cannot
// leave them alive indefinitely, even if the test runner itself is killed.
export const fixtureLifetime = `
  const fixtureParentPid = process.ppid;
  setTimeout(() => process.exit(0), 30_000).unref();
  setInterval(() => {
    if (process.ppid !== fixtureParentPid) process.exit(0);
  }, 250).unref();
`;
