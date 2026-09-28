// src/webgl.js
// ---------------------------------------------------------------------------
// WebGL support for environments without a usable GPU.
//
// This environment cannot create a WebGL context: Chromium's GPU process dies
// immediately (exit_code=256), and every flag combination that would enable one
// (--enable-unsafe-swiftshader, --use-angle=swiftshader, --in-process-gpu, ...)
// takes the whole browser down with `FATAL: GPU process isn't usable. Goodbye.`
// The existing flag set is what keeps the browser alive, so the environment is
// treated as fixed and the gap is closed with tooling instead:
//
//   browser_webgl_info    - say whether WebGL is available, and why not
//   browser_webgl_shim    - install a WebGL stand-in so the app can boot
//   browser_webgl_trace   - read back what the app tried to draw
//   browser_canvas_info   - tell a blank canvas from an unrasterizable one
//
// SECURITY MODEL (identical to src/helpers.js)
// --------------------------------------------
// Every string in this file is STATIC. Nothing is ever interpolated into it —
// no tool argument, no selector, no path. The shim source is injected into
// every new document, so it is treated as code of the same sensitivity as
// browser_evaluate and gated behind ENABLE_WEBGL_SHIM (see src/utils.js).
// ---------------------------------------------------------------------------

/** Shim modes accepted by browser_webgl_shim. */
export const SHIM_MODES = ['off', 'mock', 'trace'];

/*
 * SHIM_BASE installs a software stand-in for WebGL.
 *
 * It wraps HTMLCanvasElement.prototype.getContext and
 * OffscreenCanvas.prototype.getContext: a request for 'webgl' / 'webgl2' /
 * 'experimental-webgl' first tries the real context and returns it untouched
 * when one can be created (the shim never interferes with a working GPU), and
 * falls back to a mock context when it cannot.
 *
 * The mock satisfies the API surface three.js/Babylon/Pixi probe at startup, so
 * an app that requires WebGL boots and runs instead of throwing - its layout,
 * state and event handling then become testable. It rasterizes nothing.
 *
 * Recording goes through a single indirection, window.__mcpWebglSink, which
 * SHIM_TRACE_EXTENSION can replace. `mock` keeps counters only; `trace` also
 * keeps shader sources, uniform values and per-draw records.
 */
