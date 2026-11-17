import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { calculateMetrics, speedtest } from "../speedtest.js";

const BYTES_PER_MIB = 1024 ** 2;

test("calculates average duration and throughput", () => {
  const result = calculateMetrics({
    requestCount: 4,
    totalBytes: 4_000_000,
    totalDurationMs: 2_000,
    totalBodyDurationMs: 1_000,
    totalTtfbMs: 400,
  });

  assert.equal(result.averageDurationMs, 500);
  assert.equal(result.averageTtfbMs, 100);
  assert.equal(result.totalDurationMs, 2_000);
  assert.equal(result.totalDownloadedMib, 4_000_000 / BYTES_PER_MIB);
  assert.equal(result.averageMbitPerSecond, 16); // 4 MB * 8 / 2 s
  assert.equal(result.averageTransferMbitPerSecond, 32);
});

test("reports volume in MiB and speed in Mbit/s", () => {
  const result = calculateMetrics({
    requestCount: 1,
    totalBytes: BYTES_PER_MIB,
    totalDurationMs: 1_000,
    totalBodyDurationMs: 1_000,
  });

  assert.equal(result.totalDownloadedMib, 1);
  assert.equal(result.averageMbitPerSecond, 8.388608);
  assert.equal(result.averageTransferMbitPerSecond, 8.388608);
});

test("rejects a non-positive request count", () => {
  assert.throws(
    () =>
      calculateMetrics({
        requestCount: 0,
        totalBytes: 1,
        totalDurationMs: 1,
      }),
    /positive number/,
  );
});

test("downloads every byte of every response", async (t) => {
  t.mock.method(console, "log", () => {});

  const payload = Buffer.alloc(256 * 1024, 0x61);
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": payload.length,
    });

    // Send the body in two chunks to make sure streaming is handled correctly.
    const midpoint = payload.length / 2;
    response.write(payload.subarray(0, midpoint));
    setTimeout(() => response.end(payload.subarray(midpoint)), 5);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = /** @type {import("node:net").AddressInfo} */ (
    server.address()
  );
  const result = await speedtest({
    url: `http://127.0.0.1:${port}/image.jpg`,
    requestCount: 3,
    timeoutMs: 5_000,
  });

  assert.equal(result.requestCount, 3);
  assert.equal(result.totalBytes, payload.length * 3);
  assert.equal(result.totalDownloadedMib, (payload.length * 3) / BYTES_PER_MIB);
  assert.ok(result.averageDurationMs > 0);
  assert.ok(result.averageTtfbMs > 0);
  assert.ok(result.totalBodyDurationMs > 0);
  assert.ok(result.averageMbitPerSecond > 0);
  assert.ok(
    result.averageTransferMbitPerSecond >= result.averageMbitPerSecond,
  );
  assert.equal(
    result.averageMbitPerSecond,
    (result.totalBytes * 8) / 1_000_000 / (result.totalDurationMs / 1000),
  );
  assert.equal(
    result.averageTransferMbitPerSecond,
    (result.totalBytes * 8) /
      1_000_000 /
      (result.totalBodyDurationMs / 1000),
  );
});

test("counts wire bytes instead of decompressed bytes", async (t) => {
  t.mock.method(console, "log", () => {});

  const plain = Buffer.alloc(128 * 1024, 0x62);
  const compressed = gzipSync(plain);
  let acceptEncoding;

  const server = createServer((request, response) => {
    acceptEncoding = request.headers["accept-encoding"];
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-encoding": "gzip",
      "content-length": compressed.length,
    });
    response.end(compressed);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = /** @type {import("node:net").AddressInfo} */ (
    server.address()
  );
  const result = await speedtest({
    url: `http://127.0.0.1:${port}/compressed.txt`,
    requestCount: 2,
    timeoutMs: 5_000,
  });

  assert.equal(acceptEncoding, "identity");
  assert.equal(result.totalBytes, compressed.length * 2);
  assert.ok(result.totalBytes < plain.length * 2);
});

test("times out on a stalled response", async (t) => {
  t.mock.method(console, "log", () => {});

  const server = createServer(() => {
    // Deliberately never respond.
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });

  const { port } = /** @type {import("node:net").AddressInfo} */ (
    server.address()
  );

  await assert.rejects(
    speedtest({
      url: `http://127.0.0.1:${port}/stall`,
      requestCount: 1,
      timeoutMs: 50,
    }),
    /Request 1 timed out after 50 ms/,
  );
});

test("follows redirects", async (t) => {
  t.mock.method(console, "log", () => {});

  const payload = Buffer.alloc(32 * 1024, 0x63);
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/file.bin" });
      response.end();
      return;
    }

    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": payload.length,
    });
    response.end(payload);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = /** @type {import("node:net").AddressInfo} */ (
    server.address()
  );
  const result = await speedtest({
    url: `http://127.0.0.1:${port}/redirect`,
    requestCount: 1,
    timeoutMs: 5_000,
  });

  assert.equal(result.totalBytes, payload.length);
});
