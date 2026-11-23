import { expect, test } from "vitest";
import { InvalidArgumentError } from "./errors.js";
import { validateFiles as validateUploadFiles } from "./upload-validation.js";

const file = (path: string, content: string | Uint8Array) => ({
  path,
  content: typeof content === "string" ? Buffer.from(content) : content,
});
const validateFiles = (
  files: Parameters<typeof validateUploadFiles>[0],
  limits?: Parameters<typeof validateUploadFiles>[1],
) => validateUploadFiles(files, limits);
const proto = file("nested/widget.proto", 'syntax = "proto3"; message Widget {}');
const metadata = ["LICENSE", "buf.md", "README.md", "README.markdown", "buf.yaml", "buf.lock"];

test("uploads accept nested protos and only allowlisted root metadata", () => {
  validateFiles([proto, ...metadata.map((path) => file(path, "text"))]);
  for (const path of ["notes.txt", ...metadata.map((name) => `nested/${name}`)]) {
    expect(() => validateFiles([proto, file(path, "text")]), path).toThrow(
      expect.objectContaining({
        constructor: InvalidArgumentError,
        message: expect.stringMatching(/is not allowed/),
      }),
    );
  }
});

test("upload limits apply independently to file bytes, total bytes, and file count", () => {
  const files = [proto, file("LICENSE", "text")];
  const maxFileBytes = proto.content.byteLength;
  const maxCommitBytes = maxFileBytes + files[1].content.byteLength;
  validateFiles(files, { maxFileBytes, maxCommitBytes, maxFilesPerCommit: 2 });
  const cases: Array<[NonNullable<Parameters<typeof validateUploadFiles>[1]>, RegExp]> = [
    [{ maxFileBytes: maxFileBytes - 1 }, /file "nested\/widget.proto".*exceeds max/],
    [{ maxCommitBytes: maxCommitBytes - 1 }, /commit total size.*exceeds max/],
    [{ maxFilesPerCommit: 1 }, /too many files/],
  ];
  for (const [limits, message] of cases) {
    expect(() => validateFiles(files, limits)).toThrow(
      expect.objectContaining({
        constructor: InvalidArgumentError,
        message: expect.stringMatching(message),
      }),
    );
  }
});

test("uploads reject invalid proto encoding and syntax and binary licenses", () => {
  expect(() => validateFiles([file("widget.proto", Uint8Array.of(0xff))])).toThrow(
    expect.objectContaining({
      constructor: InvalidArgumentError,
      message: expect.stringMatching(/not valid UTF-8/),
    }),
  );
  expect(() => validateFiles([file("widget.proto", "message Widget {")])).toThrow(
    expect.objectContaining({
      constructor: InvalidArgumentError,
      message: expect.stringMatching(/invalid \.proto in widget\.proto/),
    }),
  );
  validateFiles([proto, file("LICENSE", "MZ Research Foundation\n")]);
  const pe = Buffer.alloc(68);
  pe.write("MZ");
  pe.writeUInt32LE(64, 0x3c);
  pe.write("PE\0\0", 64);
  for (const [format, header] of [
    ["PE (Windows EXE/DLL)", pe.toString("hex")],
    ["PE (Windows EXE/DLL)", "4d5a00010300"],
    ["PNG", "89504e470d0a1a0a"],
    ["PDF", "25504446"],
    ["ZIP", "504b0304"],
  ]) {
    expect(() => validateFiles([proto, file("LICENSE", Buffer.from(header, "hex"))])).toThrow(
      expect.objectContaining({
        constructor: InvalidArgumentError,
        message: expect.stringMatching(
          new RegExp(`invalid LICENSE: binary format \\(${RegExp.escape(format)}`),
        ),
      }),
    );
  }
});
