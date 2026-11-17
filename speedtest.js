import http from "node:http";
import https from "node:https";

const BYTES_PER_MIB = 1024 ** 2;
const BITS_PER_MEGABIT = 1_000_000;
const MAX_REDIRECTS = 10;
const REQUEST_HEADERS = Object.freeze({
  Accept: "*/*",
  "Accept-Encoding": "identity",
  "Cache-Control": "no-cache, no-store, max-age=0",
  Pragma: "no-cache",
  "User-Agent": "speedtest-cli/1.0",
});

/**
 * @typedef {import("./args.js").Args} Args
 */

/**
 * @typedef {Object} MetricsInput
 * @property {number} requestCount
 * @property {number} totalBytes
 * @property {number} totalDurationMs Sum of the full per-request durations.
 * @property {number} [totalBodyDurationMs] Sum of the body-transfer durations.
 * @property {number} [totalTtfbMs] Sum of the time-to-first-byte values.
 */

/**
 * Derives the download statistics from the raw measurements.
 *
 * `averageDurationMs` is the average wall-clock time of one request.
 * `averageMbitPerSecond` is the end-to-end throughput: total bits divided by
 * the total wall-clock time of all requests (not the average of per-request
 * speeds). `averageTransferMbitPerSecond` excludes the wait before the first
 * body byte, so it is closer to the actual transfer rate of the connection.
 *
 * Download speed is always reported in megabits per second. The downloaded
 * volume is the number of body bytes received from the socket, reported in MiB.
 *
 * @param {MetricsInput} input
 */
export function calculateMetrics({
  requestCount,
  totalBytes,
  totalDurationMs,
  totalBodyDurationMs = 0,
  totalTtfbMs = 0,
}) {
  if (!Number.isFinite(requestCount) || requestCount <= 0) {
    throw new Error("requestCount must be a positive number");
  }

  const totalDownloadedMib = totalBytes / BYTES_PER_MIB;
  const averageDurationMs = totalDurationMs / requestCount;
  const averageTtfbMs = totalTtfbMs / requestCount;
  const totalDurationSeconds = totalDurationMs / 1000;
  const totalBodyDurationSeconds = totalBodyDurationMs / 1000;

  const averageMbitPerSecond =
    totalDurationSeconds > 0
      ? (totalBytes * 8) / BITS_PER_MEGABIT / totalDurationSeconds
      : 0;
  const averageTransferMbitPerSecond =
    totalBodyDurationSeconds > 0
      ? (totalBytes * 8) / BITS_PER_MEGABIT / totalBodyDurationSeconds
      : 0;

  return {
    requestCount,
    totalBytes,
    totalDownloadedMib,
    totalDurationMs,
    totalBodyDurationMs,
    totalTtfbMs,
    averageDurationMs,
    averageTtfbMs,
    averageMbitPerSecond,
    averageTransferMbitPerSecond,
  };
}

/**
 * @param {Args} args
 */
export async function speedtest({ url, requestCount, timeoutMs }) {
  const agents = {
    "http:": new http.Agent({ keepAlive: true }),
    "https:": new https.Agent({ keepAlive: true }),
  };

  let totalBytes = 0;
  let totalDurationMs = 0;
  let totalBodyDurationMs = 0;
  let totalTtfbMs = 0;

  try {
    for (let i = 0; i < requestCount; i++) {
      const startedAt = performance.now();
      let measurement;

      try {
        measurement = await measureRequest(url, timeoutMs, agents);
      } catch (error) {
        throw requestError(error, i, timeoutMs);
      }

      if (measurement.statusCode < 200 || measurement.statusCode >= 300) {
        throw new Error(
          `Request ${i + 1}: HTTP ${measurement.statusCode} ` +
            `${measurement.statusMessage} for ${url}`,
        );
      }

      const endedAt = measurement.endedAt;
      const durationMs = endedAt - startedAt;
      const ttfbMs =
        (measurement.firstByteAt ?? measurement.responseAt) - startedAt;
      const bodyDurationMs =
        measurement.firstByteAt === undefined
          ? 0
          : endedAt - measurement.firstByteAt;
      const requestMbitPerSecond =
        durationMs > 0
          ? (measurement.downloadedBytes * 8) /
            BITS_PER_MEGABIT /
            (durationMs / 1000)
          : 0;
      const encoding =
        measurement.contentEncoding &&
        measurement.contentEncoding !== "identity"
          ? ` [${measurement.contentEncoding}]`
          : "";

      totalBytes += measurement.downloadedBytes;
      totalDurationMs += durationMs;
      totalBodyDurationMs += bodyDurationMs;
      totalTtfbMs += ttfbMs;

      console.log(
        `[${i + 1}/${requestCount}] ` +
          `${durationMs.toFixed(2)} ms | ` +
          `${(measurement.downloadedBytes / BYTES_PER_MIB).toFixed(2)} MiB` +
          `${encoding} | ` +
          `${requestMbitPerSecond.toFixed(1)} Mbit/s | ` +
          `TTFB ${ttfbMs.toFixed(2)} ms`,
      );
    }
  } finally {
    agents["http:"].destroy();
    agents["https:"].destroy();
  }

  return {
    url,
    ...calculateMetrics({
      requestCount,
      totalBytes,
      totalDurationMs,
      totalBodyDurationMs,
      totalTtfbMs,
    }),
  };
}

