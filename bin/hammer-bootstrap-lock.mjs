import fsExt from 'fs-ext';

// The shell opens this file and passes the same open file description as FD 3.
// Closing this process's copy leaves the kernel lock held by the shell.
try {
  fsExt.flockSync(3, 'exnb');
} catch (error) {
  if (!['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) {
    console.error(`HAM bootstrap lock unavailable: ${error.message}`);
  }
  process.exitCode = 1;
}
