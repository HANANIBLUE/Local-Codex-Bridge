import readline from "node:readline";

if (process.argv.slice(2).join(" ") !== "app-server --listen stdio://") {
  process.exit(64);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      error: {
        code: -32000,
        message: "synthetic initialize failure api_key=must-not-leak",
      },
    })}\n`);
  }
});

lines.on("close", () => process.exit(0));
