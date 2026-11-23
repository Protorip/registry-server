import { shake256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export function computeFileDigest(content: Uint8Array): Uint8Array {
  return shake256(content, { dkLen: 64 });
}

export function computeManifestDigest(
  files: Array<{ path: string; content: Uint8Array }>,
): Uint8Array {
  const lines = files
    .map(({ path, content }) => {
      const digest = computeFileDigest(content);
      return `shake256:${bytesToHex(digest)}  ${path}\n`;
    })
    .sort((a, b) => {
      // Sort by path: extract path from "hex  path\n"
      const pathA = a.slice(a.indexOf("  ") + 2, -1);
      const pathB = b.slice(b.indexOf("  ") + 2, -1);
      return pathA < pathB ? -1 : pathA > pathB ? 1 : 0;
    });

  const manifest = lines.join("");
  return shake256(new TextEncoder().encode(manifest), { dkLen: 64 });
}

/**
 * Compute Buf's b5 digest from module files and dependency digests.
 * @param files Files before Buf's module-file selection is applied.
 * @param depDigests b5 dependency digests; input order does not affect the result.
 * @returns The 64-byte SHAKE-256 composite digest.
 */
export function computeB5Digest(
  files: Array<{ path: string; content: Uint8Array }>,
  depDigests: Uint8Array[],
): Uint8Array {
  const manifestDigest = computeManifestDigest(selectB5Files(files));
  const manifestStr = `shake256:${bytesToHex(manifestDigest)}`;
  const depStrs = depDigests
    .map((d) => `b5:${bytesToHex(d)}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const combined = [manifestStr, ...depStrs].join("\n");
  return shake256(new TextEncoder().encode(combined), { dkLen: 64 });
}

/**
 * Select the module files used by Buf's b5 digest: protos, the root license,
 * and the first existing root documentation file. Configuration files stay
 * available for download but do not participate in the digest.
 * @param files Uploaded files, including optional configuration and documentation.
 * @returns The selected files without changing the input array.
 */
function selectB5Files(
  files: Array<{ path: string; content: Uint8Array }>,
): Array<{ path: string; content: Uint8Array }> {
  const docPath = ["buf.md", "README.md", "README.markdown"].find((path) =>
    files.some((file) => file.path === path),
  );
  return files.filter(
    (file) => file.path.endsWith(".proto") || file.path === "LICENSE" || file.path === docPath,
  );
}
