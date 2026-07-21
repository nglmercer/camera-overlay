#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUT_MS = 15_000;

const CORNERS = {
  'top-left': { x: 0, y: 0 },
  'top-right': { x: '70vw', y: 0 },
  'bottom-left': { x: 0, y: '70vh' },
  'bottom-right': { x: '70vw', y: '70vh' },
};

const TOOLS = [
  {
    name: 'start_app',
    description: 'Start camera-overlay and wait until its HTTP server is ready.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'integer', minimum: 1024, maximum: 65535, default: DEFAULT_PORT },
        binary: { type: 'string', description: 'Optional camera-overlay binary path.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000, default: DEFAULT_TIMEOUT_MS },
      },
    },
  },
  {
    name: 'stop_app',
    description: 'Stop the camera-overlay process started by this MCP server.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_status',
    description: 'Read camera-overlay status and current overlay positioning state.',
    inputSchema: {
      type: 'object',
      properties: {
        base_url: { type: 'string', description: 'Existing server URL; defaults to localhost.' },
        auto_start: { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'start_camera',
    description: 'Ask the running camera-overlay app to start camera capture.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'stop_camera',
    description: 'Ask the running camera-overlay app to stop camera capture.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_overlay_position',
    description: 'Move the overlay camera to a screen corner and verify the persisted state.',
    inputSchema: {
      type: 'object',
      required: ['position'],
      properties: {
        position: {
          type: 'string',
          enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
        },
        port: { type: 'integer', minimum: 1024, maximum: 65535, default: DEFAULT_PORT },
        base_url: { type: 'string', description: 'Existing server URL; defaults to localhost.' },
        auto_start: { type: 'boolean', default: true },
        width: { type: ['string', 'number'], default: '30vw' },
        height: { type: ['string', 'number'], default: '30vh' },
        fit: { type: 'string', enum: ['contain', 'cover', 'fill', 'none'], default: 'contain' },
      },
    },
  },
  {
    name: 'verify_corner_positions',
    description: 'Start the app if needed, move the overlay through all four corners, and verify every HTTP response.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'integer', minimum: 1024, maximum: 65535, default: DEFAULT_PORT },
        binary: { type: 'string', description: 'Optional camera-overlay binary path.' },
        start_camera: { type: 'boolean', default: false, description: 'Also call /start; useful on a machine with a camera.' },
        stop_after: { type: 'boolean', default: false, description: 'Stop the app if this MCP server started it.' },
      },
    },
  },
];

let managedChild = null;
let managedBaseUrl = null;
let shuttingDown = false;

function log(message) {
  process.stderr.write(`[camera-overlay-mcp] ${message}\n`);
}

function textResult(value, isError = false) {
  return {
    isError,
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function portFrom(value) {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function baseUrlFrom(args = {}) {
  if (args.base_url) {
    return String(args.base_url).replace(/\/$/, '');
  }
  return `http://127.0.0.1:${portFrom(args.port)}`;
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
  });
  const bodyText = await response.text();
  let body = bodyText;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // Keep non-JSON responses as text.
  }
  if (!response.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`${options.method ?? 'GET'} ${path} failed with HTTP ${response.status}: ${detail}`);
  }
  return body;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

async function waitForServer(baseUrl, timeoutMs, child = null) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not contacted yet';
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`camera-overlay exited with code ${child.exitCode}; ${lastError}`);
    }
    try {
      const status = await request(baseUrl, '/status');
      return status;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw new Error(`Timed out waiting for ${baseUrl}: ${lastError}`);
}

async function waitForFrame(baseUrl, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let status = await request(baseUrl, '/status');
  while (status.running && !status.has_frame && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    status = await request(baseUrl, '/status');
  }
  return status;
}

function findBinary(requested) {
  const candidates = requested
    ? [resolve(PROJECT_ROOT, requested)]
    : [
        process.env.CAMERA_OVERLAY_BINARY,
        resolve(PROJECT_ROOT, 'target/release/camera-overlay'),
        resolve(PROJECT_ROOT, 'target/debug/camera-overlay'),
      ].filter(Boolean);
  const binary = candidates.find((candidate) => existsSync(candidate));
  if (!binary) {
    throw new Error('No camera-overlay binary found. Run `cargo build --release` first.');
  }
  return binary;
}

function waitForChildExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolvePromise();
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    child.once('exit', onExit);
  });
}

