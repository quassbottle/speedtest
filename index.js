#!/usr/bin/env node
import { parseArgs } from "./args.js";
import { speedtest } from "./speedtest.js";

try {
  const args = parseArgs();
  const result = await speedtest(args);

  console.log("\nSpeedtest completed:");
  console.log(`  URL: ${result.url}`);
  console.log(`  Requests: ${result.requestCount}`);
  console.log(
    `  Average request time: ${result.averageDurationMs.toFixed(2)} ms`,
  );
  console.log(
    `  Average time to first byte: ${result.averageTtfbMs.toFixed(2)} ms`,
  );
  console.log(
    `  Total downloaded (wire): ${result.totalDownloadedMib.toFixed(2)} MiB ` +
      `(${result.totalBytes.toLocaleString("en-US")} bytes)`,
  );
  console.log(
    `  Download speed (end-to-end): ` +
      `${result.averageMbitPerSecond.toFixed(1)} Mbit/s`,
  );
  console.log(
    `  Transfer speed (body only): ` +
      `${result.averageTransferMbitPerSecond.toFixed(1)} Mbit/s`,
  );
} catch (error) {
  console.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
