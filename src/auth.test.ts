import { expect, test, vi } from "vitest";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth, hashToken } from "./auth.js";
import { ConfigurationError, type RegistryConfig } from "./config.js";
import { UnauthenticatedError } from "./errors.js";

test("static auth requires the psr prefix even for a configured hash", () => {
  const tokens = ["psr_current-token", "unprefixed-token"].map((secret, index) => ({
    name: `token-${index}`,
    hash: `sha256:${hashToken(secret).toString("hex")}`,
  }));
  const auth = createAuth({ mode: "static", tokens }, () => {});
  expect(auth.authenticate("Bearer psr_current-token")?.name).toBe("token-0");
  expect(() => auth.authenticate("Bearer unprefixed-token")).toThrow(UnauthenticatedError);
});

test("static auth preserves safe startup configuration errors", () => {
  const cases: Array<[Omit<Extract<RegistryConfig["auth"], { mode: "static" }>, "mode">, string]> =
    [
      [{ tokens: [] }, "AUTH_MODE=static requires tokens"],
      [
        {
          tokens: [
            { name: "one", plain: "psr_test-secret" },
            { name: "two", plain: "psr_test-secret" },
          ],
        },
        "Duplicate token credentials",
      ],
    ];
  for (const [config, message] of cases) {
    expect(() => createAuth({ mode: "static", ...config }, () => {})).toThrow(
      expect.objectContaining({ constructor: ConfigurationError, message }),
    );
  }
});

test("the token file reloads on SIGHUP and mtime changes and retains the last valid tokens", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "registry-token-reload-"));
  const tokensFile = join(root, "tokens.json");
  const writeTokens = (...names: string[]) =>
    writeFile(
      tokensFile,
      JSON.stringify(names.map((name) => ({ name, plain: `psr_test-${name}` }))),
    );
  await writeTokens("initial");

  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const events: Array<string | number> = [];
  const auth = createAuth({ mode: "static", tokensFile }, (_, { event }) => events.push(event));
  t.onTestFinished(async () => {
    auth.close();
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });
  const authenticate = (name: string) => auth.authenticate(`Bearer psr_test-${name}`)?.name;
  expect(authenticate("initial")).toBe("initial");

  await writeTokens("initial", "signal");
  expect(() => authenticate("signal")).toThrow(UnauthenticatedError);
  process.emit("SIGHUP");
  expect(authenticate("signal")).toBe("signal");

  await writeTokens("initial", "signal", "poll");
  await utimes(tokensFile, 1000, 1000);
  expect(() => authenticate("poll")).toThrow(UnauthenticatedError);
  vi.advanceTimersByTime(1000);
  expect(authenticate("poll")).toBe("poll");

  await writeFile(tokensFile, "[invalid JSON");
  await utimes(tokensFile, 2000, 2000);
  vi.advanceTimersByTime(1000);
  expect(events.at(-1)).toBe("tokens_reload_failed");
  for (const name of ["initial", "signal", "poll"]) expect(authenticate(name)).toBe(name);
});