export const SHIM_BASE = String.raw`(() => {
  if (window.__mcpWebglShim && window.__mcpWebglShim.active) return;

  // Bounded so a long-running animation cannot grow the trace without limit.
  var MAX_RECORDS = 400;

  var shim = {
    active: true,
    mode: 'mock',
    installedAt: Date.now(),
    mockedContexts: 0,
    stats: { draws: 0, triangles: 0, shaders: 0, programs: 0, textures: 0, shaderSources: 0 }
  };
  window.__mcpWebglShim = shim;
  window.__mcpWebglTrace = [];

  // The active sink. SHIM_TRACE_EXTENSION may replace this at any time; record()
  // looks it up on every call, so the replacement takes effect immediately.
  window.__mcpWebglSink = function (kind, data) {
    var s = window.__mcpWebglShim.stats;
    if (kind === 'drawArrays' || kind === 'drawElements' ||
        kind === 'drawArraysInstanced' || kind === 'drawElementsInstanced') {
      s.draws++;
      s.triangles += (data && data.triangles) || 0;
    } else if (kind === 'createShader') {
      s.shaders++;
    } else if (kind === 'shaderSource') {
      s.shaderSources++;
    } else if (kind === 'linkProgram') {
      s.programs++;
    } else if (kind === 'texImage2D') {
      s.textures++;
    }
  };

  function record(kind, data) {
    var sink = window.__mcpWebglSink;
    if (typeof sink === 'function') {
      try { sink(kind, data); } catch (e) { /* never break the page */ }
    }
  }

  // Pull the WebGL constant table off the real interfaces. Both exist as
  // constructors even when context creation itself fails, so the mock can
  // expose the same numeric constants the page expects.
  function copyConstants(Ctor) {
    var out = {};
    if (!Ctor) return out;
    var keys;
    try { keys = Object.getOwnPropertyNames(Ctor); } catch (e) { return out; }
    for (var i = 0; i < keys.length; i++) {
      var value;
      try { value = Ctor[keys[i]]; } catch (e) { continue; }
      if (typeof value === 'number') out[keys[i]] = value;
    }
    return out;
  }

  var GL1 = typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext : null;
  var GL2 = typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : null;
  var CONSTANTS = Object.assign({}, copyConstants(GL1), copyConstants(GL2));

  var nextHandle = 1;
  function fresh(kind) {
    return { __mcpHandle: nextHandle++, __mcpKind: kind };
  }

  function createMockContext(type, canvas, attributes) {
    var shaderSources = new Map();

    var api = {
      canvas: canvas,
      drawingBufferWidth: canvas.width,
      drawingBufferHeight: canvas.height,
      // Identity markers: browser_webgl_info reads __mcpMock to tell a mock
      // context from a real one, and browser_canvas_info reads
      // __mcpMockContext on the element (there is no API that asks a canvas
      // which context it holds).
      __mcpMock: true,
      __mcpMockType: type,

      getContextAttributes: function () {
        return Object.assign({
          alpha: true, depth: true, stencil: false, antialias: false,
          premultipliedAlpha: true, preserveDrawingBuffer: false,
          powerPreference: 'default', failIfMajorPerformanceCaveat: false
        }, attributes || {});
      },
      isContextLost: function () { return false; },
      getSupportedExtensions: function () { return []; },
      getExtension: function () { return null; },
      getError: function () { return 0; },
      getShaderPrecisionFormat: function () { return { rangeMin: 127, rangeMax: 127, precision: 23 }; },

      getParameter: function (pname) {
        if (pname === CONSTANTS.VERSION || pname === 0x1F02) return 'WebGL 1.0 (browser-mcp mock)';
        if (pname === CONSTANTS.SHADING_LANGUAGE_VERSION || pname === 0x8B8C) return 'WebGL GLSL ES 1.0 (browser-mcp mock)';
        if (pname === CONSTANTS.VENDOR || pname === 0x1F00) return 'browser-mcp';
        if (pname === CONSTANTS.RENDERER || pname === 0x1F01) return 'browser-mcp software mock';
        if (pname === CONSTANTS.MAX_TEXTURE_SIZE || pname === 0x0D33) return 4096;
        if (pname === CONSTANTS.MAX_CUBE_MAP_TEXTURE_SIZE || pname === 0x851C) return 4096;
        if (pname === CONSTANTS.MAX_RENDERBUFFER_SIZE || pname === 0x84E8) return 4096;
        if (pname === CONSTANTS.MAX_TEXTURE_IMAGE_UNITS || pname === 0x8872) return 16;
        if (pname === CONSTANTS.MAX_VERTEX_TEXTURE_IMAGE_UNITS || pname === 0x8B4C) return 16;
        if (pname === CONSTANTS.MAX_COMBINED_TEXTURE_IMAGE_UNITS || pname === 0x8B4D) return 32;
        if (pname === CONSTANTS.MAX_VERTEX_UNIFORM_VECTORS || pname === 0x8DFB) return 256;
        if (pname === CONSTANTS.MAX_FRAGMENT_UNIFORM_VECTORS || pname === 0x8DFD) return 256;
        if (pname === CONSTANTS.MAX_VARYING_VECTORS || pname === 0x8DFC) return 30;
        if (pname === CONSTANTS.MAX_VERTEX_ATTRIBS || pname === 0x8869) return 16;
        if (pname === CONSTANTS.MAX_VIEWPORT_DIMS || pname === 0x0D3A) return new Int32Array([4096, 4096]);
        if (pname === CONSTANTS.VIEWPORT || pname === 0x0BA2) return new Int32Array([0, 0, canvas.width, canvas.height]);
        if (pname === CONSTANTS.SCISSOR_BOX || pname === 0x0C10) return new Int32Array([0, 0, canvas.width, canvas.height]);
        if (pname === CONSTANTS.MAX_SAMPLES || pname === 0x8D57) return 4;
        return 0;
      },

      createShader: function (kind) {
        var shader = fresh('shader');
        shader.shaderType = kind;
        record('createShader', { type: kind });
        return shader;
      },
      shaderSource: function (shader, source) {
        var text = String(source);
        shaderSources.set(shader.__mcpHandle, text);
        record('shaderSource', { type: shader.shaderType, length: text.length, source: text.slice(0, 800) });
      },
      compileShader: function (shader) { shader.__compiled = true; },
      getShaderParameter: function () { return true; },
      getShaderInfoLog: function () { return ''; },
      deleteShader: function () {},

      createProgram: function () { return fresh('program'); },
      attachShader: function () {},
      linkProgram: function (program) { program.__linked = true; record('linkProgram', {}); },
      getProgramParameter: function () { return true; },
      getProgramInfoLog: function () { return ''; },
      useProgram: function () {},
      deleteProgram: function () {},

      createBuffer: function () { return fresh('buffer'); },
      createTexture: function () { return fresh('texture'); },
      createFramebuffer: function () { return fresh('framebuffer'); },
      createRenderbuffer: function () { return fresh('renderbuffer'); },
      deleteBuffer: function () {},
      deleteTexture: function () {},
      deleteFramebuffer: function () {},
      deleteRenderbuffer: function () {},

      bindBuffer: function () {},
      bufferData: function (target, data) {
        record('bufferData', { bytes: (data && data.byteLength) || null });
      },
      bufferSubData: function () {},
      activeTexture: function () {},
      bindTexture: function () {},
      texImage2D: function (target, level, internalformat, width, height) {
        record('texImage2D', {
          width: typeof width === 'number' ? width : null,
          height: typeof height === 'number' ? height : null
        });
      },
      texParameteri: function () {},
      generateMipmap: function () {},
      pixelStorei: function () {},

      getAttribLocation: function () { return 0; },
      getUniformLocation: function () { return fresh('uniform'); },
      enableVertexAttribArray: function () {},
      disableVertexAttribArray: function () {},
      vertexAttribPointer: function () {},

      uniform1f: function (loc, x) { record('uniform', { name: 'uniform1f', value: x }); },
      uniform1i: function (loc, x) { record('uniform', { name: 'uniform1i', value: x }); },
      uniform2f: function (loc, x, y) { record('uniform', { name: 'uniform2f', value: [x, y] }); },
      uniform3f: function (loc, x, y, z) { record('uniform', { name: 'uniform3f', value: [x, y, z] }); },
      uniform4f: function (loc, x, y, z, w) { record('uniform', { name: 'uniform4f', value: [x, y, z, w] }); },
      uniformMatrix4fv: function (loc, transpose, value) {
        record('uniform', { name: 'uniformMatrix4fv', value: value ? Array.prototype.slice.call(value, 0, 16) : null });
      },

      viewport: function () {},
      clearColor: function () {},
      clear: function () {},
      enable: function () {},
      disable: function () {},
      blendFunc: function () {},
      depthFunc: function () {},
      cullFace: function () {},
      frontFace: function () {},
      scissor: function () {},
      colorMask: function () {},
      depthMask: function () {},
      lineWidth: function () {},
      finish: function () {},
      flush: function () {},
      readPixels: function () {},

      drawArrays: function (mode, first, count) {
        var verts = count | 0;
        record('drawArrays', {
          mode: mode, first: first, count: verts,
          triangles: Math.floor(verts / 3), drawIndex: window.__mcpWebglShim.stats.draws + 1
        });
      },
      drawElements: function (mode, count, type, offset) {
        var indices = count | 0;
        record('drawElements', {
          mode: mode, count: indices,
          triangles: Math.floor(indices / 3), drawIndex: window.__mcpWebglShim.stats.draws + 1
        });
      },
      drawArraysInstanced: function (mode, first, count, instances) {
        record('drawArraysInstanced', { mode: mode, count: count, instances: instances });
      },
      drawElementsInstanced: function (mode, count, type, offset, instances) {
        record('drawElementsInstanced', { mode: mode, count: count, instances: instances });
      }
    };

    var proxy = new Proxy(api, {
      get: function (target, prop) {
        if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
        if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(CONSTANTS, prop)) {
          return CONSTANTS[prop];
        }
        // Unknown API member: hand back a harmless no-op so feature detection
        // that calls a method we did not model does not throw.
        if (typeof prop === 'string') return function () { return undefined; };
        return undefined;
      },
      has: function (target, prop) {
        return Object.prototype.hasOwnProperty.call(target, prop) ||
          (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(CONSTANTS, prop));
      }
    });

    // Make the mock pass an "instanceof WebGLRenderingContext" gate, so
    // libraries that check the constructor before booting accept it. The traps
    // above use hasOwnProperty precisely so the real prototype methods never
    // shadow the mock's own implementations.
    if (GL1 && GL1.prototype) {
      try { Object.setPrototypeOf(proxy, GL1.prototype); } catch (e) { /* ignore */ }
    }
    return proxy;
  }

  function patchContextFactory(proto) {
    if (!proto || typeof proto.getContext !== 'function') return false;
    var original = proto.getContext;
    proto.getContext = function (type, attributes) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
        var real = null;
        try { real = original.call(this, type, attributes); } catch (e) { real = null; }
        if (real) return real;
        window.__mcpWebglShim.mockedContexts++;
        try { this.__mcpMockContext = type; } catch (e) { /* ignore */ }
        return createMockContext(type, this, attributes);
      }
      return original.call(this, type, attributes);
    };
    return true;
  }

  var patchedCanvas = patchContextFactory(window.HTMLCanvasElement && HTMLCanvasElement.prototype);
  var patchedOffscreen = patchContextFactory(window.OffscreenCanvas && OffscreenCanvas.prototype);

  shim.patched = { htmlCanvas: patchedCanvas, offscreenCanvas: patchedOffscreen };
  record('install', { patched: shim.patched });
})();`;

