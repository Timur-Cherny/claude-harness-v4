"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { newObj[key] = obj[key]; } } } newObj.default = obj; return newObj; } } function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; } var _class; var _class2; var _class3;// src/errors.ts
var ParseError = (_class = class extends Error {
  __init() {this.name = "ParseError"}
  /**
   * The type of parse error. Possible values are:
   *
   * - `syntax`: A lexical or syntactic error, such as mismatched parentheses,
   *   unterminated quotes, invalid tokens, or incorrect SQL statement structure.
   *   Most SQL errors will fall into this category.
   *
   * - `semantic`: These are rare, but can occur during specific validations like
   *   numeric range checking (e.g., column numbers must be between 1 and 32767
   *   in ALTER INDEX statements).
   *
   * - `unknown`: An unknown error type, typically representing an internal parser error.
   *
   * Note: The vast majority of semantic validation (type checking, schema validation,
   * constraint validation, etc.) happens after parsing and is not represented in these error types.
   */
  
  /**
   * The position of the error in the SQL string.
   * This is a zero-based index, so the first character is at position 0.
   * Points to the character where the error was detected.
   */
  
  constructor(message, { type, position }) {
    super(message);_class.prototype.__init.call(this);;
    this.type = type;
    this.position = position;
  }
}, _class);
var DeparseError = (_class2 = class extends Error {constructor(...args) { super(...args); _class2.prototype.__init2.call(this); }
  __init2() {this.name = "DeparseError"}
}, _class2);
var ScanError = (_class3 = class extends Error {
  __init3() {this.name = "ScanError"}
  /**
   * The type of scan error. Will be `syntax` for lexical errors
   * from the scanner, or `unknown` for unexpected internal errors.
   */
  
  /**
   * The position of the error in the SQL string.
   * This is a zero-based index, so the first character is at position 0.
   */
  
  constructor(message, { type, position }) {
    super(message);_class3.prototype.__init3.call(this);;
    this.type = type;
    this.position = position;
  }
}, _class3);
function getParseErrorType(fileName) {
  switch (fileName) {
    case "scan.l":
      return "syntax";
    case "gram.y":
      return "semantic";
    default:
      return "unknown";
  }
}

// src/constants.ts
var SUPPORTED_VERSIONS = [15, 16, 17];

// src/util.ts
async function unwrapParseResult(result) {
  const resolved = await result;
  if (resolved.error) {
    throw resolved.error;
  }
  return resolved.tree;
}
async function unwrapDeparseResult(result) {
  const resolved = await result;
  if (resolved.error) {
    throw resolved.error;
  }
  return resolved.sql;
}
async function unwrapScanResult(result) {
  const resolved = await result;
  if (resolved.error) {
    throw resolved.error;
  }
  return resolved.tokens;
}
function getSupportedVersions() {
  return SUPPORTED_VERSIONS;
}
function isSupportedVersion(version) {
  return SUPPORTED_VERSIONS.includes(version);
}
function isParseResultVersion(result, version) {
  if (!result.version) {
    return false;
  }
  const versionString = result.version.toString();
  try {
    const majorVersion = parseInt(versionString.slice(0, -4), 10);
    return majorVersion === version;
  } catch (error) {
    return false;
  }
}
function unwrapNode(wrappedNode) {
  const keys = Object.keys(wrappedNode);
  if (keys.length === 0) {
    throw new Error("node has no keys, expected a single key");
  }
  if (keys.length > 1) {
    throw new Error(
      `node has multiple keys, expected a single key: ${keys.join(", ")}`
    );
  }
  const [type] = keys;
  if (!type) {
    throw new Error("node has no keys, expected a single key");
  }
  const node = wrappedNode[type];
  return { type, node };
}

