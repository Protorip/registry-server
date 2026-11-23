import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { hashToken, tokenPrefix } from "../auth.js";

const usage = "Usage: node tokens.mjs --name <name> [--role read|write|admin]";

try {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      name: { type: "string" },
      role: { type: "string", default: "admin" },
    },
  });
  if (values.help) {
    console.log(`${usage}

Print a secret and its hashed entry for TOKENS or TOKENS_FILE. The default role is admin.`);
  } else {
    const { name, role } = values;
    if (
      !name ||
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(name) ||
      name.startsWith(tokenPrefix) ||
      (role !== "read" && role !== "write" && role !== "admin")
    ) {
      throw new Error("Expected a token name and valid role");
    }
    const secret = tokenPrefix + randomBytes(32).toString("base64url");
    console.log(secret);
    console.log(`${name}:sha256:${hashToken(secret).toString("hex")}:${role}`);
  }
} catch (error) {
  if (error instanceof Error) console.error(error.message);
  console.error(usage);
  process.exitCode = 1;
}