/*
 * SHIM_TRACE_EXTENSION upgrades the sink to a full recorder. Kept as a separate
 * static string so `mock` and `trace` never share interpolated code.
 *
 * Caps baked into the source (they cannot be interpolated): 400 records,
 * 800 characters of shader source per record.
 */
export const SHIM_TRACE_EXTENSION = String.raw`(() => {
  var shim = window.__mcpWebglShim;
  if (!shim || !shim.active) return;

  var MAX_RECORDS = 400;
  var previous = window.__mcpWebglSink;

  window.__mcpWebglSink = function (kind, data) {
    if (typeof previous === 'function') {
      try { previous(kind, data); } catch (e) { /* ignore */ }
    }
    var list = window.__mcpWebglTrace;
    if (!list || list.length >= MAX_RECORDS) return;
    list.push(Object.assign({ kind: kind, t: Date.now() }, data || {}));
  };

  shim.mode = 'trace';
})();`;

/** mode -> fully static source. Never built from tool arguments. */
export const SHIM_SOURCES = {
  mock: SHIM_BASE,
  trace: SHIM_BASE + '\n' + SHIM_TRACE_EXTENSION
};

/*
 * Summary expression for browser_webgl_trace. The summarising happens in-page
 * so a full 400-record trace never has to cross the CDP boundary; only the
 * capped arrays below are returned. Limits are literals because the string is
 * static: 8 shader sources, 60 draw calls, 40 uniforms, 20 textures.
 */