// src/pg-parser.ts
var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder();
var KEYWORD_KINDS = [
  "none",
  "unreserved",
  "col_name",
  "type_func_name",
  "reserved"
];
function readString(heap, ptr) {
  let end = ptr;
  while (heap[end] !== 0) end++;
  return textDecoder.decode(new Uint8Array(heap.buffer, ptr, end - ptr));
}
var PgParser = class {
  
  
  #module;
  /**
   * Creates a new PgParser instance with the given options.
   */
  constructor({ version = 17 } = {}) {
    if (!isSupportedVersion(version)) {
      throw new Error(`unsupported version: ${version}`);
    }
    this.#module = this.#init(version);
    this.ready = this.#module.then();
    this.version = version;
  }
  /**
   * Returns the current WASM heap size in bytes.
   * Useful for detecting memory leaks in tests.
   */
  async getHeapSize() {
    const module = await this.#module;
    return module.HEAP8.length;
  }
  /**
   * Initializes the WASM module.
   */
  async #init(version) {
    const createModule = await this.#loadFactory(version);
    const isNode = typeof process !== "undefined" && !!_optionalChain([process, 'access', _ => _.versions, 'optionalAccess', _2 => _2.node]);
    return await createModule(
      isNode ? {
        locateFile: (path, scriptDirectory) => scriptDirectory + path
      } : void 0
    );
  }
  /**
   * Loads the WASM module factory for the given version.
   *
   * Note we intentionally don't use template strings on a single import
   * statement to avoid bundling issues that occur during static analysis.
   */
  async #loadFactory(version) {
    switch (version) {
      case 15:
        return await Promise.resolve().then(() => _interopRequireWildcard(require("../wasm/15/pg-parser.js"))).then((module) => module.default);
      case 16:
        return await Promise.resolve().then(() => _interopRequireWildcard(require("../wasm/16/pg-parser.js"))).then((module) => module.default);
      case 17:
        return await Promise.resolve().then(() => _interopRequireWildcard(require("../wasm/17/pg-parser.js"))).then((module) => module.default);
      default:
        throw new Error(`unsupported version: ${version}`);
    }
  }
  /**
   * Parses the given SQL string to a Postgres AST.
   */
  async parse(sql) {
    const module = await this.#module;
    const sqlBytes = textEncoder.encode(sql);
    const sqlPtr = module._malloc(sqlBytes.length + 1);
    module.HEAP8.set(sqlBytes, sqlPtr);
    module.HEAP8[sqlPtr + sqlBytes.length] = 0;
    const resultPtr = module._parse_sql(sqlPtr);
    module._free(sqlPtr);
    try {
      return await this.#parsePgQueryParseResult(resultPtr);
    } finally {
      module._free_parse_result(resultPtr);
    }
  }
  /**
   * Parses a PgQueryParseResult struct from a pointer
   */
  async #parsePgQueryParseResult(resultPtr) {
    const module = await this.#module;
    if (!resultPtr) {
      throw new Error("result pointer is null (protobuf to json failed)");
    }
    const parseTreePtr = module.getValue(resultPtr, "i32");
    const stderrBufferPtr = module.getValue(resultPtr + 4, "i32");
    const errorPtr = module.getValue(resultPtr + 8, "i32");
    const tree = parseTreePtr ? JSON.parse(readString(module.HEAP8, parseTreePtr)) : void 0;
    const stderrBuffer = stderrBufferPtr ? readString(module.HEAP8, stderrBufferPtr) : void 0;
    const error = errorPtr ? await this.#parsePgQueryError(errorPtr) : void 0;
    if (error) {
      return {
        tree: void 0,
        error
      };
    }
    if (!parseTreePtr) {
      throw new Error("parse tree is undefined");
    }
    if (!tree) {
      throw new Error("both parse tree and error are undefined");
    }
    return {
      tree,
      error: void 0
    };
  }
  async deparse(parseResult) {
    const module = await this.#module;
    const json = JSON.stringify(parseResult);
    const jsonBytes = textEncoder.encode(json);
    const jsonPtr = module._malloc(jsonBytes.length + 1);
    module.HEAP8.set(jsonBytes, jsonPtr);
    module.HEAP8[jsonPtr + jsonBytes.length] = 0;
    const deparseResultPtr = module._deparse_sql(jsonPtr);
    module._free(jsonPtr);
    if (!deparseResultPtr) {
      throw new Error("deparse failed: null result pointer");
    }
    try {
      const queryPtr = module.getValue(deparseResultPtr, "i32");
      const errorPtr = module.getValue(deparseResultPtr + 4, "i32");
      const error = errorPtr ? await this.#parseDeparseError(errorPtr) : void 0;
      if (error) {
        return {
          sql: void 0,
          error
        };
      }
      const sql = queryPtr ? readString(module.HEAP8, queryPtr) : void 0;
      if (!sql) {
        throw new Error("query is undefined");
      }
      return {
        sql,
        error: void 0
      };
    } finally {
      module._free_deparse_result(deparseResultPtr);
    }
  }
  /**
   * Reads the common fields from a PgQueryError struct pointer.
   *
   * The struct layout (WASM32) is:
   * ```c
   * typedef struct {
   *   char *message;     // offset 0
   *   char *funcname;    // offset 4
   *   char *filename;    // offset 8
   *   int lineno;        // offset 12
   *   int cursorpos;     // offset 16
   *   char *context;     // offset 20
   * } PgQueryError;
   * ```
   */
  async #readPgQueryError(errorPtr) {
    const module = await this.#module;
    const messagePtr = module.getValue(errorPtr, "i32");
    const fileNamePtr = module.getValue(errorPtr + 8, "i32");
    const cursorpos = module.getValue(errorPtr + 16, "i32");
    const message = messagePtr ? readString(module.HEAP8, messagePtr) : "unknown error";
    const fileName = fileNamePtr ? readString(module.HEAP8, fileNamePtr) : void 0;
    const position = cursorpos > 0 ? cursorpos - 1 : 0;
    return { message, fileName, position };
  }
  async #parsePgQueryError(errorPtr) {
    const { message, fileName, position } = await this.#readPgQueryError(errorPtr);
    const type = fileName ? getParseErrorType(fileName) : "unknown";
    return new ParseError(message, { type, position });
  }
  /**
   * Reads a PgQueryError struct from a pointer and returns a DeparseError.
   * Only reads the message field since deparse errors don't have
   * meaningful position or type information.
   */
  async #parseDeparseError(errorPtr) {
    const { message } = await this.#readPgQueryError(errorPtr);
    return new DeparseError(message);
  }
  /**
   * Scans (lexes) the given SQL string into an array of tokens.
   *
   * Each token includes its kind (raw PG token name), the original text,
   * byte offsets, and keyword classification.
   */
  async scan(sql) {
    const module = await this.#module;
    const sqlBytes = textEncoder.encode(sql);
    const sqlPtr = module._malloc(sqlBytes.length + 1);
    module.HEAP8.set(sqlBytes, sqlPtr);
    module.HEAP8[sqlPtr + sqlBytes.length] = 0;
    const resultPtr = module._scan_sql(sqlPtr);
    module._free(sqlPtr);
    if (!resultPtr) {
      throw new Error("scan failed: null result pointer");
    }
    try {
      const nTokens = module.getValue(resultPtr, "i32");
      const tokensPtr = module.getValue(resultPtr + 4, "i32");
      const errorPtr = module.getValue(resultPtr + 8, "i32");
      if (errorPtr) {
        const error = await this.#parseScanError(errorPtr);
        return { tokens: void 0, error };
      }
      const tokens = [];
      for (let i = 0; i < nTokens; i++) {
        const base = tokensPtr + i * 16;
        const start = module.getValue(base, "i32");
        const end = module.getValue(base + 4, "i32");
        const namePtr = module.getValue(base + 8, "i32");
        const kwKind = module.getValue(base + 12, "i32");
        tokens.push({
          kind: readString(module.HEAP8, namePtr),
          text: textDecoder.decode(sqlBytes.slice(start, end)),
          start,
          end,
          keywordKind: _nullishCoalesce(KEYWORD_KINDS[kwKind], () => ( "none"))
        });
      }
      return { tokens, error: void 0 };
    } finally {
      module._free_scan_result(resultPtr);
    }
  }
  async #parseScanError(errorPtr) {
    const { message, fileName, position } = await this.#readPgQueryError(errorPtr);
    const type = fileName ? getParseErrorType(fileName) === "syntax" ? "syntax" : "unknown" : "unknown";
    return new ScanError(message, { type, position });
  }
};












exports.DeparseError = DeparseError; exports.ParseError = ParseError; exports.PgParser = PgParser; exports.ScanError = ScanError; exports.getSupportedVersions = getSupportedVersions; exports.isParseResultVersion = isParseResultVersion; exports.isSupportedVersion = isSupportedVersion; exports.unwrapDeparseResult = unwrapDeparseResult; exports.unwrapNode = unwrapNode; exports.unwrapParseResult = unwrapParseResult; exports.unwrapScanResult = unwrapScanResult;
//# sourceMappingURL=index.cjs.map