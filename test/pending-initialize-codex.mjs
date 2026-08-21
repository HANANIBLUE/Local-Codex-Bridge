import { writeFileSync } from "node:fs";
import readline from "node:readline";

const [markerPath, secondArgument, ...remainingArguments] = process.argv.slice(2);
const hasCloseMarker = secondArgument !== "app-server";
const closeMarkerPath = hasCloseMarker ? secondArgument : undefined;
const appServerArgs = hasCloseMarker
  ? remainingArguments
  : [secondArgument, ...remainingArguments];
if (
  !markerPath ||
  (hasCloseMarker && !closeMarkerPath) ||
  appServerArgs.join(" ") !== "app-server --listen stdio://"
) {
  process.exit(64);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    writeFileSync(markerPath, "initialize-pending\n", "utf8");
    // Deliberately leave initialize pending until the Bridge closes stdin.
  }
});

lines.on("close", () => {
  if (closeMarkerPath) {
    writeFileSync(closeMarkerPath, "stdin-closed\n", "utf8");
  }
  process.exit(0);
});
