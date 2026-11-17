import { parseArgs as parseNodeArgs } from "node:util";

const DEFAULT_ARGS = {
  requestCount: 10,
  timeoutMs: 60_000,
};

/**
 * @typedef {Object} Args
 * @property {string} url
 * @property {number} requestCount
 * @property {number} timeoutMs
 */
/**
 * @param {string[]} [args]
 * @returns {Args}
 */
export function parseArgs(args = process.argv.slice(2)) {
  const { values, positionals } = parseNodeArgs({
    args,
    options: {
      "request-count": {
        type: "string",
        default: String(DEFAULT_ARGS.requestCount),
      },
      "timeout-ms": {
        type: "string",
        default: String(DEFAULT_ARGS.timeoutMs),
      },
    },
    allowPositionals: true,
    strict: true,
  });

  const [url] = positionals;

  if (!url) {
    throw new Error("URL is required");
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("URL must use the http or https protocol");
  }

  const requestCount = Number(values["request-count"]);
  const timeoutMs = Number(values["timeout-ms"]);

  if (!Number.isSafeInteger(requestCount) || requestCount <= 0) {
    throw new Error("request-count must be a positive integer");
  }

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeout-ms must be a positive integer");
  }

  return {
    url: parsedUrl.toString(),
    requestCount,
    timeoutMs,
  };
}
