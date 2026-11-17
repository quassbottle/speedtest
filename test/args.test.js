import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../args.js";

test("uses the documented defaults", () => {
  const args = parseArgs(["https://example.com/image.jpg"]);

  assert.equal(args.url, "https://example.com/image.jpg");
  assert.equal(args.requestCount, 10);
  assert.equal(args.timeoutMs, 60_000);
});

test("parses request count and timeout", () => {
  const args = parseArgs([
    "https://example.com/image.jpg",
    "--request-count",
    "3",
    "--timeout-ms",
    "1500",
  ]);

  assert.equal(args.requestCount, 3);
  assert.equal(args.timeoutMs, 1500);
});

test("rejects a non-http URL", () => {
  assert.throws(
    () => parseArgs(["file:///etc/passwd"]),
    /http or https/,
  );
});

test("rejects an invalid request count", () => {
  assert.throws(
    () =>
      parseArgs([
        "https://example.com/image.jpg",
        "--request-count",
        "0",
      ]),
    /positive integer/,
  );
});
