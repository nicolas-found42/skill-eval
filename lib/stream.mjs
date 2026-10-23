/**
 * Live event streaming for real-time monitoring.
 *
 * Provides a Server-Sent Events (SSE) endpoint that streams telemetry and
 * host events as they happen, so the TUI or an agent can watch sessions live
 * without polling files.
 *
 * Usage:
 *   const server = startStreamServer(runDir, port);
 *   // ... run sessions ...
 *   server.close();
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Start an SSE server that streams events from session telemetry.jsonl files.
 * @param {string} runDir - the run folder to stream events from
 * @param {number} [port] - port to listen on (0 = random)
 * @returns {Promise<{ server: http.Server, port: number, close: () => void, broadcast: (data: string) => void }>}
 */
export function startStreamServer(runDir, port = 0) {
  const clients = new Set();
  const watchers = new Map(); // sessionDir -> fs.FSWatcher

  const server = http.createServer((req, res) => {
    if (req.url !== '/events' && req.url !== '/') {
      res.writeHead(404).end('not found');
      return;
    }
    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 1000\n\n');
    clients.add(res);

    // Send initial state: list of sessions and their current telemetry
    sendInitialState(res, runDir);

    req.on('close', () => {
      clients.delete(res);
    });
  });

  // Watch for new telemetry events in session directories
  function watchSessions() {
    let entries;
    try { entries = fs.readdirSync(runDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const sessionDir = path.join(runDir, ent.name);
      if (watchers.has(sessionDir)) continue;
      const telemetryPath = path.join(sessionDir, 'telemetry.jsonl');
      if (!fs.existsSync(telemetryPath)) continue;

      let lastSize = fs.statSync(telemetryPath).size;
      const watcher = fs.watch(telemetryPath, () => {
        try {
          const stat = fs.statSync(telemetryPath);
          if (stat.size > lastSize) {
            const fd = fs.openSync(telemetryPath, 'r');
            const buf = Buffer.alloc(stat.size - lastSize);
            fs.readSync(fd, buf, 0, buf.length, lastSize);
            fs.closeSync(fd);
            lastSize = stat.size;
            for (const line of buf.toString('utf8').split('\n').filter(l => l.trim())) {
              broadcast(`data: ${line}\n\n`);
            }
          }
        } catch { /* file may be temporarily unavailable */ }
      });
      watchers.set(sessionDir, watcher);
    }
  }

  // Also watch host.jsonl files for orchestration events
  function watchHostLogs() {
    let entries;
    try { entries = fs.readdirSync(runDir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const sessionDir = path.join(runDir, ent.name);
      const hostPath = path.join(sessionDir, 'host.jsonl');
      const watchKey = `host:${sessionDir}`;
      if (watchers.has(watchKey)) continue;
      if (!fs.existsSync(hostPath)) continue;

      let lastSize = fs.statSync(hostPath).size;
      const watcher = fs.watch(hostPath, () => {
        try {
          const stat = fs.statSync(hostPath);
          if (stat.size > lastSize) {
            const fd = fs.openSync(hostPath, 'r');
            const buf = Buffer.alloc(stat.size - lastSize);
            fs.readSync(fd, buf, 0, buf.length, lastSize);
            fs.closeSync(fd);
            lastSize = stat.size;
            for (const line of buf.toString('utf8').split('\n').filter(l => l.trim())) {
              broadcast(`data: ${JSON.stringify({ source: 'host', ...JSON.parse(line) })}\n\n`);
            }
          }
        } catch { /* ignore */ }
      });
      watchers.set(watchKey, watcher);
    }
  }

  // Poll for new session directories every 2 seconds
  const pollInterval = setInterval(() => {
    watchSessions();
    watchHostLogs();
  }, 2000);

  function broadcast(data) {
    for (const client of clients) {
      try { client.write(data); } catch { clients.delete(client); }
    }
  }

  function sendInitialState(res, dir) {
    // Send list of existing sessions
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
    const sessions = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name);
    res.write(`data: ${JSON.stringify({ event: 'sessions_list', sessions })}\n\n`);
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({
        server,
        port: addr.port,
        close: () => {
          clearInterval(pollInterval);
          for (const w of watchers.values()) w.close();
          for (const c of clients) { try { c.end(); } catch { /* ignore */ } }
          server.close();
        },
        broadcast,
      });
    });
  });
}

/**
 * Stream events to stdout in real-time (for CLI usage).
 * Reads telemetry.jsonl and host.jsonl files as they grow.
 * @param {string} runDir
 * @param {{ session?: string }} [opts]
 */
export async function streamToStdout(runDir, { session = null } = {}) {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const watchDirs = [];
  if (session) {
    watchDirs.push(path.join(runDir, session));
  } else {
    // Watch all session directories
    try {
      for (const ent of fs.readdirSync(runDir, { withFileTypes: true })) {
        if (ent.isDirectory() && !ent.name.startsWith('.')) {
          watchDirs.push(path.join(runDir, ent.name));
        }
      }
    } catch { /* run dir may not exist yet */ }
  }

  const positions = new Map();

  function readNewLines(filePath, key) {
    try {
      const stat = fs.statSync(filePath);
      const lastPos = positions.get(key) ?? 0;
      if (stat.size <= lastPos) return;
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(stat.size - lastPos);
      fs.readSync(fd, buf, 0, buf.length, lastPos);
      fs.closeSync(fd);
      positions.set(key, stat.size);
      for (const line of buf.toString('utf8').split('\n').filter(l => l.trim())) {
        try {
          const event = JSON.parse(line);
          process.stdout.write(`[${event.t ?? new Date().toISOString()}] ${event.event}: ${JSON.stringify(event).slice(0, 200)}\n`);
        } catch { /* skip malformed lines */ }
      }
    } catch { /* file may not exist yet */ }
  }

  // Poll every 500ms
  const interval = setInterval(() => {
    for (const dir of watchDirs) {
      readNewLines(path.join(dir, 'telemetry.jsonl'), `tel:${dir}`);
      readNewLines(path.join(dir, 'host.jsonl'), `host:${dir}`);
    }
    // Check for new session directories
    if (!session) {
      try {
        for (const ent of fs.readdirSync(runDir, { withFileTypes: true })) {
          if (ent.isDirectory() && !ent.name.startsWith('.')) {
            const d = path.join(runDir, ent.name);
            if (!watchDirs.includes(d)) watchDirs.push(d);
          }
        }
      } catch { /* ignore */ }
    }
  }, 500);

  // Return a stop function
  return () => clearInterval(interval);
}