async function startApp(args = {}) {
  const port = portFrom(args.port);
  const baseUrl = baseUrlFrom({ ...args, port });

  try {
    const status = await request(baseUrl, '/status');
    managedBaseUrl = baseUrl;
    return { started: false, already_running: true, managed: false, base_url: baseUrl, status };
  } catch {
    // Start below.
  }

  const binary = findBinary(args.binary);
  const timeoutMs = args.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : Number(args.timeout_ms);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error(`Invalid timeout_ms: ${args.timeout_ms}`);
  }

  const child = spawn(binary, [], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, CAMERA_OVERLAY_PORT: String(port), RUST_LOG: process.env.RUST_LOG ?? 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const collectLogs = (chunk) => {
    logs = `${logs}${chunk}`.slice(-16_000);
  };
  child.stdout.on('data', collectLogs);
  child.stderr.on('data', collectLogs);
  child.once('error', (error) => log(`child process error: ${error.message}`));

  managedChild = child;
  managedBaseUrl = baseUrl;

  try {
    const status = await waitForServer(baseUrl, timeoutMs, child);
    return { started: true, already_running: false, managed: true, pid: child.pid, binary, base_url: baseUrl, status };
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM');
    await waitForChildExit(child);
    managedChild = null;
    managedBaseUrl = null;
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs}`.trim());
  }
}

async function stopApp() {
  if (!managedChild) {
    return { stopped: false, reason: 'No app process is managed by this MCP server.' };
  }
  const child = managedChild;
  if (child.exitCode === null) child.kill('SIGTERM');
  await waitForChildExit(child);
  if (child.exitCode === null) child.kill('SIGKILL');
  managedChild = null;
  const baseUrl = managedBaseUrl;
  managedBaseUrl = null;
  return { stopped: true, pid: child.pid, base_url: baseUrl };
}

async function ensureApp(args = {}) {
  const baseUrl = baseUrlFrom(args);
  if (args.auto_start === false) {
    await request(baseUrl, '/status');
    return baseUrl;
  }
  await startApp(args);
  return baseUrl;
}

async function setOverlayPosition(args) {
  const position = String(args.position ?? '').toLowerCase();
  const corner = CORNERS[position];
  if (!corner) throw new Error(`Unknown position: ${args.position}`);

  const baseUrl = await ensureApp(args);
  const state = {
    ...corner,
    width: args.width ?? '30vw',
    height: args.height ?? '30vh',
    fit: args.fit ?? 'contain',
  };
  const updated = await request(baseUrl, '/overlay', {
    method: 'POST',
    body: JSON.stringify(state),
  });
  const observed = await request(baseUrl, '/overlay');
  return {
    position,
    requested: state,
    response: updated,
    observed,
    verified: JSON.stringify(canonicalJson(state)) === JSON.stringify(canonicalJson(observed)),
  };
}

async function verifyCornerPositions(args = {}) {
  const started = await startApp(args);
  const baseUrl = started.base_url;
  let cameraStart = null;
  if (args.start_camera) {
    try {
      cameraStart = await request(baseUrl, '/start', { method: 'POST' });
      cameraStart.status = await waitForFrame(baseUrl);
    } catch (error) {
      cameraStart = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  const positions = [];
  for (const position of Object.keys(CORNERS)) {
    positions.push(await setOverlayPosition({ ...args, base_url: baseUrl, position }));
  }
  const status = await request(baseUrl, '/status');
  const result = {
    base_url: baseUrl,
    started_app: started.started,
    camera_start: cameraStart,
    camera_status: status,
    positions,
    passed: positions.every((item) => item.verified),
  };
  if (args.stop_after && started.started) {
    result.stop = await stopApp();
  }
  return result;
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'start_app':
      return startApp(args);
    case 'stop_app':
      return stopApp();
    case 'get_status': {
      const baseUrl = await ensureApp(args);
      return { base_url: baseUrl, status: await request(baseUrl, '/status'), overlay: await request(baseUrl, '/overlay') };
    }
    case 'start_camera': {
      const baseUrl = await ensureApp(args);
      const response = await request(baseUrl, '/start', { method: 'POST' });
      return { base_url: baseUrl, response, status: await waitForFrame(baseUrl) };
    }
    case 'stop_camera': {
      const baseUrl = await ensureApp(args);
      return { base_url: baseUrl, response: await request(baseUrl, '/stop', { method: 'POST' }) };
    }
    case 'set_overlay_position':
      return setOverlayPosition(args);
    case 'verify_corner_positions':
      return verifyCornerPositions(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (managedChild) await stopApp();
}

process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    log(`Ignoring invalid JSON input: ${error.message}`);
    continue;
  }

  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') continue;
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'camera-overlay', version: '0.1.0' },
      },
    })}\n`);
    continue;
  }
  if (message.method === 'ping') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
    continue;
  }
  if (message.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })}\n`);
    continue;
  }
  if (message.method === 'tools/call') {
    try {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {});
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: textResult(result) })}\n`);
    } catch (error) {
      const detail = { error: error instanceof Error ? error.message : String(error) };
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: textResult(detail, true) })}\n`);
    }
    continue;
  }
  if (message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })}\n`);
  }
}

await shutdown();