/**
 * Follows redirects and returns the final response measurement.
 *
 * @param {string} initialUrl
 * @param {number} timeoutMs
 * @param {{ "http:": http.Agent, "https:": https.Agent }} agents
 */
async function measureRequest(initialUrl, timeoutMs, agents) {
  let currentUrl = new URL(initialUrl);

  for (let redirectCount = 0; ; redirectCount++) {
    const result = await requestOnce(currentUrl, timeoutMs, agents);

    if (result.location === undefined) {
      return result;
    }

    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects for ${initialUrl}`);
    }

    let nextUrl;

    try {
      nextUrl = new URL(result.location, currentUrl);
    } catch {
      throw new Error(`Invalid redirect location: ${result.location}`);
    }

    if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
      throw new Error(`Redirect to unsupported protocol: ${nextUrl.protocol}`);
    }

    currentUrl = nextUrl;
  }
}

/**
 * @typedef {Object} RequestMeasurement
 * @property {number} statusCode
 * @property {string} statusMessage
 * @property {number} responseAt
 * @property {number | undefined} firstByteAt
 * @property {number} endedAt
 * @property {number} downloadedBytes
 * @property {string | undefined} contentEncoding
 * @property {string} [location]
 */

/**
 * Performs one raw HTTP request. The response body is not decoded, so
 * `downloadedBytes` is the number of bytes actually received from the socket.
 *
 * @param {URL} url
 * @param {number} timeoutMs
 * @param {{ "http:": http.Agent, "https:": https.Agent }} agents
 * @returns {Promise<RequestMeasurement>}
 */
function requestOnce(url, timeoutMs, agents) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const agent = isHttps ? agents["https:"] : agents["http:"];

    let timedOut = false;
    let settled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    /**
     * @param {(value: RequestMeasurement) => void} callback
     * @param {RequestMeasurement} value
     */
    const succeed = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    /**
     * @param {unknown} error
     */
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        const timeoutError = new Error(`timed out after ${timeoutMs} ms`);
        timeoutError.name = "TimeoutError";
        reject(timeoutError);
        return;
      }

      reject(error);
    };

    const request = transport.request(
      url,
      {
        method: "GET",
        agent,
        headers: REQUEST_HEADERS,
        signal: controller.signal,
      },
      (response) => {
        const responseAt = performance.now();
        const statusCode = response.statusCode ?? 0;
        const statusMessage = response.statusMessage ?? "";

        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          response.on("end", () => {
            succeed(resolve, {
              statusCode,
              statusMessage,
              responseAt,
              firstByteAt: undefined,
              endedAt: performance.now(),
              downloadedBytes: 0,
              contentEncoding: undefined,
              location: response.headers.location,
            });
          });
          response.on("error", fail);
          return;
        }

        let downloadedBytes = 0;
        /** @type {number | undefined} */
        let firstByteAt;

        response.on("data", (chunk) => {
          if (firstByteAt === undefined) {
            firstByteAt = performance.now();
          }
          downloadedBytes += chunk.length;
        });

        response.on("end", () => {
          succeed(resolve, {
            statusCode,
            statusMessage,
            responseAt,
            firstByteAt,
            endedAt: performance.now(),
            downloadedBytes,
            contentEncoding: response.headers["content-encoding"],
          });
        });

        response.on("error", fail);
      },
    );

    request.on("error", fail);
    request.end();
  });
}

/**
 * @param {unknown} error
 * @param {number} index
 * @param {number} timeoutMs
 */
function requestError(error, index, timeoutMs) {
  const name =
    error && typeof error === "object" && "name" in error
      ? error.name
      : undefined;
  const causeName =
    error && typeof error === "object" && "cause" in error
      ? /** @type {{ name?: string }} */ (error.cause)?.name
      : undefined;

  if (name === "TimeoutError" || causeName === "TimeoutError") {
    return new Error(`Request ${index + 1} timed out after ${timeoutMs} ms`);
  }

  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : undefined;

  return new Error(
    `Request ${index + 1} failed: ${message}${cause ? ` (${cause})` : ""}`,
    { cause: error },
  );
}
