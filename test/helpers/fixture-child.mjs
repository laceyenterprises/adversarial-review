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
  let timer;
  try {
    await Promise.race([
      close,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Fixture child ${child.pid} did not close within 2 seconds`)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
