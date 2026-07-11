import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let solc;
try {
  solc = require("solc");
} catch (error) {
  throw new Error(
    "Missing Solidity compiler. Add solc as a root devDependency, run npm install, then retry npm run compile:contract.",
    { cause: error },
  );
}
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const contractsDirectory = path.resolve(scriptDirectory, "..");
const sourcePath = path.join(contractsDirectory, "src", "MatchProofRegistry.sol");
const artifactDirectory = path.join(contractsDirectory, "artifacts");
const artifactPath = path.join(artifactDirectory, "MatchProofRegistry.json");
const sourceName = "MatchProofRegistry.sol";
const source = await readFile(sourcePath, "utf8");

const input = {
  language: "Solidity",
  sources: {
    [sourceName]: { content: source },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const messages = output.errors ?? [];
for (const message of messages) {
  const stream = message.severity === "error" ? process.stderr : process.stdout;
  stream.write(`${message.formattedMessage}\n`);
}

if (messages.some((message) => message.severity === "error")) {
  process.exitCode = 1;
} else {
  const compiled = output.contracts?.[sourceName]?.MatchProofRegistry;
  if (!compiled?.evm?.bytecode?.object) {
    throw new Error("solc produced no MatchProofRegistry bytecode");
  }

  const artifact = {
    contractName: "MatchProofRegistry",
    sourceName,
    compilerVersion: solc.version(),
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
    deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
    metadata: JSON.parse(compiled.metadata),
  };

  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${artifactPath}\n`);
}
