// This code implements the `-sMODULARIZE` settings by taking the generated
// JS program code (INNER_JS_CODE) and wrapping it in a factory function.

// When targeting node and ES6 we use `await import ..` in the generated code
// so the outer function needs to be marked as async.
async function PgParserModule(moduleArg = {}) {
  var moduleRtn;

(function() {
  function a(d) {
    d = d.split("-")[0];
    for (d = d.split(".").slice(0, 3); 3 > d.length;) {
      d.push("00");
    }
    d = d.map(e => e.padStart(2, "0"));
    return d.join("");
  }
  var b = "undefined" !== typeof process && process.versions?.node ? a(process.versions.node) : 2147483647;
  if (160000 > b) {
    throw Error(`This emscripten-generated code requires node v${"16.0.0"} (detected v${[b / 10000 | 0, (b / 100 | 0) % 100, b % 100].join(".")})`);
  }
  if (b = "undefined" !== typeof navigator && navigator.userAgent) {
    var c = b.includes("Safari/") && !b.includes("Chrome/") && b.match(/Version\/(\d+\.?\d*\.?\d*)/) ? a(b.match(/Version\/(\d+\.?\d*\.?\d*)/)[1]) : 2147483647;
    if (150000 > c) {
      throw Error(`This emscripten-generated code requires Safari v${"15.0.0"} (detected v${c})`);
    }
    c = b.match(/Firefox\/(\d+(?:\.\d+)?)/) ? parseFloat(b.match(/Firefox\/(\d+(?:\.\d+)?)/)[1]) : 2147483647;
    if (79 > c) {
      throw Error(`This emscripten-generated code requires Firefox v79 (detected v${c})`);
    }
    b = b.match(/Chrome\/(\d+(?:\.\d+)?)/) ? parseFloat(b.match(/Chrome\/(\d+(?:\.\d+)?)/)[1]) : 2147483647;
    if (85 > b) {
      throw Error(`This emscripten-generated code requires Chrome v85 (detected v${b})`);
    }
  }
})();
var g = moduleArg, ba = !!globalThis.window, ca = !!globalThis.WorkerGlobalScope, h = globalThis.process?.versions?.node && "renderer" != globalThis.process?.type, da = !ba && !h && !ca;
if (h) {
  const {createRequire:a} = await import("node:module");
  var require = a(import.meta.url);
}
var ea = (a, b) => {
  throw b;
}, fa = import.meta.url.slice(), ha = "", ia, ja;
if (h) {
  if (!globalThis.process?.versions?.node || "renderer" == globalThis.process?.type) {
    throw Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
  }
  var fs = require("node:fs");
  fa.startsWith("file:") && (ha = require("node:path").dirname(require("node:url").fileURLToPath(fa)) + "/");
  ja = a => {
    a = k(a) ? new URL(a) : a;
    a = fs.readFileSync(a);
    n(Buffer.isBuffer(a));
    return a;
  };
  ia = async a => {
    a = k(a) ? new URL(a) : a;
    a = fs.readFileSync(a, void 0);
    n(Buffer.isBuffer(a));
    return a;
  };
  process.argv.slice(2);
  ea = (a, b) => {
    process.exitCode = a;
    throw b;
  };
} else if (!da) {
  if (ba || ca) {
    try {
      ha = (new URL(".", fa)).href;
    } catch {
    }
    if (!globalThis.window && !globalThis.WorkerGlobalScope) {
      throw Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
    }
    ca && (ja = a => {
      var b = new XMLHttpRequest();
      b.open("GET", a, !1);
      b.responseType = "arraybuffer";
      b.send(null);
      return new Uint8Array(b.response);
    });
    ia = async a => {
      if (k(a)) {
        return new Promise((c, d) => {
          var e = new XMLHttpRequest();
          e.open("GET", a, !0);
          e.responseType = "arraybuffer";
          e.onload = () => {
            200 == e.status || 0 == e.status && e.response ? c(e.response) : d(e.status);
          };
          e.onerror = d;
          e.send(null);
        });
      }
      var b = await fetch(a, {credentials:"same-origin"});
      if (b.ok) {
        return b.arrayBuffer();
      }
      throw Error(b.status + " : " + b.url);
    };
  } else {
    throw Error("environment detection error");
  }
}
var q = console.log.bind(console), r = console.error.bind(console);
n(!da, "shell environment detected but not enabled at build time.  Add `shell` to `-sENVIRONMENT` to enable.");
var t;
globalThis.WebAssembly || r("no native wasm support detected");
var ka = !1;
function n(a, b) {
  a || v("Assertion failed" + (b ? ": " + b : ""));
}
var k = a => a.startsWith("file://");
function la() {
  var a = ma();
  n(0 == (a & 3));
  0 == a && (a += 4);
  w[a >> 2] = 34821223;
  w[a + 4 >> 2] = 2310721022;
  w[0] = 1668509029;
}
function na() {
  if (!ka) {
    var a = ma();
    0 == a && (a += 4);
    var b = w[a >> 2], c = w[a + 4 >> 2];
    34821223 == b && 2310721022 == c || v(`Stack overflow! Stack cookie has been overwritten at ${A(a)}, expected hex dwords 0x89BACDFE and 0x2135467, but received ${A(c)} ${A(b)}`);
    1668509029 != w[0] && v("Runtime error: The application has corrupted its heap memory area (address zero)!");
  }
}
var oa = new Int16Array(1), pa = new Int8Array(oa.buffer);
oa[0] = 25459;
115 === pa[0] && 99 === pa[1] || v("Runtime error: expected the system to be little-endian! (Run with -sSUPPORT_BIG_ENDIAN to bypass)");
function qa(a) {
  Object.getOwnPropertyDescriptor(g, a) || Object.defineProperty(g, a, {configurable:!0, set() {
    v(`Attempt to set \`Module.${a}\` after it has already been processed.  This can happen, for example, when code is injected via '--post-js' rather than '--pre-js'`);
  }});
}
function B(a) {
  return () => n(!1, `call to '${a}' via reference taken before Wasm module initialization`);
}
function ra(a) {
  Object.getOwnPropertyDescriptor(g, a) || Object.defineProperty(g, a, {configurable:!0, get() {
    var b = `'${a}' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the Emscripten FAQ)`;
    "FS_createPath" !== a && "FS_createDataFile" !== a && "FS_createPreloadedFile" !== a && "FS_preloadFile" !== a && "FS_unlink" !== a && "addRunDependency" !== a && "FS_createLazyFile" !== a && "FS_createDevice" !== a && "removeRunDependency" !== a || (b += ". Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you");
    v(b);
  }});
}
var sa, ta, C, ua, va, wa, w, xa, ya, za, D = !1;
function Aa() {
  var a = Ba.buffer;
  g.HEAP8 = C = new Int8Array(a);
  va = new Int16Array(a);
  ua = new Uint8Array(a);
  new Uint16Array(a);
  wa = new Int32Array(a);
  w = new Uint32Array(a);
  xa = new Float32Array(a);
  ya = new Float64Array(a);
  za = new BigInt64Array(a);
  new BigUint64Array(a);
}
n(globalThis.Int32Array && globalThis.Float64Array && Int32Array.prototype.subarray && Int32Array.prototype.set, "JS engine does not provide full typed array support");
function v(a) {
  g.onAbort?.(a);
  a = "Aborted(" + a + ")";
  r(a);
  ka = !0;
  a = new WebAssembly.RuntimeError(a);
  ta?.(a);
  throw a;
}
function E(a, b) {
  return (...c) => {
    n(D, `native function \`${a}\` called before runtime initialization`);
    var d = G[a];
    n(d, `exported native function \`${a}\` not found`);
    n(c.length <= b, `native function \`${a}\` called with ${c.length} args but expects ${b}`);
    return d(...c);
  };
}
var Ca;
async function Da(a) {
  if (!t) {
    try {
      var b = await ia(a);
      return new Uint8Array(b);
    } catch {
    }
  }
  if (a == Ca && t) {
    a = new Uint8Array(t);
  } else {
    if (ja) {
      a = ja(a);
    } else {
      throw "both async and sync fetching of the wasm failed";
    }
  }
  return a;
}
async function Ea(a, b) {
  try {
    var c = await Da(a);
    return await WebAssembly.instantiate(c, b);
  } catch (d) {
    r(`failed to asynchronously prepare wasm: ${d}`), k(a) && r(`warning: Loading from a file URI (${a}) is not supported in most browsers. See https://emscripten.org/docs/getting_started/FAQ.html#how-do-i-run-a-local-webserver-for-testing-why-does-my-program-stall-in-downloading-or-preparing`), v(d);
  }
}
async function Fa(a) {
  var b = Ca;
  if (!t && !k(b) && !h) {
    try {
      var c = fetch(b, {credentials:"same-origin"});
      return await WebAssembly.instantiateStreaming(c, a);
    } catch (d) {
      r(`wasm streaming compile failed: ${d}`), r("falling back to ArrayBuffer instantiation");
    }
  }
  return Ea(b, a);
}
class Ha {
  name="ExitStatus";
  constructor(a) {
    this.message = `Program terminated with exit(${a})`;
    this.status = a;
  }
}
var Ia = a => {
  for (; 0 < a.length;) {
    a.shift()(g);
  }
}, Ja = [], Ka = [], La = () => {
  var a = g.preRun.shift();
  Ka.push(a);
}, Ma = !0, A = a => {
  n("number" === typeof a, `ptrToString expects a number, got ${typeof a}`);
  return "0x" + (a >>> 0).toString(16).padStart(8, "0");
}, H = a => {
  H.K || (H.K = {});
  H.K[a] || (H.K[a] = 1, h && (a = "warning: " + a), r(a));
}, Na = globalThis.TextDecoder && new TextDecoder(), I = (a, b = 0) => {
  var c = b;
  for (var d = c + void 0; a[c] && !(c >= d);) {
    ++c;
  }
  if (16 < c - b && a.buffer && Na) {
    return Na.decode(a.subarray(b, c));
  }
  for (d = ""; b < c;) {
    var e = a[b++];
    if (e & 128) {
      var f = a[b++] & 63;
      if (192 == (e & 224)) {
        d += String.fromCharCode((e & 31) << 6 | f);
      } else {
        var l = a[b++] & 63;
        224 == (e & 240) ? e = (e & 15) << 12 | f << 6 | l : (240 != (e & 248) && H("Invalid UTF-8 leading byte " + A(e) + " encountered when deserializing a UTF-8 string in wasm memory to a JS string!"), e = (e & 7) << 18 | f << 12 | l << 6 | a[b++] & 63);
        65536 > e ? d += String.fromCharCode(e) : (e -= 65536, d += String.fromCharCode(55296 | e >> 10, 56320 | e & 1023));
      }
    } else {
      d += String.fromCharCode(e);
    }
  }
  return d;
}, J = a => {
  n("number" == typeof a, `UTF8ToString expects a number (got ${typeof a})`);
  return a ? I(ua, a) : "";
}, Oa = (a, b) => {
  for (var c = 0, d = a.length - 1; 0 <= d; d--) {
    var e = a[d];
    "." === e ? a.splice(d, 1) : ".." === e ? (a.splice(d, 1), c++) : c && (a.splice(d, 1), c--);
  }
  if (b) {
    for (; c; c--) {
      a.unshift("..");
    }
  }
  return a;
}, Pa = a => {
  var b = "/" === a.charAt(0), c = "/" === a.slice(-1);
  (a = Oa(a.split("/").filter(d => !!d), !b).join("/")) || b || (a = ".");
  a && c && (a += "/");
  return (b ? "/" : "") + a;
}, Qa = a => {
  var b = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/.exec(a).slice(1);
  a = b[0];
  b = b[1];
  if (!a && !b) {
    return ".";
  }
  b &&= b.slice(0, -1);
  return a + b;
}, Ra = () => {
  if (h) {
    var a = require("node:crypto");
    return b => a.randomFillSync(b);
  }
  return b => crypto.getRandomValues(b);
}, Sa = a => {
  (Sa = Ra())(a);
}, Ta = (...a) => {
  for (var b = "", c = !1, d = a.length - 1; -1 <= d && !c; d--) {
    c = 0 <= d ? a[d] : "/";
    if ("string" != typeof c) {
      throw new TypeError("Arguments to path.resolve must be strings");
    }
    if (!c) {
      return "";
    }
    b = c + "/" + b;
    c = "/" === c.charAt(0);
  }
  b = Oa(b.split("/").filter(e => !!e), !c).join("/");
  return (c ? "/" : "") + b || ".";
}, Ua = [], Va = [];
function Wa(a, b) {
  Va[a] = {input:[], output:[], B:b};
  Xa(a, Ya);
}
var Ya = {open(a) {
  var b = Va[a.node.rdev];
  if (!b) {
    throw new K(43);
  }
  a.tty = b;
  a.seekable = !1;
}, close(a) {
  a.tty.B.fsync(a.tty);
}, fsync(a) {
  a.tty.B.fsync(a.tty);
}, read(a, b, c, d) {
  if (!a.tty || !a.tty.B.M) {
    throw new K(60);
  }
  for (var e = 0, f = 0; f < d; f++) {
    try {
      var l = a.tty.B.M(a.tty);
    } catch (m) {
      throw new K(29);
    }
    if (void 0 === l && 0 === e) {
      throw new K(6);
    }
    if (null === l || void 0 === l) {
      break;
    }
    e++;
    b[c + f] = l;
  }
  e && (a.node.atime = Date.now());
  return e;
}, write(a, b, c, d) {
  if (!a.tty || !a.tty.B.J) {
    throw new K(60);
  }
  try {
    for (var e = 0; e < d; e++) {
      a.tty.B.J(a.tty, b[c + e]);
    }
  } catch (f) {
    throw new K(29);
  }
  d && (a.node.mtime = a.node.ctime = Date.now());
  return e;
}}, Za = {M() {
  a: {
    if (!Ua.length) {
      var a = null;
      if (h) {
        var b = Buffer.alloc(256);
        var c = 0, d = process.stdin.fd;
        try {
          c = fs.readSync(d, b, 0, 256);
        } catch (m) {
          if (m.toString().includes("EOF")) {
            c = 0;
          } else {
            throw m;
          }
        }
        0 < c && (a = b.slice(0, c).toString("utf-8"));
      } else {
        globalThis.window?.prompt && (a = window.prompt("Input: "), null !== a && (a += "\n"));
      }
      if (!a) {
        b = null;
        break a;
      }
      for (c = b = 0; c < a.length; ++c) {
        d = a.charCodeAt(c), 127 >= d ? b++ : 2047 >= d ? b += 2 : 55296 <= d && 57343 >= d ? (b += 4, ++c) : b += 3;
      }
      b = Array(b + 1);
      var e = b.length;
      c = 0;
      n("string" === typeof a, `stringToUTF8Array expects a string (got ${typeof a})`);
      if (0 < e) {
        d = c;
        e = c + e - 1;
        for (var f = 0; f < a.length; ++f) {
          var l = a.codePointAt(f);
          if (127 >= l) {
            if (c >= e) {
              break;
            }
            b[c++] = l;
          } else if (2047 >= l) {
            if (c + 1 >= e) {
              break;
            }
            b[c++] = 192 | l >> 6;
            b[c++] = 128 | l & 63;
          } else if (65535 >= l) {
            if (c + 2 >= e) {
              break;
            }
            b[c++] = 224 | l >> 12;
            b[c++] = 128 | l >> 6 & 63;
            b[c++] = 128 | l & 63;
          } else {
            if (c + 3 >= e) {
              break;
            }
            1114111 < l && H("Invalid Unicode code point " + A(l) + " encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF).");
            b[c++] = 240 | l >> 18;
            b[c++] = 128 | l >> 12 & 63;
            b[c++] = 128 | l >> 6 & 63;
            b[c++] = 128 | l & 63;
            f++;
          }
        }
        b[c] = 0;
        a = c - d;
      } else {
        a = 0;
      }
      b.length = a;
      Ua = b;
    }
    b = Ua.shift();
  }
  return b;
}, J(a, b) {
  null === b || 10 === b ? (q(I(a.output)), a.output = []) : 0 != b && a.output.push(b);
}, fsync(a) {
  0 < a.output?.length && (q(I(a.output)), a.output = []);
}, ha() {
  return {ba:25856, ea:5, aa:191, da:35387, $:[3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]};
}, ia() {
  return 0;
}, ja() {
  return [24, 80];
}}, $a = {J(a, b) {
  null === b || 10 === b ? (r(I(a.output)), a.output = []) : 0 != b && a.output.push(b);
}, fsync(a) {
  0 < a.output?.length && (r(I(a.output)), a.output = []);
}}, L = {m:null, s() {
  return L.createNode(null, "/", 16895, 0);
}, createNode(a, b, c, d) {
  if (24576 === (c & 61440) || 4096 === (c & 61440)) {
    throw new K(63);
  }
  L.m || (L.m = {dir:{node:{u:L.h.u, o:L.h.o, lookup:L.h.lookup, F:L.h.F, rename:L.h.rename, unlink:L.h.unlink, rmdir:L.h.rmdir, readdir:L.h.readdir, symlink:L.h.symlink}, stream:{l:L.i.l}}, file:{node:{u:L.h.u, o:L.h.o}, stream:{l:L.i.l, read:L.i.read, write:L.i.write, O:L.i.O, R:L.i.R}}, link:{node:{u:L.h.u, o:L.h.o, readlink:L.h.readlink}, stream:{}}, L:{node:{u:L.h.u, o:L.h.o}, stream:ab}});
  c = bb(a, b, c, d);
  16384 === (c.mode & 61440) ? (c.h = L.m.dir.node, c.i = L.m.dir.stream, c.g = {}) : 32768 === (c.mode & 61440) ? (c.h = L.m.file.node, c.i = L.m.file.stream, c.j = 0, c.g = null) : 40960 === (c.mode & 61440) ? (c.h = L.m.link.node, c.i = L.m.link.stream) : 8192 === (c.mode & 61440) && (c.h = L.m.L.node, c.i = L.m.L.stream);
  c.atime = c.mtime = c.ctime = Date.now();
  a && (a.g[b] = c, a.atime = a.mtime = a.ctime = c.atime);
  return c;
}, ga(a) {
  return a.g ? a.g.subarray ? a.g.subarray(0, a.j) : new Uint8Array(a.g) : new Uint8Array(0);
}, h:{u(a) {
  var b = {};
  b.dev = 8192 === (a.mode & 61440) ? a.id : 1;
  b.ino = a.id;
  b.mode = a.mode;
  b.nlink = 1;
  b.uid = 0;
  b.gid = 0;
  b.rdev = a.rdev;
  16384 === (a.mode & 61440) ? b.size = 4096 : 32768 === (a.mode & 61440) ? b.size = a.j : 40960 === (a.mode & 61440) ? b.size = a.link.length : b.size = 0;
  b.atime = new Date(a.atime);
  b.mtime = new Date(a.mtime);
  b.ctime = new Date(a.ctime);
  b.blksize = 4096;
  b.blocks = Math.ceil(b.size / b.blksize);
  return b;
}, o(a, b) {
  for (var c of ["mode", "atime", "mtime", "ctime"]) {
    null != b[c] && (a[c] = b[c]);
  }
  void 0 !== b.size && (b = b.size, a.j != b && (0 == b ? (a.g = null, a.j = 0) : (c = a.g, a.g = new Uint8Array(b), c && a.g.set(c.subarray(0, Math.min(b, a.j))), a.j = b)));
}, lookup() {
  throw new K(44);
}, F(a, b, c, d) {
  return L.createNode(a, b, c, d);
}, rename(a, b, c) {
  try {
    var d = cb(b, c);
  } catch (f) {
  }
  if (d) {
    if (16384 === (a.mode & 61440)) {
      for (var e in d.g) {
        throw new K(55);
      }
    }
    e = db(d.parent.id, d.name);
    if (N[e] === d) {
      N[e] = d.A;
    } else {
      for (e = N[e]; e;) {
        if (e.A === d) {
          e.A = d.A;
          break;
        }
        e = e.A;
      }
    }
  }
  delete a.parent.g[a.name];
  b.g[c] = a;
  a.name = c;
  b.ctime = b.mtime = a.parent.ctime = a.parent.mtime = Date.now();
}, unlink(a, b) {
  delete a.g[b];
  a.ctime = a.mtime = Date.now();
}, rmdir(a, b) {
  var c = cb(a, b), d;
  for (d in c.g) {
    throw new K(55);
  }
  delete a.g[b];
  a.ctime = a.mtime = Date.now();
}, readdir(a) {
  return [".", "..", ...Object.keys(a.g)];
}, symlink(a, b, c) {
  a = L.createNode(a, b, 41471, 0);
  a.link = c;
  return a;
}, readlink(a) {
  if (40960 !== (a.mode & 61440)) {
    throw new K(28);
  }
  return a.link;
}}, i:{read(a, b, c, d, e) {
  var f = a.node.g;
  if (e >= a.node.j) {
    return 0;
  }
  a = Math.min(a.node.j - e, d);
  n(0 <= a);
  if (8 < a && f.subarray) {
    b.set(f.subarray(e, e + a), c);
  } else {
    for (d = 0; d < a; d++) {
      b[c + d] = f[e + d];
    }
  }
  return a;
}, write(a, b, c, d, e, f) {
  n(!(b instanceof ArrayBuffer));
  b.buffer === C.buffer && (f = !1);
  if (!d) {
    return 0;
  }
  a = a.node;
  a.mtime = a.ctime = Date.now();
  if (b.subarray && (!a.g || a.g.subarray)) {
    if (f) {
      return n(0 === e, "canOwn must imply no weird position inside the file"), a.g = b.subarray(c, c + d), a.j = d;
    }
    if (0 === a.j && 0 === e) {
      return a.g = b.slice(c, c + d), a.j = d;
    }
    if (e + d <= a.j) {
      return a.g.set(b.subarray(c, c + d), e), d;
    }
  }
  f = e + d;
  var l = a.g ? a.g.length : 0;
  l >= f || (f = Math.max(f, l * (1048576 > l ? 2.0 : 1.125) >>> 0), 0 != l && (f = Math.max(f, 256)), l = a.g, a.g = new Uint8Array(f), 0 < a.j && a.g.set(l.subarray(0, a.j), 0));
  if (a.g.subarray && b.subarray) {
    a.g.set(b.subarray(c, c + d), e);
  } else {
    for (f = 0; f < d; f++) {
      a.g[e + f] = b[c + f];
    }
  }
  a.j = Math.max(a.j, e + d);
  return d;
}, l(a, b, c) {
  1 === c ? b += a.position : 2 === c && 32768 === (a.node.mode & 61440) && (b += a.node.j);
  if (0 > b) {
    throw new K(28);
  }
  return b;
}, O(a, b, c, d, e) {
  if (32768 !== (a.node.mode & 61440)) {
    throw new K(43);
  }
  a = a.node.g;
  if (e & 2 || !a || a.buffer !== C.buffer) {
    d = !0;
    v("internal error: mmapAlloc called but `emscripten_builtin_memalign` native symbol not exported");
    e = void 0;
    if (!e) {
      throw new K(48);
    }
    if (a) {
      if (0 < c || c + b < a.length) {
        a.subarray ? a = a.subarray(c, c + b) : a = Array.prototype.slice.call(a, c, c + b);
      }
      C.set(a, e);
    }
  } else {
    d = !1, e = a.byteOffset;
  }
  return {la:e, Z:d};
}, R(a, b, c, d) {
  L.i.write(a, b, 0, d, c, !1);
  return 0;
}}}, eb = (a, b) => {
  var c = 0;
  a && (c |= 365);
  b && (c |= 146);
  return c;
}, fb = {EPERM:63, ENOENT:44, ESRCH:71, EINTR:27, EIO:29, ENXIO:60, E2BIG:1, ENOEXEC:45, EBADF:8, ECHILD:12, EAGAIN:6, EWOULDBLOCK:6, ENOMEM:48, EACCES:2, EFAULT:21, ENOTBLK:105, EBUSY:10, EEXIST:20, EXDEV:75, ENODEV:43, ENOTDIR:54, EISDIR:31, EINVAL:28, ENFILE:41, EMFILE:33, ENOTTY:59, ETXTBSY:74, EFBIG:22, ENOSPC:51, ESPIPE:70, EROFS:69, EMLINK:34, EPIPE:64, EDOM:18, ERANGE:68, ENOMSG:49, EIDRM:24, ECHRNG:106, EL2NSYNC:156, EL3HLT:107, EL3RST:108, ELNRNG:109, EUNATCH:110, ENOCSI:111, EL2HLT:112, 
EDEADLK:16, ENOLCK:46, EBADE:113, EBADR:114, EXFULL:115, ENOANO:104, EBADRQC:103, EBADSLT:102, EDEADLOCK:16, EBFONT:101, ENOSTR:100, ENODATA:116, ETIME:117, ENOSR:118, ENONET:119, ENOPKG:120, EREMOTE:121, ENOLINK:47, EADV:122, ESRMNT:123, ECOMM:124, EPROTO:65, EMULTIHOP:36, EDOTDOT:125, EBADMSG:9, ENOTUNIQ:126, EBADFD:127, EREMCHG:128, ELIBACC:129, ELIBBAD:130, ELIBSCN:131, ELIBMAX:132, ELIBEXEC:133, ENOSYS:52, ENOTEMPTY:55, ENAMETOOLONG:37, ELOOP:32, EOPNOTSUPP:138, EPFNOSUPPORT:139, ECONNRESET:15, 
ENOBUFS:42, EAFNOSUPPORT:5, EPROTOTYPE:67, ENOTSOCK:57, ENOPROTOOPT:50, ESHUTDOWN:140, ECONNREFUSED:14, EADDRINUSE:3, ECONNABORTED:13, ENETUNREACH:40, ENETDOWN:38, ETIMEDOUT:73, EHOSTDOWN:142, EHOSTUNREACH:23, EINPROGRESS:26, EALREADY:7, EDESTADDRREQ:17, EMSGSIZE:35, EPROTONOSUPPORT:66, ESOCKTNOSUPPORT:137, EADDRNOTAVAIL:4, ENETRESET:39, EISCONN:30, ENOTCONN:53, ETOOMANYREFS:141, EUSERS:136, EDQUOT:19, ESTALE:72, ENOTSUP:138, ENOMEDIUM:148, EILSEQ:25, EOVERFLOW:61, ECANCELED:11, ENOTRECOVERABLE:56, 
EOWNERDEAD:62, ESTRPIPE:135}, gb = null, hb = {}, O = [], ib = 1, N = null, jb = !1, kb = !0, lb = {}, K = class extends Error {
  name="ErrnoError";
  constructor(a) {
    super(D ? J(mb(a)) : "");
    this.v = a;
    for (var b in fb) {
      if (fb[b] === a) {
        this.code = b;
        break;
      }
    }
  }
}, nb = class {
  D={};
  node=null;
  get object() {
    return this.node;
  }
  set object(a) {
    this.node = a;
  }
  get flags() {
    return this.D.flags;
  }
  set flags(a) {
    this.D.flags = a;
  }
  get position() {
    return this.D.position;
  }
  set position(a) {
    this.D.position = a;
  }
}, ob = class {
  h={};
  i={};
  G=null;
  constructor(a, b, c, d) {
    a ||= this;
    this.parent = a;
    this.s = a.s;
    this.id = ib++;
    this.name = b;
    this.mode = c;
    this.rdev = d;
    this.atime = this.mtime = this.ctime = Date.now();
  }
  get read() {
    return 365 === (this.mode & 365);
  }
  set read(a) {
    a ? this.mode |= 365 : this.mode &= -366;
  }
  get write() {
    return 146 === (this.mode & 146);
  }
  set write(a) {
    a ? this.mode |= 146 : this.mode &= -147;
  }
};
function P(a, b = {}) {
  if (!a) {
    throw new K(44);
  }
  b.H ?? (b.H = !0);
  "/" === a.charAt(0) || (a = "//" + a);
  var c = 0;
  a: for (; 40 > c; c++) {
    a = a.split("/").filter(m => !!m);
    for (var d = gb, e = "/", f = 0; f < a.length; f++) {
      var l = f === a.length - 1;
      if (l && b.parent) {
        break;
      }
      if ("." !== a[f]) {
        if (".." === a[f]) {
          if (e = Qa(e), d === d.parent) {
            a = e + "/" + a.slice(f + 1).join("/");
            c--;
            continue a;
          } else {
            d = d.parent;
          }
        } else {
          e = Pa(e + "/" + a[f]);
          try {
            d = cb(d, a[f]);
          } catch (m) {
            if (44 === m?.v && l && b.U) {
              return {path:e};
            }
            throw m;
          }
          !d.G || l && !b.H || (d = d.G.root);
          if (40960 === (d.mode & 61440) && (!l || b.C)) {
            if (!d.h.readlink) {
              throw new K(52);
            }
            d = d.h.readlink(d);
            "/" === d.charAt(0) || (d = Qa(e) + "/" + d);
            a = d + "/" + a.slice(f + 1).join("/");
            continue a;
          }
        }
      }
    }
    return {path:e, node:d};
  }
  throw new K(32);
}
function db(a, b) {
  for (var c = 0, d = 0; d < b.length; d++) {
    c = (c << 5) - c + b.charCodeAt(d) | 0;
  }
  return (a + c >>> 0) % N.length;
}
function cb(a, b) {
  var c = 16384 === (a.mode & 61440) ? (c = pb(a, "x")) ? c : a.h.lookup ? 0 : 2 : 54;
  if (c) {
    throw new K(c);
  }
  for (c = N[db(a.id, b)]; c; c = c.A) {
    var d = c.name;
    if (c.parent.id === a.id && d === b) {
      return c;
    }
  }
  return a.h.lookup(a, b);
}
function bb(a, b, c, d) {
  n("object" == typeof a);
  a = new ob(a, b, c, d);
  b = db(a.parent.id, a.name);
  a.A = N[b];
  return N[b] = a;
}
function qb(a) {
  var b = ["r", "w", "rw"][a & 3];
  a & 512 && (b += "w");
  return b;
}
function pb(a, b) {
  if (kb) {
    return 0;
  }
  if (!b.includes("r") || a.mode & 292) {
    if (b.includes("w") && !(a.mode & 146) || b.includes("x") && !(a.mode & 73)) {
      return 2;
    }
  } else {
    return 2;
  }
  return 0;
}
function rb(a, b) {
  if (16384 !== (a.mode & 61440)) {
    return 54;
  }
  try {
    return cb(a, b), 20;
  } catch (c) {
  }
  return pb(a, "wx");
}
function Q(a) {
  a = O[a];
  if (!a) {
    throw new K(8);
  }
  return a;
}
function sb(a, b) {
  var c = null?.i.o, d = c ? null : a;
  c ??= a.h.o;
  if (!c) {
    throw new K(63);
  }
  c(d, b);
}
var ab = {open(a) {
  a.i = hb[a.node.rdev].i;
  a.i.open?.(a);
}, l() {
  throw new K(70);
}};
function Xa(a, b) {
  hb[a] = {i:b};
}
function tb(a, b) {
  if ("string" == typeof a) {
    throw a;
  }
  var c = "/" === b, d = !b;
  if (c && gb) {
    throw new K(10);
  }
  if (!c && !d) {
    var e = P(b, {H:!1});
    b = e.path;
    e = e.node;
    if (e.G) {
      throw new K(10);
    }
    if (16384 !== (e.mode & 61440)) {
      throw new K(54);
    }
  }
  b = {type:a, ka:{}, P:b, T:[]};
  a = a.s(b);
  a.s = b;
  b.root = a;
  c ? gb = a : e && (e.G = b, e.s && e.s.T.push(b));
}
function ub(a, b, c) {
  var d = P(a, {parent:!0}).node;
  a = a && a.match(/([^\/]+|\/)\/*$/)[1];
  if (!a) {
    throw new K(28);
  }
  if ("." === a || ".." === a) {
    throw new K(20);
  }
  var e = rb(d, a);
  if (e) {
    throw new K(e);
  }
  if (!d.h.F) {
    throw new K(63);
  }
  return d.h.F(d, a, b, c);
}
function R(a) {
  return ub(a, 16895, 0);
}
function vb(a, b, c) {
  "undefined" == typeof c && (c = b, b = 438);
  ub(a, b | 8192, c);
}
function wb(a, b) {
  if (!Ta(a)) {
    throw new K(44);
  }
  var c = P(b, {parent:!0}).node;
  if (!c) {
    throw new K(44);
  }
  b = b && b.match(/([^\/]+|\/)\/*$/)[1];
  var d = rb(c, b);
  if (d) {
    throw new K(d);
  }
  if (!c.h.symlink) {
    throw new K(63);
  }
  c.h.symlink(c, b, a);
}
function xb(a, b, c = 438) {
  if ("" === a) {
    throw new K(44);
  }
  if ("string" == typeof b) {
    var d = {r:0, "r+":2, w:577, "w+":578, a:1089, "a+":1090}[b];
    if ("undefined" == typeof d) {
      throw Error(`Unknown file open mode: ${b}`);
    }
    b = d;
  }
  c = b & 64 ? c & 4095 | 32768 : 0;
  if ("object" == typeof a) {
    d = a;
  } else {
    var e = a.endsWith("/");
    a = P(a, {C:!(b & 131072), U:!0});
    d = a.node;
    a = a.path;
  }
  var f = !1;
  if (b & 64) {
    if (d) {
      if (b & 128) {
        throw new K(20);
      }
    } else {
      if (e) {
        throw new K(31);
      }
      d = ub(a, c | 511, 0);
      f = !0;
    }
  }
  if (!d) {
    throw new K(44);
  }
  8192 === (d.mode & 61440) && (b &= -513);
  if (b & 65536 && 16384 !== (d.mode & 61440)) {
    throw new K(54);
  }
  if (!f && (e = d ? 40960 === (d.mode & 61440) ? 32 : 16384 === (d.mode & 61440) && ("r" !== qb(b) || b & 576) ? 31 : pb(d, qb(b)) : 44)) {
    throw new K(e);
  }
  if (b & 512 && !f) {
    e = d;
    e = "string" == typeof e ? P(e, {C:!0}).node : e;
    if (16384 === (e.mode & 61440)) {
      throw new K(31);
    }
    if (32768 !== (e.mode & 61440)) {
      throw new K(28);
    }
    var l = pb(e, "w");
    if (l) {
      throw new K(l);
    }
    sb(e, {size:0, timestamp:Date.now()});
  }
  b &= -131713;
  a: {
    for (e = d;;) {
      if (e === e.parent) {
        e = e.s.P;
        var m = m ? "/" !== e[e.length - 1] ? `${e}/${m}` : e + m : e;
        break a;
      }
      m = m ? `${e.name}/${m}` : e.name;
      e = e.parent;
    }
  }
  m = {node:d, path:m, flags:b, seekable:!0, position:0, i:d.i, Y:[], error:!1};
  e = -1;
  n(-1 <= e);
  m = Object.assign(new nb(), m);
  if (-1 == e) {
    a: {
      for (e = 0; 4096 >= e; e++) {
        if (!O[e]) {
          break a;
        }
      }
      throw new K(33);
    }
  }
  m.fd = e;
  O[e] = m;
  m.i.open && m.i.open(m);
  f && (c &= 511, d = "string" == typeof d ? P(d, {C:!0}).node : d, sb(d, {mode:c & 4095 | d.mode & -4096, ctime:Date.now(), fa:void 0}));
  !g.logReadFiles || b & 1 || a in lb || (lb[a] = 1);
  return m;
}
function yb(a, b, c) {
  if (null === a.fd) {
    throw new K(8);
  }
  if (!a.seekable || !a.i.l) {
    throw new K(70);
  }
  if (0 != c && 1 != c && 2 != c) {
    throw new K(28);
  }
  a.position = a.i.l(a, b, c);
  a.Y = [];
}
function zb(a) {
  try {
    var b = P(a, {C:!0});
    a = b.path;
  } catch (d) {
  }
  var c = {S:!1, exists:!1, error:0, name:null, path:null, object:null, V:!1, X:null, W:null};
  try {
    b = P(a, {parent:!0}), c.V = !0, c.X = b.path, c.W = b.node, c.name = a && a.match(/([^\/]+|\/)\/*$/)[1], b = P(a, {C:!0}), c.exists = !0, c.path = b.path, c.object = b.node, c.name = b.node.name, c.S = "/" === b.path;
  } catch (d) {
    c.error = d.v;
  }
  return c;
}
function S(a, b, c) {
  a = Pa("/dev/" + a);
  var d = eb(!!b, !!c);
  S.N ?? (S.N = 64);
  var e = S.N++ << 8 | 0;
  Xa(e, {open(f) {
    f.seekable = !1;
  }, close() {
    c?.buffer?.length && c(10);
  }, read(f, l, m, u) {
    for (var p = 0, x = 0; x < u; x++) {
      try {
        var y = b();
      } catch (z) {
        throw new K(29);
      }
      if (void 0 === y && 0 === p) {
        throw new K(6);
      }
      if (null === y || void 0 === y) {
        break;
      }
      p++;
      l[m + x] = y;
    }
    p && (f.node.atime = Date.now());
    return p;
  }, write(f, l, m, u) {
    for (var p = 0; p < u; p++) {
      try {
        c(l[m + p]);
      } catch (x) {
        throw new K(29);
      }
    }
    u && (f.node.mtime = f.node.ctime = Date.now());
    return p;
  }});
  vb(a, d, e);
}
var T = {}, Ab = void 0, Bb = [], U = a => {
  var b = Bb[a];
  b || (Bb[a] = b = Cb.get(a));
  n(Cb.get(a) == b, "JavaScript-side Wasm function table mirror is out of date!");
  return b;
};
N = Array(4096);
tb(L, "/");
R("/tmp");
R("/home");
R("/home/web_user");
(function() {
  R("/dev");
  Xa(259, {read:() => 0, write:(d, e, f, l) => l, l:() => 0});
  vb("/dev/null", 259);
  Wa(1280, Za);
  Wa(1536, $a);
  vb("/dev/tty", 1280);
  vb("/dev/tty1", 1536);
  var a = new Uint8Array(1024), b = 0, c = () => {
    0 === b && (Sa(a), b = a.byteLength);
    return a[--b];
  };
  S("random", c);
  S("urandom", c);
  R("/dev/shm");
  R("/dev/shm/tmp");
})();
(function() {
  R("/proc");
  var a = R("/proc/self");
  R("/proc/self/fd");
  tb({s() {
    var b = bb(a, "fd", 16895, 73);
    b.i = {l:L.i.l};
    b.h = {lookup(c, d) {
      c = +d;
      var e = Q(c);
      c = {parent:null, s:{P:"fake"}, h:{readlink:() => e.path}, id:c + 1};
      return c.parent = c;
    }, readdir() {
      return Array.from(O.entries()).filter(([, c]) => c).map(([c]) => c.toString());
    }};
    return b;
  }}, "/proc/self/fd");
})();
g.noExitRuntime && (Ma = g.noExitRuntime);
g.print && (q = g.print);
g.printErr && (r = g.printErr);
g.wasmBinary && (t = g.wasmBinary);
Object.getOwnPropertyDescriptor(g, "fetchSettings") && v("`Module.fetchSettings` was supplied but `fetchSettings` not included in INCOMING_MODULE_JS_API");
n("undefined" == typeof g.memoryInitializerPrefixURL, "Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead");
n("undefined" == typeof g.pthreadMainPrefixURL, "Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead");
n("undefined" == typeof g.cdInitializerPrefixURL, "Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead");
n("undefined" == typeof g.filePackagePrefixURL, "Module.filePackagePrefixURL option was removed, use Module.locateFile instead");
n("undefined" == typeof g.read, "Module.read option was removed");
n("undefined" == typeof g.readAsync, "Module.readAsync option was removed (modify readAsync in JS)");
n("undefined" == typeof g.readBinary, "Module.readBinary option was removed (modify readBinary in JS)");
n("undefined" == typeof g.setWindowTitle, "Module.setWindowTitle option was removed (modify emscripten_set_window_title in JS)");
n("undefined" == typeof g.TOTAL_MEMORY, "Module.TOTAL_MEMORY has been renamed Module.INITIAL_MEMORY");
n("undefined" == typeof g.ENVIRONMENT, "Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -sENVIRONMENT=web or -sENVIRONMENT=node)");
n("undefined" == typeof g.STACK_SIZE, "STACK_SIZE can no longer be set at runtime.  Use -sSTACK_SIZE at link time");
n("undefined" == typeof g.wasmMemory, "Use of `wasmMemory` detected.  Use -sIMPORTED_MEMORY to define wasmMemory externally");
n("undefined" == typeof g.INITIAL_MEMORY, "Detected runtime INITIAL_MEMORY setting.  Use -sIMPORTED_MEMORY to define wasmMemory dynamically");
if (g.preInit) {
  for ("function" == typeof g.preInit && (g.preInit = [g.preInit]); 0 < g.preInit.length;) {
    g.preInit.shift()();
  }
}
qa("preInit");
g.getValue = function(a, b = "i8") {
  b.endsWith("*") && (b = "*");
  switch(b) {
    case "i1":
      return C[a];
    case "i8":
      return C[a];
    case "i16":
      return va[a >> 1];
    case "i32":
      return wa[a >> 2];
    case "i64":
      return za[a >> 3];
    case "float":
      return xa[a >> 2];
    case "double":
      return ya[a >> 3];
    case "*":
      return w[a >> 2];
    default:
      v(`invalid type for getValue: ${b}`);
  }
};
"writeI53ToI64 writeI53ToI64Clamped writeI53ToI64Signaling writeI53ToU64Clamped writeI53ToU64Signaling readI53FromI64 readI53FromU64 convertI32PairToI53 convertI32PairToI53Checked convertU32PairToI53 stackAlloc getTempRet0 setTempRet0 createNamedFunction zeroMemory withStackSave inetPton4 inetNtop4 inetPton6 inetNtop6 readSockaddr writeSockaddr readEmAsmArgs jstoi_q getExecutableName autoResumeAudioContext getDynCaller dynCall handleException runtimeKeepalivePush runtimeKeepalivePop callUserCallback maybeExit asmjsMangle HandleAllocator addOnInit addOnPostCtor addOnPreMain addOnExit STACK_SIZE STACK_ALIGN POINTER_SIZE ASSERTIONS ccall cwrap convertJsFunctionToWasm getEmptyTableSlot updateTableMap getFunctionAddress addFunction removeFunction stringToUTF8 intArrayToString AsciiToString stringToAscii UTF16ToString stringToUTF16 lengthBytesUTF16 UTF32ToString stringToUTF32 lengthBytesUTF32 stringToNewUTF8 stringToUTF8OnStack writeArrayToMemory registerKeyEventCallback maybeCStringToJsString findEventTarget getBoundingClientRect fillMouseEventData registerMouseEventCallback registerWheelEventCallback registerUiEventCallback registerFocusEventCallback fillDeviceOrientationEventData registerDeviceOrientationEventCallback fillDeviceMotionEventData registerDeviceMotionEventCallback screenOrientation fillOrientationChangeEventData registerOrientationChangeEventCallback fillFullscreenChangeEventData registerFullscreenChangeEventCallback JSEvents_requestFullscreen JSEvents_resizeCanvasForFullscreen registerRestoreOldStyle hideEverythingExceptGivenElement restoreHiddenElements setLetterbox softFullscreenResizeWebGLRenderTarget doRequestFullscreen fillPointerlockChangeEventData registerPointerlockChangeEventCallback registerPointerlockErrorEventCallback requestPointerLock fillVisibilityChangeEventData registerVisibilityChangeEventCallback registerTouchEventCallback fillGamepadEventData registerGamepadEventCallback registerBeforeUnloadEventCallback fillBatteryEventData registerBatteryEventCallback setCanvasElementSize getCanvasElementSize jsStackTrace getCallstack convertPCtoSourceLocation getEnvStrings checkWasiClock wasiRightsToMuslOFlags wasiOFlagsToMuslOFlags safeSetTimeout setImmediateWrapped safeRequestAnimationFrame clearImmediateWrapped registerPostMainLoop registerPreMainLoop getPromise makePromise idsToPromises makePromiseCallback ExceptionInfo findMatchingCatch Browser_asyncPrepareDataCounter isLeapYear ydayFromDate arraySum addDays getSocketFromFD getSocketAddress FS_mkdirTree _setNetworkCallback heapObjectForWebGLType toTypedArrayIndex webgl_enable_ANGLE_instanced_arrays webgl_enable_OES_vertex_array_object webgl_enable_WEBGL_draw_buffers webgl_enable_WEBGL_multi_draw webgl_enable_EXT_polygon_offset_clamp webgl_enable_EXT_clip_control webgl_enable_WEBGL_polygon_mode emscriptenWebGLGet computeUnpackAlignedImageSize colorChannelsInGlTextureFormat emscriptenWebGLGetTexPixelData emscriptenWebGLGetUniform webglGetUniformLocation webglPrepareUniformLocationsBeforeFirstUse webglGetLeftBracePos emscriptenWebGLGetVertexAttrib __glGetActiveAttribOrUniform writeGLArray registerWebGlEventCallback runAndAbortIfError ALLOC_NORMAL ALLOC_STACK allocate writeStringToMemory writeAsciiToMemory allocateUTF8 allocateUTF8OnStack demangle stackTrace getNativeTypeSize".split(" ").forEach(function(a) {
  ra(a);
});
"run out err callMain abort wasmExports HEAPF32 HEAPF64 HEAPU8 HEAP16 HEAPU16 HEAP32 HEAPU32 HEAP64 HEAPU64 writeStackCookie checkStackCookie INT53_MAX INT53_MIN bigintToI53Checked stackSave stackRestore ptrToString exitJS getHeapMax growMemory ENV ERRNO_CODES strError DNS Protocols Sockets timers warnOnce readEmAsmArgsArray keepRuntimeAlive asyncLoad alignMemory mmapAlloc wasmTable wasmMemory getUniqueRunDependency noExitRuntime addRunDependency removeRunDependency addOnPreRun addOnPostRun freeTableIndexes functionsInTableMap setValue PATH PATH_FS UTF8Decoder UTF8ArrayToString UTF8ToString stringToUTF8Array lengthBytesUTF8 intArrayFromString UTF16Decoder JSEvents specialHTMLTargets findCanvasEventTarget currentFullscreenStrategy restoreOldWindowedStyle UNWIND_CACHE ExitStatus doReadv doWritev initRandomFill randomFill emSetImmediate emClearImmediate_deps emClearImmediate promiseMap uncaughtExceptionCount exceptionLast exceptionCaught Browser requestFullscreen requestFullScreen setCanvasSize getUserMedia createContext getPreloadedImageData__data wget MONTH_DAYS_REGULAR MONTH_DAYS_LEAP MONTH_DAYS_REGULAR_CUMULATIVE MONTH_DAYS_LEAP_CUMULATIVE SYSCALLS preloadPlugins FS_createPreloadedFile FS_preloadFile FS_modeStringToFlags FS_getMode FS_stdin_getChar_buffer FS_stdin_getChar FS_unlink FS_createPath FS_createDevice FS_readFile FS FS_root FS_mounts FS_devices FS_streams FS_nextInode FS_nameTable FS_currentPath FS_initialized FS_ignorePermissions FS_filesystems FS_syncFSRequests FS_readFiles FS_lookupPath FS_getPath FS_hashName FS_hashAddNode FS_hashRemoveNode FS_lookupNode FS_createNode FS_destroyNode FS_isRoot FS_isMountpoint FS_isFile FS_isDir FS_isLink FS_isChrdev FS_isBlkdev FS_isFIFO FS_isSocket FS_flagsToPermissionString FS_nodePermissions FS_mayLookup FS_mayCreate FS_mayDelete FS_mayOpen FS_checkOpExists FS_nextfd FS_getStreamChecked FS_getStream FS_createStream FS_closeStream FS_dupStream FS_doSetAttr FS_chrdev_stream_ops FS_major FS_minor FS_makedev FS_registerDevice FS_getDevice FS_getMounts FS_syncfs FS_mount FS_unmount FS_lookup FS_mknod FS_statfs FS_statfsStream FS_statfsNode FS_create FS_mkdir FS_mkdev FS_symlink FS_rename FS_rmdir FS_readdir FS_readlink FS_stat FS_fstat FS_lstat FS_doChmod FS_chmod FS_lchmod FS_fchmod FS_doChown FS_chown FS_lchown FS_fchown FS_doTruncate FS_truncate FS_ftruncate FS_utime FS_open FS_close FS_isClosed FS_llseek FS_read FS_write FS_mmap FS_msync FS_ioctl FS_writeFile FS_cwd FS_chdir FS_createDefaultDirectories FS_createDefaultDevices FS_createSpecialDirectories FS_createStandardStreams FS_staticInit FS_init FS_quit FS_findObject FS_analyzePath FS_createFile FS_createDataFile FS_forceLoadFile FS_createLazyFile FS_absolutePath FS_createFolder FS_createLink FS_joinPath FS_mmapAlloc FS_standardizePath MEMFS TTY PIPEFS SOCKFS tempFixedLengthArray miniTempWebGLFloatBuffers miniTempWebGLIntBuffers GL AL GLUT EGL GLEW IDBStore SDL SDL_gfx print printErr jstoi_s".split(" ").forEach(ra);
g._free = B("_free");
g._malloc = B("_malloc");
g._parse_sql = B("_parse_sql");
g._deparse_sql = B("_deparse_sql");
g._free_parse_result = B("_free_parse_result");
g._free_deparse_result = B("_free_deparse_result");
g._scan_sql = B("_scan_sql");
g._free_scan_result = B("_free_scan_result");
var Db = B("_fflush"), mb = B("_strerror"), ma = B("_emscripten_stack_get_end"), V = B("_setThrew"), Eb = B("_emscripten_stack_init"), W = B("__emscripten_stack_restore"), X = B("_emscripten_stack_get_current"), Ba = B("wasmMemory"), Cb = B("wasmTable"), Ob = {__assert_fail:(a, b, c, d) => v(`Assertion failed: ${J(a)}, at: ` + [b ? J(b) : "unknown filename", c, d ? J(d) : "unknown function"]), __syscall_openat:function(a, b, c, d) {
  Ab = d;
  try {
    b = J(b);
    var e = b;
    if ("/" === e.charAt(0)) {
      b = e;
    } else {
      var f = -100 === a ? "/" : Q(a).path;
      if (0 == e.length) {
        throw new K(44);
      }
      b = f + "/" + e;
    }
    if (d) {
      n(void 0 != Ab);
      var l = wa[+Ab >> 2];
      Ab += 4;
      var m = l;
    } else {
      m = 0;
    }
    return xb(b, c, m).fd;
  } catch (u) {
    if ("undefined" == typeof T || "ErrnoError" !== u.name) {
      throw u;
    }
    return -u.v;
  }
}, _abort_js:() => v("native code called abort()"), _emscripten_throw_longjmp:() => {
  throw Infinity;
}, emscripten_date_now:() => Date.now(), emscripten_get_now:() => performance.now(), emscripten_resize_heap:a => {
  var b = ua.length;
  a >>>= 0;
  n(a > b);
  if (2147483648 < a) {
    return r(`Cannot enlarge memory, requested ${a} bytes, but the limit is ${2147483648} bytes!`), !1;
  }
  for (var c = 1; 4 >= c; c *= 2) {
    var d = b * (1 + 0.2 / c);
    d = Math.min(d, a + 100663296);
    var e = Math, f = e.min;
    d = Math.max(a, d);
    n(65536, "alignment argument is required");
    e = f.call(e, 2147483648, 65536 * Math.ceil(d / 65536));
    a: {
      f = e;
      d = Ba.buffer.byteLength;
      try {
        Ba.grow((f - d + 65535) / 65536 | 0);
        Aa();
        var l = 1;
        break a;
      } catch (m) {
        r(`growMemory: Attempted to grow heap from ${d} bytes to ${f} bytes, but got error: ${m}`);
      }
      l = void 0;
    }
    if (l) {
      return !0;
    }
  }
  r(`Failed to grow the heap from ${b} bytes to ${e} bytes, not enough memory!`);
  return !1;
}, exit:(a, b) => {
  Fb();
  Ma && !b && (b = `program exited (with status: ${a}), but keepRuntimeAlive() is set (counter=${0}) due to an async operation, so halting execution but not exiting the runtime or preventing further async execution (you can use emscripten_force_exit, if you want to force a true shutdown)`, ta?.(b), r(b));
  Ma || (g.onExit?.(a), ka = !0);
  ea(a, new Ha(a));
}, fd_close:function(a) {
  try {
    var b = Q(a);
    if (null === b.fd) {
      throw new K(8);
    }
    b.I && (b.I = null);
    try {
      b.i.close && b.i.close(b);
    } catch (c) {
      throw c;
    } finally {
      O[b.fd] = null;
    }
    b.fd = null;
    return 0;
  } catch (c) {
    if ("undefined" == typeof T || "ErrnoError" !== c.name) {
      throw c;
    }
    return c.v;
  }
}, fd_read:function(a, b, c, d) {
  try {
    a: {
      var e = Q(a);
      a = b;
      for (var f, l = b = 0; l < c; l++) {
        var m = w[a >> 2], u = w[a + 4 >> 2];
        a += 8;
        var p = e, x = m, y = u, z = f, Ga = C;
        n(0 <= x);
        if (0 > y || 0 > z) {
          throw new K(28);
        }
        if (null === p.fd) {
          throw new K(8);
        }
        if (1 === (p.flags & 2097155)) {
          throw new K(8);
        }
        if (16384 === (p.node.mode & 61440)) {
          throw new K(31);
        }
        if (!p.i.read) {
          throw new K(28);
        }
        var Y = "undefined" != typeof z;
        if (!Y) {
          z = p.position;
        } else if (!p.seekable) {
          throw new K(70);
        }
        var Z = p.i.read(p, Ga, x, y, z);
        Y || (p.position += Z);
        var F = Z;
        if (0 > F) {
          var aa = -1;
          break a;
        }
        b += F;
        if (F < u) {
          break;
        }
        "undefined" != typeof f && (f += F);
      }
      aa = b;
    }
    w[d >> 2] = aa;
    return 0;
  } catch (M) {
    if ("undefined" == typeof T || "ErrnoError" !== M.name) {
      throw M;
    }
    return M.v;
  }
}, fd_seek:function(a, b, c, d) {
  b = -9007199254740992 > b || 9007199254740992 < b ? NaN : Number(b);
  try {
    if (isNaN(b)) {
      return 61;
    }
    var e = Q(a);
    yb(e, b, c);
    za[d >> 3] = BigInt(e.position);
    e.I && 0 === b && 0 === c && (e.I = null);
    return 0;
  } catch (f) {
    if ("undefined" == typeof T || "ErrnoError" !== f.name) {
      throw f;
    }
    return f.v;
  }
}, fd_write:function(a, b, c, d) {
  try {
    a: {
      var e = Q(a);
      a = b;
      for (var f, l = b = 0; l < c; l++) {
        var m = w[a >> 2], u = w[a + 4 >> 2];
        a += 8;
        var p = e, x = m, y = u, z = f, Ga = C;
        n(0 <= x);
        if (0 > y || 0 > z) {
          throw new K(28);
        }
        if (null === p.fd) {
          throw new K(8);
        }
        if (0 === (p.flags & 2097155)) {
          throw new K(8);
        }
        if (16384 === (p.node.mode & 61440)) {
          throw new K(31);
        }
        if (!p.i.write) {
          throw new K(28);
        }
        p.seekable && p.flags & 1024 && yb(p, 0, 2);
        var Y = "undefined" != typeof z;
        if (!Y) {
          z = p.position;
        } else if (!p.seekable) {
          throw new K(70);
        }
        var Z = p.i.write(p, Ga, x, y, z, void 0);
        Y || (p.position += Z);
        var F = Z;
        if (0 > F) {
          var aa = -1;
          break a;
        }
        b += F;
        if (F < u) {
          break;
        }
        "undefined" != typeof f && (f += F);
      }
      aa = b;
    }
    w[d >> 2] = aa;
    return 0;
  } catch (M) {
    if ("undefined" == typeof T || "ErrnoError" !== M.name) {
      throw M;
    }
    return M.v;
  }
}, invoke_i:Gb, invoke_ii:Hb, invoke_iii:Ib, invoke_iiii:Jb, invoke_iiiii:Kb, invoke_v:Lb, invoke_vi:Mb, invoke_vii:Nb};
function Gb(a) {
  var b = X();
  try {
    return U(a)();
  } catch (c) {
    W(b);
    if (c !== c + 0) {
      throw c;
    }
    V(1, 0);
  }
}
function Hb(a, b) {
  var c = X();
  try {
    return U(a)(b);
  } catch (d) {
    W(c);
    if (d !== d + 0) {
      throw d;
    }
    V(1, 0);
  }
}
function Mb(a, b) {
  var c = X();
  try {
    U(a)(b);
  } catch (d) {
    W(c);
    if (d !== d + 0) {
      throw d;
    }
    V(1, 0);
  }
}
function Nb(a, b, c) {
  var d = X();
  try {
    U(a)(b, c);
  } catch (e) {
    W(d);
    if (e !== e + 0) {
      throw e;
    }
    V(1, 0);
  }
}
function Lb(a) {
  var b = X();
  try {
    U(a)();
  } catch (c) {
    W(b);
    if (c !== c + 0) {
      throw c;
    }
    V(1, 0);
  }
}
function Ib(a, b, c) {
  var d = X();
  try {
    return U(a)(b, c);
  } catch (e) {
    W(d);
    if (e !== e + 0) {
      throw e;
    }
    V(1, 0);
  }
}
function Kb(a, b, c, d, e) {
  var f = X();
  try {
    return U(a)(b, c, d, e);
  } catch (l) {
    W(f);
    if (l !== l + 0) {
      throw l;
    }
    V(1, 0);
  }
}
function Jb(a, b, c, d) {
  var e = X();
  try {
    return U(a)(b, c, d);
  } catch (f) {
    W(e);
    if (f !== f + 0) {
      throw f;
    }
    V(1, 0);
  }
}
var Pb;
function Fb() {
  var a = q, b = r, c = !1;
  q = r = () => {
    c = !0;
  };
  try {
    Db(0);
    for (var d of ["stdout", "stderr"]) {
      var e = zb("/dev/" + d);
      if (!e) {
        return;
      }
      Va[e.object.rdev]?.output?.length && (c = !0);
    }
  } catch (f) {
  }
  q = a;
  r = b;
  c && H("stdio streams had content in them that was not flushed. you should set EXIT_RUNTIME to 1 (see the Emscripten FAQ), or make sure to emit a newline when you printf etc.");
}
var G;
G = await (async function() {
  function a(d) {
    d = G = d.exports;
    n("undefined" != typeof d.free, "missing Wasm export: free");
    n("undefined" != typeof d.malloc, "missing Wasm export: malloc");
    n("undefined" != typeof d.parse_sql, "missing Wasm export: parse_sql");
    n("undefined" != typeof d.deparse_sql, "missing Wasm export: deparse_sql");
    n("undefined" != typeof d.free_parse_result, "missing Wasm export: free_parse_result");
    n("undefined" != typeof d.free_deparse_result, "missing Wasm export: free_deparse_result");
    n("undefined" != typeof d.scan_sql, "missing Wasm export: scan_sql");
    n("undefined" != typeof d.free_scan_result, "missing Wasm export: free_scan_result");
    n("undefined" != typeof d.fflush, "missing Wasm export: fflush");
    n("undefined" != typeof d.strerror, "missing Wasm export: strerror");
    n("undefined" != typeof d.emscripten_stack_get_end, "missing Wasm export: emscripten_stack_get_end");
    n("undefined" != typeof d.emscripten_stack_get_base, "missing Wasm export: emscripten_stack_get_base");
    n("undefined" != typeof d.setThrew, "missing Wasm export: setThrew");
    n("undefined" != typeof d.emscripten_stack_init, "missing Wasm export: emscripten_stack_init");
    n("undefined" != typeof d.emscripten_stack_get_free, "missing Wasm export: emscripten_stack_get_free");
    n("undefined" != typeof d._emscripten_stack_restore, "missing Wasm export: _emscripten_stack_restore");
    n("undefined" != typeof d._emscripten_stack_alloc, "missing Wasm export: _emscripten_stack_alloc");
    n("undefined" != typeof d.emscripten_stack_get_current, "missing Wasm export: emscripten_stack_get_current");
    n("undefined" != typeof d.memory, "missing Wasm export: memory");
    n("undefined" != typeof d.__indirect_function_table, "missing Wasm export: __indirect_function_table");
    g._free = E("free", 1);
    g._malloc = E("malloc", 1);
    g._parse_sql = E("parse_sql", 1);
    g._deparse_sql = E("deparse_sql", 1);
    g._free_parse_result = E("free_parse_result", 1);
    g._free_deparse_result = E("free_deparse_result", 1);
    g._scan_sql = E("scan_sql", 1);
    g._free_scan_result = E("free_scan_result", 1);
    Db = E("fflush", 1);
    mb = E("strerror", 1);
    ma = d.emscripten_stack_get_end;
    V = E("setThrew", 2);
    Eb = d.emscripten_stack_init;
    W = d._emscripten_stack_restore;
    X = d.emscripten_stack_get_current;
    Ba = d.memory;
    Cb = d.__indirect_function_table;
    Aa();
    return G;
  }
  var b = g, c = {env:Ob, wasi_snapshot_preview1:Ob};
  if (g.instantiateWasm) {
    return new Promise((d, e) => {
      try {
        g.instantiateWasm(c, (f, l) => {
          d(a(f, l));
        });
      } catch (f) {
        r(`Module.instantiateWasm callback failed with error: ${f}`), e(f);
      }
    });
  }
  Ca ??= g.locateFile ? g.locateFile ? g.locateFile("pg-parser.wasm", ha) : ha + "pg-parser.wasm" : (new URL("pg-parser.wasm", import.meta.url)).href;
  return function(d) {
    n(g === b, "the Module object should not be replaced during async compilation - perhaps the order of HTML elements is wrong?");
    b = null;
    return a(d.instance);
  }(await Fa(c));
}());
(function() {
  function a() {
    n(!Pb);
    Pb = !0;
    g.calledRun = !0;
    if (!ka) {
      n(!D);
      D = !0;
      na();
      if (!g.noFSInit && !jb) {
        n(!jb, "FS.init was previously called. If you want to initialize later with custom parameters, remove any earlier calls (note that one is automatically added to the generated code)");
        jb = !0;
        c ??= g.stdin;
        d ??= g.stdout;
        b ??= g.stderr;
        c ? S("stdin", c) : wb("/dev/tty", "/dev/stdin");
        d ? S("stdout", null, d) : wb("/dev/tty", "/dev/stdout");
        b ? S("stderr", null, b) : wb("/dev/tty1", "/dev/stderr");
        var b = xb("/dev/stdin", 0);
        var c = xb("/dev/stdout", 1);
        var d = xb("/dev/stderr", 1);
        n(0 === b.fd, `invalid handle for stdin (${b.fd})`);
        n(1 === c.fd, `invalid handle for stdout (${c.fd})`);
        n(2 === d.fd, `invalid handle for stderr (${d.fd})`);
      }
      G.__wasm_call_ctors();
      kb = !1;
      sa?.(g);
      g.onRuntimeInitialized?.();
      qa("onRuntimeInitialized");
      n(!g._main, 'compiled without a main, but one is present. if you added it from JS, use Module["onRuntimeInitialized"]');
      na();
      if (g.postRun) {
        for ("function" == typeof g.postRun && (g.postRun = [g.postRun]); g.postRun.length;) {
          b = g.postRun.shift(), Ja.push(b);
        }
      }
      qa("postRun");
      Ia(Ja);
    }
  }
  Eb();
  la();
  if (g.preRun) {
    for ("function" == typeof g.preRun && (g.preRun = [g.preRun]); g.preRun.length;) {
      La();
    }
  }
  qa("preRun");
  Ia(Ka);
  g.setStatus ? (g.setStatus("Running..."), setTimeout(() => {
    setTimeout(() => g.setStatus(""), 1);
    a();
  }, 1)) : a();
  na();
})();
D ? moduleRtn = g : moduleRtn = new Promise((a, b) => {
  sa = a;
  ta = b;
});
for (const a of Object.keys(g)) {
  a in moduleArg || Object.defineProperty(moduleArg, a, {configurable:!0, get() {
    v(`Access to module property ('${a}') is no longer possible via the module constructor argument; Instead, use the result of the module constructor.`);
  }});
}
;


  return moduleRtn;
}

// Export using a UMD style export, or ES6 exports if selected
export default PgParserModule;