export const TRACE_SUMMARY_EXPRESSION = String.raw`(() => {
  var shim = window.__mcpWebglShim || null;
  var list = window.__mcpWebglTrace || [];

  var counts = {};
  var shaders = [];
  var draws = [];
  var uniforms = [];
  var textures = [];
  var other = [];

  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    counts[r.kind] = (counts[r.kind] || 0) + 1;

    if (r.kind === 'shaderSource') {
      if (shaders.length < 8) shaders.push({ type: r.type, length: r.length, source: r.source });
    } else if (r.kind === 'drawArrays' || r.kind === 'drawElements' ||
               r.kind === 'drawArraysInstanced' || r.kind === 'drawElementsInstanced') {
      if (draws.length < 60) {
        draws.push({ kind: r.kind, mode: r.mode, count: r.count, triangles: r.triangles, drawIndex: r.drawIndex });
      }
    } else if (r.kind === 'uniform') {
      if (uniforms.length < 40) uniforms.push({ name: r.name, value: r.value });
    } else if (r.kind === 'texImage2D') {
      if (textures.length < 20) textures.push({ width: r.width, height: r.height });
    } else if (other.length < 20) {
      other.push({ kind: r.kind });
    }
  }

  return {
    installed: !!(shim && shim.active),
    mode: shim ? shim.mode : null,
    stats: shim ? shim.stats : null,
    recordCount: list.length,
    counts: counts,
    shaders: shaders,
    draws: draws,
    uniforms: uniforms,
    textures: textures,
    other: other
  };
})()`;

