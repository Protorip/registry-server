import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { computeB5Digest, computeFileDigest, computeManifestDigest } from "./digest.js";

const file = (path: string, content = path) => ({ path, content: Buffer.from(content) });
const shake256 = (value: string | Uint8Array) =>
  createHash("shake256", { outputLength: 64 }).update(value).digest();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const manifestLine = ({ path, content }: ReturnType<typeof file>) =>
  `shake256:${hex(shake256(content))}  ${path}\n`;

test("file digests use the 64-byte SHAKE-256 output", () => {
  const content = Buffer.from("hello");
  expect(hex(computeFileDigest(content))).toBe(hex(shake256(content)));
});

test("manifest digests hash path-sorted lines with two spaces and a trailing newline", () => {
  const a = file("a.proto", "first");
  const b = file("nested/b.proto", "second");
  const expected = shake256(manifestLine(a) + manifestLine(b));
  expect(hex(computeManifestDigest([b, a]))).toBe(hex(expected));
});

const documentationCases: Array<[string[], string | undefined]> = [
  [[], undefined],
  [["README.markdown"], "README.markdown"],
  [["README.markdown", "README.md"], "README.md"],
  [["README.markdown", "README.md", "buf.md"], "buf.md"],
];
for (const [docs, selected] of documentationCases) {
  test(`b5 hashes protos and the root license with ${selected ?? "no documentation"}`, () => {
    const required = [file("LICENSE"), file("nested/a.proto")];
    const files = [
      ...required,
      ...["buf.yaml", "buf.lock", "nested/LICENSE", "nested/README.md", ...docs].map((path) =>
        file(path),
      ),
    ];
    const selectedFiles = selected ? [...required, file(selected)] : required;
    const manifest = selectedFiles
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map(manifestLine)
      .join("");
    const expected = shake256(`shake256:${hex(shake256(manifest))}`);
    expect(hex(computeB5Digest(files, []))).toBe(hex(expected));
  });
}

test("b5 hashes sorted dependency digest strings after the manifest digest", () => {
  const proto = file("a.proto");
  const first = Buffer.alloc(64, 0x11);
  const second = Buffer.alloc(64, 0x22);
  const expected = shake256(
    `shake256:${hex(shake256(manifestLine(proto)))}\nb5:${hex(first)}\nb5:${hex(second)}`,
  );
  expect(hex(computeB5Digest([proto], [second, first]))).toBe(hex(expected));
});
