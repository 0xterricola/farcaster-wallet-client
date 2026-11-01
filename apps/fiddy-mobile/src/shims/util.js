// Minimal Node-core shim for @farcaster/core's bundled ts-proto helpers.
//
// The generated code does `freeModule.require("util").types` inside a
// try/catch. Under Metro `require` is resolved statically and eagerly, so the
// module has to exist — but that code path is only reachable on Node, so a
// `types` object that honestly reports "nothing here is a Node type" is enough.
const types = {
  isDate: (value) => value instanceof Date,
  isArrayBuffer: (value) => value instanceof ArrayBuffer,
  isAnyArrayBuffer: (value) =>
    value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer),
  isTypedArray: (value) => ArrayBuffer.isView(value) && !(value instanceof DataView),
  isUint8Array: (value) => value instanceof Uint8Array,
  isRegExp: (value) => value instanceof RegExp,
};

module.exports = { types };