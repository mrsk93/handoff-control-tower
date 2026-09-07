import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const secretPatterns = [
  new RegExp(["-----BEGIN ", "(?:RSA |EC |OPENSSH |DSA )?", "PRIVATE KEY-----"].join(""), "i"),
  new RegExp(`\\b${["AK", "IA"].join("")}[0-9A-Z]{16}\\b`),
  new RegExp(`\\b${["gh", "pousr"].join("")}_[A-Za-z0-9]{20,}\\b`),
  new RegExp(`${["sk", "-"].join("")}[A-Za-z0-9]{20,}`),
];

async function main(): Promise<void> {
  const { stdout } = await execFileAsync("git", ["ls-files"]);
  const findings: string[] = [];
  for (const file of stdout.split("\n").filter(Boolean)) {
    if (file.endsWith(".lock") || file.endsWith(".png") || file.endsWith(".jpg")) continue;
    const { stdout: content } = await execFileAsync("git", ["show", `HEAD:${file}`]);
    for (const pattern of secretPatterns) {
      if (pattern.test(content)) findings.push(`${file}: matched ${pattern}`);
    }
  }
  if (findings.length > 0) {
    console.error("Potential secrets found in tracked files:");
    for (const finding of findings) console.error(finding);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ scanned: stdout.split("\n").filter(Boolean).length, findings: 0 }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
