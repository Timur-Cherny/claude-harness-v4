import { ParseResult15, Node15 } from './types/15.cjs';
import { ParseResult16, Node16 } from './types/16.cjs';
import { ParseResult17, Node17 } from './types/17.cjs';
import '../wasm/15/pg-parser-types.js';
import '../wasm/15/pg-parser-enums.js';
import '../wasm/16/pg-parser-types.js';
import '../wasm/16/pg-parser-enums.js';
import '../wasm/17/pg-parser-types.js';
import '../wasm/17/pg-parser-enums.js';

type ParseErrorType = 'syntax' | 'semantic' | 'unknown';
type ParseErrorDetails = {
    type: ParseErrorType;
    position: number;
};
declare class ParseError extends Error {
    readonly name = "ParseError";
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
    type: ParseErrorType;
    /**
     * The position of the error in the SQL string.
     * This is a zero-based index, so the first character is at position 0.
     * Points to the character where the error was detected.
     */
    position: number;
    constructor(message: string, { type, position }: ParseErrorDetails);
}
/**
 * An error that occurred while deparsing an AST back to SQL.
 *
 * Unlike `ParseError`, deparse errors don't have a position or type
 * since they operate on an AST rather than a SQL string.
 */
declare class DeparseError extends Error {
    readonly name = "DeparseError";
}
type ScanErrorType = 'syntax' | 'unknown';
type ScanErrorDetails = {
    type: ScanErrorType;
    position: number;
};
/**
 * An error that occurred while scanning/lexing a SQL string.
 *
 * Scan errors are always lexical in nature (e.g. unterminated string
 * literals, invalid escape sequences).
 */
declare class ScanError extends Error {
    readonly name = "ScanError";
    /**
     * The type of scan error. Will be `syntax` for lexical errors
     * from the scanner, or `unknown` for unexpected internal errors.
     */
    type: ScanErrorType;
    /**
     * The position of the error in the SQL string.
     * This is a zero-based index, so the first character is at position 0.
     */
    position: number;
    constructor(message: string, { type, position }: ScanErrorDetails);
}

declare const SUPPORTED_VERSIONS: readonly [15, 16, 17];

type SupportedVersion = (typeof SUPPORTED_VERSIONS)[number];
type ParseResultVersionMap = {
    15: ParseResult15;
    16: ParseResult16;
    17: ParseResult17;
};
type NodeVersionMap = {
    15: Node15;
    16: Node16;
    17: Node17;
};
type ParseResult<T extends SupportedVersion = SupportedVersion> = ParseResultVersionMap[T];
type Node<Version extends SupportedVersion = SupportedVersion> = NodeVersionMap[Version];
type WrappedParseSuccess<Version extends SupportedVersion> = {
    tree: ParseResult<Version>;
    error: undefined;
};
type WrappedParseError = {
    tree: undefined;
    error: ParseError;
};
type WrappedParseResult<Version extends SupportedVersion> = WrappedParseSuccess<Version> | WrappedParseError;
type WrappedDeparseSuccess = {
    sql: string;
    error: undefined;
};
type WrappedDeparseError = {
    sql: undefined;
    error: DeparseError;
};
type WrappedDeparseResult = WrappedDeparseSuccess | WrappedDeparseError;
type KeywordKind = 'none' | 'unreserved' | 'col_name' | 'type_func_name' | 'reserved';
interface ScanToken {
    /** Token kind — raw PG token name (e.g. 'SELECT', 'IDENT', 'ASCII_40', 'NOT_EQUALS') */
    kind: string;
    /** The actual text of the token from the SQL input */
    text: string;
    /** Start byte offset in the input (0-based, inclusive) */
    start: number;
    /** End byte offset in the input (exclusive) */
    end: number;
    /** Keyword classification */
    keywordKind: KeywordKind;
}
type WrappedScanSuccess = {
    tokens: ScanToken[];
    error: undefined;
};
type WrappedScanError = {
    tokens: undefined;
    error: ScanError;
};
type WrappedScanResult = WrappedScanSuccess | WrappedScanError;

