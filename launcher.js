import { appendFileSync, closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const logs = path.join(here, 'logs');
const currentLog = path.join(logs, 'server.log');
const previousLog = path.join(logs, 'server.previous.log');
const maxLogSize = 5 * 1024 * 1024;
let child = null;
let stopping = false;

mkdirSync(logs, { recursive: true });

function rotateLog() {
  try {
    if (statSync(currentLog).size <= maxLogSize) return;
    try { unlinkSync(previousLog); } catch {}
    renameSync(currentLog, previousLog);
  } catch {}
}

function write(message) {
  appendFileSync(currentLog, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

function startServer() {
  rotateLog();
  write('server starting');
  const descriptor = openSync(currentLog, 'a');
  child = spawn(process.execPath, [path.join(here, 'server.js')], {
    cwd: here,
    windowsHide: true,
    stdio: ['ignore', descriptor, descriptor]
  });
  closeSync(descriptor);
  child.on('error', error => write(`server spawn error: ${error.stack || error.message}`));
  child.on('exit', (code, signal) => {
    child = null;
    write(`server exited: code=${code ?? 'none'} signal=${signal ?? 'none'}`);
    if (!stopping) setTimeout(startServer, 5_000);
  });
}

function stop() {
  stopping = true;
  if (child && !child.killed) child.kill();
  else process.exit(0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
startServer();