/** Empties the trace and its counters, so one interaction can be measured. */
export const TRACE_CLEAR_EXPRESSION = String.raw`(() => {
  if (window.__mcpWebglTrace) window.__mcpWebglTrace.length = 0;
  if (window.__mcpWebglShim && window.__mcpWebglShim.stats) {
    var s = window.__mcpWebglShim.stats;
    s.draws = 0; s.triangles = 0; s.shaders = 0;
    s.programs = 0; s.textures = 0; s.shaderSources = 0;
  }
  return true;
})()`;

/*
 * Console signatures the common WebGL libraries emit when their renderer cannot
 * start. Recognising them turns "the page is broken" into "the renderer never
 * initialised", which is the diagnosis the caller actually needs.
 */
const LIBRARY_SIGNATURES = [
  { library: 'three.js', pattern: /error creating webgl context|webglrenderer:.*context/i },
  { library: 'babylon.js', pattern: /babylon\.js|engine.*webgl.*fail|unable to initialize/i },
  { library: 'pixijs', pattern: /pixi.*webgl|unable to auto-detect renderer/i },
  { library: 'mapbox/maplibre', pattern: /maplibre|mapbox.*webgl|failed to initialize webgl/i },
  { library: 'playcanvas', pattern: /playcanvas.*webgl|webgl not supported/i }
];

const GENERIC_WEBGL_ERROR = /webgl|gl_|shader|context lost|gpu/i;

/** Maximum console entries reported as WebGL failures (keeps the reply small). */
const MAX_CONSOLE_HITS = 10;

/**
 * Classify captured console messages against known WebGL failure signatures.
 * Returns only error/warning entries that mention WebGL, tagged with the
 * library when one is recognised.
 */
export function classifyWebglMessages(messages = []) {
  const hits = [];
  for (const message of messages) {
    if (hits.length >= MAX_CONSOLE_HITS) break;
    if (message.level !== 'error' && message.level !== 'warning') continue;

    const text = message.text || '';
    if (!GENERIC_WEBGL_ERROR.test(text)) continue;

    const signature = LIBRARY_SIGNATURES.find(entry => entry.pattern.test(text));
    hits.push({
      library: signature ? signature.library : null,
      level: message.level,
      text: text.slice(0, 300)
    });
  }
  return hits;
}