type PgParserOptions<Version extends SupportedVersion> = {
    version?: Version | number;
};
declare class PgParser<Version extends SupportedVersion = 17> {
    #private;
    readonly ready: Promise<void>;
    readonly version: Version;
    /**
     * Creates a new PgParser instance with the given options.
     */
    constructor({ version }?: PgParserOptions<Version>);
    /**
     * Returns the current WASM heap size in bytes.
     * Useful for detecting memory leaks in tests.
     */
    getHeapSize(): Promise<number>;
    /**
     * Parses the given SQL string to a Postgres AST.
     */
    parse(sql: string): Promise<WrappedParseResult<Version>>;
    deparse(parseResult: ParseResult<Version>): Promise<WrappedDeparseResult>;
    /**
     * Scans (lexes) the given SQL string into an array of tokens.
     *
     * Each token includes its kind (raw PG token name), the original text,
     * byte offsets, and keyword classification.
     */
    scan(sql: string): Promise<WrappedScanResult>;
}

/**
 * Unwraps a Node into its type and value.
 */
type UnwrappedNode<T extends Node> = T extends Record<infer K, infer V> ? {
    type: K;
    node: V;
} : never;
/**
 * Unwraps a `WrappedParseResult` by throwing an error if the result
 * contains an `error`, or otherwise returning the parsed `tree`.
 *
 * Supports both synchronous and asynchronous results.
 */
declare function unwrapParseResult<Version extends SupportedVersion>(result: WrappedParseResult<Version> | Promise<WrappedParseResult<Version>>): Promise<ParseResult<Version>>;
/**
 * Unwraps a `WrappedDeparseResult` by throwing an error if the result
 * contains an `error`, or otherwise returning the deparsed SQL string.
 *
 * Supports both synchronous and asynchronous results.
 */
declare function unwrapDeparseResult(result: WrappedDeparseResult | Promise<WrappedDeparseResult>): Promise<string>;
/**
 * Unwraps a `WrappedScanResult` by throwing an error if the result
 * contains an `error`, or otherwise returning the scanned tokens.
 *
 * Supports both synchronous and asynchronous results.
 */
declare function unwrapScanResult(result: WrappedScanResult | Promise<WrappedScanResult>): Promise<ScanToken[]>;
/**
 * Gets a list of supported Postgres versions.
 */
declare function getSupportedVersions(): readonly [15, 16, 17];
/**
 * Type guard to check if the major Postgres version is supported.
 */
declare function isSupportedVersion(version: number): version is SupportedVersion;
/**
 * Type guard to check if the `ParseResult` is of a specific version.
 */
declare function isParseResultVersion<Version extends SupportedVersion>(result: ParseResult, version: Version): result is ParseResult<Version>;
/**
 * Unwraps a `Node` to get its type and underlying value.
 *
 * Unwrapping makes it easier to work with nodes
 * by allowing you to narrow them based on their type.
 *
 * @example
 * const tree = await unwrapParseResult(parser.parse('SELECT 1'));
 * const firstStmt = tree.stmts.[0].stmt;
 * const { type, node } = unwrapNode(firstStmt);
 *
 * switch (type) {
 *  case 'SelectStmt':
 *    // Now `node` is narrowed to `SelectStmt`
 *    break;
 * }
 */
declare function unwrapNode<T extends Node>(wrappedNode: T): UnwrappedNode<T>;

export { DeparseError, type KeywordKind, ParseError, type ParseErrorDetails, type ParseErrorType, type ParseResult, PgParser, type PgParserOptions, ScanError, type ScanErrorDetails, type ScanErrorType, type ScanToken, type SupportedVersion, type WrappedDeparseError, type WrappedDeparseResult, type WrappedDeparseSuccess, type WrappedParseError, type WrappedParseResult, type WrappedParseSuccess, type WrappedScanError, type WrappedScanResult, type WrappedScanSuccess, getSupportedVersions, isParseResultVersion, isSupportedVersion, unwrapDeparseResult, unwrapNode, unwrapParseResult, unwrapScanResult };
