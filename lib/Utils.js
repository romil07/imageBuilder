"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullOutstreamStringWritable = exports.getCurrentHumanReadableDate = exports.getCurrentTime = exports.TEMP_DIRECTORY = void 0;
const stream = require("stream");
const os = __importStar(require("os"));
exports.TEMP_DIRECTORY = process.env.RUNNER_TEMP || os.tmpdir();
class Utils {
    static IsEqual(a, b) {
        if (a !== undefined && a != null && b != null && b !== undefined) {
            return a.toLowerCase() == b.toLowerCase();
        }
        return false;
    }
}
exports.default = Utils;
exports.getCurrentTime = () => {
    // TODO: Should this be a human readable date value or Epoch time is fine?
    return new Date().getTime().toString();
};
exports.getCurrentHumanReadableDate = () => {
    var date = new Date();
    return date.getFullYear() + "-" + date.getMonth() + "-" + date.getDate() + " " + date.getHours() + ":" + date.getMinutes() + ":" + date.getSeconds() + ":" + date.getMilliseconds();
};
class NullOutstreamStringWritable extends stream.Writable {
    constructor(options) {
        super(options);
    }
    _write(data, encoding, callback) {
        if (callback) {
            callback();
        }
    }
}
exports.NullOutstreamStringWritable = NullOutstreamStringWritable;
;
