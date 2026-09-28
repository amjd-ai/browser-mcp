// tests/webgl.test.js
// ---------------------------------------------------------------------------
// Integration coverage for the WebGL tool set:
//
//   browser_webgl_info    - WebGL availability, and why it is unavailable
//   browser_canvas_info   - blank canvas vs. unrasterizable canvas
//   browser_webgl_shim    - install/remove the stand-in, and its security gate
//   browser_webgl_trace   - read back what the app tried to draw
//   browser_capture_frames - frame sequences (screencast and poll)
//
// These spawn real Chromium, like the other integration suites.
// ---------------------------------------------------------------------------

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startFixtureServer,
  startMcpServer,
  stopServer,
  initializeServer,
  makeCallTool,
  assertSuccess,
  resultText
} from './harness.js';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

describe('WebGL tools', () => {
  let fixture;
  let mcp;
  let call;
  let origin;

  before(async () => {
    fixture = await startFixtureServer();
    origin = `http://127.0.0.1:${fixture.port}`;

    // The shim is opt-in; this suite enables it so the install/remove path can
    // be exercised. The gate itself is covered in its own describe below.
    mcp = startMcpServer({ ENABLE_WEBGL_SHIM: '1' });
    await initializeServer(mcp, 'webgl-test');
    call = makeCallTool(mcp);

    assertSuccess(await call('browser_navigate', { url: `${origin}/webgl-page.html` }, 60000));
  });

  after(async () => {
    await stopServer(mcp);
    fixture.server.close();
  });

  it('reports WebGL as unavailable, and names the library that failed', async () => {
    const info = assertSuccess(await call('browser_webgl_info'));

    assert.equal(info.usable, false, 'no real WebGL context exists in this environment');
    assert.equal(info.effective, 'unavailable');
    assert.equal(info.webgl.ok, false);
    assert.equal(info.webgl2.ok, false);
    assert.equal(info.shim.active, false);
    assert.ok(info.reason, 'a reason must accompany an unavailable verdict');
    assert.ok(info.advice, 'the caller must be told what it can do about it');

    // The failure is invisible except in the console, so that is part of the report.
    assert.ok(Array.isArray(info.consoleHits) && info.consoleHits.length > 0);
    assert.equal(info.consoleHits[0].library, 'three.js');
  });

  it('separates a blank canvas from a drawn one', async () => {
    const report = assertSuccess(await call('browser_canvas_info'));

    assert.equal(report.count, 2);

    const glCanvas = report.canvases.find(c => c.id === 'gl');
    const controlCanvas = report.canvases.find(c => c.id === 'canvas2d');
    assert.ok(glCanvas && controlCanvas, 'both fixture canvases must be reported');

    // Same capture path, opposite verdicts — that is the whole point.
    assert.equal(glCanvas.pixels.blank, true);
    assert.ok(glCanvas.pixels.uniqueColors <= 1);
    assert.equal(controlCanvas.pixels.blank, false);
    assert.ok(controlCanvas.pixels.uniqueColors > 1);
    assert.match(controlCanvas.verdict, /pixel content/i);

    // Reported sizes are the element's, not the sampling window's.
    assert.equal(glCanvas.attributeSize.width, 320);
    assert.equal(controlCanvas.attributeSize.width, 200);
  });

  it('refuses browser_webgl_trace while no shim is installed', async () => {
    const response = await call('browser_webgl_trace');

    assert.equal(response.result.isError, true);
    assert.match(resultText(response), /WEBGL_TRACE_UNAVAILABLE/);
  });

  it('installs the shim, and the WebGL app boots', async () => {
    const applied = assertSuccess(await call('browser_webgl_shim', { mode: 'trace' }, 60000));

    assert.equal(applied.mode, 'trace');
    assert.equal(applied.shimmed, true, 'a shimmed result must never look like GPU rendering');
    assert.equal(applied.reloaded, true);
    assert.ok(applied.identifier !== null);

    const info = assertSuccess(await call('browser_webgl_info'));
    assert.equal(info.effective, 'shimmed');
    assert.equal(info.usable, false, 'the shim is not real WebGL');
    assert.ok(info.shim.mockedContexts > 0, 'the shim must have intercepted a getContext call');

    // The app itself got past its renderer check instead of throwing.
    const status = assertSuccess(await call('browser_get_text', { selector: '#status' }));
    assert.equal(status.text, 'WebGL available (shim)');
  });

  it('records shader sources, uniforms and draw calls', async () => {
    await sleep(400); // let the render loop issue a few frames

    const trace = assertSuccess(await call('browser_webgl_trace'));

    assert.equal(trace.available, true);
    assert.equal(trace.mode, 'trace');
    assert.ok(trace.stats.shaders >= 2, `expected >= 2 shaders, got ${trace.stats.shaders}`);
    assert.ok(trace.stats.draws >= 1, `expected draw calls, got ${trace.stats.draws}`);
    assert.ok(trace.stats.triangles >= 1);
    assert.ok(trace.counts.drawArrays >= 1);

    const vertexShader = trace.shaders.find(s => /gl_Position/.test(s.source || ''));
    assert.ok(vertexShader, 'the vertex shader source must be recoverable');

    const uniform = trace.uniforms.find(u => u.name === 'uniform3f');
    assert.ok(uniform, 'uniform traffic must be recorded');
  });

  it('flags a canvas as blank on purpose once the shim serves it', async () => {
    const report = assertSuccess(await call('browser_canvas_info'));
    const glCanvas = report.canvases.find(c => c.id === 'gl');

    assert.ok(
      glCanvas.mockContextType === 'webgl' || glCanvas.mockContextType === 'webgl2',
      `expected a mock context marker, got ${glCanvas.mockContextType}`
    );
    assert.equal(glCanvas.pixels.blank, true);
    assert.match(glCanvas.verdict, /blank on purpose/i);
  });

  it('clears the trace on request', async () => {
    const cleared = assertSuccess(await call('browser_webgl_trace', { clear: true }));

    assert.equal(cleared.cleared, true);
    // The counters observed before the clear are still reported.
    assert.ok(cleared.stats.draws >= 1);
  });

  it('captures a frame sequence clipped to an element', async () => {
    const result = assertSuccess(await call('browser_capture_frames', {
      count: 3,
      strategy: 'poll',
      interval_ms: 80,
      format: 'png',
      selector: '#canvas2d'
    }, 60000));

    assert.equal(result.requested, 3);
    assert.equal(result.captured, 3);
    assert.ok(result.clip.width > 0 && result.clip.height > 0, 'the clip must come from the element');

    for (const frame of result.frames) {
      assert.ok(frame.size > 0);
      assert.ok(frame.width > 0 && frame.height > 0, 'dimensions are decoded from the real image');
    }
  });

  it('captures a frame sequence over the screencast stream', async () => {
    const result = assertSuccess(await call('browser_capture_frames', {
      count: 3,
      strategy: 'screencast',
      interval_ms: 100
    }, 60000));

    assert.equal(result.captured, 3);
    assert.equal(result.frames.length, 3);
    // Headless Chromium commits a frame only on demand; the pump is what makes
    // the cadence controllable.
    assert.ok(result.pumpCount > 0, 'the screencast must have been pumped');
  });

  it('removes the shim and restores the unavailable state', async () => {
    const removed = assertSuccess(await call('browser_webgl_shim', { mode: 'off' }, 60000));

    assert.equal(removed.mode, 'off');
    assert.equal(removed.shimmed, false);
    assert.equal(removed.identifier, null);
    assert.equal(removed.reloaded, true);

    const info = assertSuccess(await call('browser_webgl_info'));
    assert.equal(info.effective, 'unavailable');
    assert.equal(info.shim.active, false);

    const trace = await call('browser_webgl_trace');
    assert.equal(trace.result.isError, true);
    assert.match(resultText(trace), /WEBGL_TRACE_UNAVAILABLE/);
  });

  it('reports zero canvases on a page that has none', async () => {
    assertSuccess(await call('browser_navigate', { url: `${origin}/test-page.html` }, 60000));

    const report = assertSuccess(await call('browser_canvas_info'));
    assert.equal(report.count, 0);
    assert.equal(report.canvases.length, 0);
    assert.equal(report.blank, 0);

    // Absence of a canvas is not the same as absence of WebGL support.
    const info = assertSuccess(await call('browser_webgl_info'));
    assert.equal(info.effective, 'unavailable');
  });
});

describe('browser_webgl_shim security gate', () => {
  let mcp;
  let call;

  before(async () => {
    mcp = startMcpServer(); // no ENABLE_WEBGL_SHIM
    await initializeServer(mcp, 'webgl-gate-test');
    call = makeCallTool(mcp);
  });

  after(async () => {
    await stopServer(mcp);
  });

  it('refuses to install the shim while ENABLE_WEBGL_SHIM is off', async () => {
    const response = await call('browser_webgl_shim', { mode: 'trace' });

    assert.equal(response.result.isError, true);
    assert.match(resultText(response), /WEBGL_SHIM_DISABLED/);
    // The refusal happens before any browser resource is used.
    assert.match(resultText(response), /ENABLE_WEBGL_SHIM=1/);
  });

  it('leaves the read-only probes usable without the gate', async () => {
    // Only the injection is gated; diagnosing a page is not a privileged act.
    const info = assertSuccess(await call('browser_webgl_info', {}, 60000));
    assert.equal(typeof info.usable, 'boolean');
    assert.ok(info.effective);
  });
});
