import { InvalidArgumentError } from "./errors.js";
import protobuf from "protobufjs";
import type { RegistryConfig } from "./config.js";

const invalid = (message: string) => new InvalidArgumentError(message);
const ALLOWED_ROOT_FILES = new Set([
  "LICENSE",
  "buf.md",
  "README.md",
  "README.markdown",
  "buf.yaml",
  "buf.lock",
]);

/**
 * Checks an uploaded path against the allowlist. Accepts `*.proto` at any
 * depth, or one of the root-only metadata files above. Rejects everything
 * else. Path-syntax rules (max length, no `..`, no backslashes) are enforced
 * upstream by protovalidate; this function is strictly about *which*
 * filenames we accept.
 */
function validateFilename(path: string): void {
  if (path.endsWith(".proto")) return;
  if (ALLOWED_ROOT_FILES.has(path)) return;
  throw invalid(
    `file path "${path}" is not allowed: only *.proto files and root-level ` +
      `LICENSE, buf.md, README.md, README.markdown, buf.yaml, buf.lock are accepted`,
  );
}

/**
 * Per-upload byte and count limits bound parsing work and storage use while
 * allowing typical Protobuf modules.
 */
const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_COMMIT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_FILES_PER_COMMIT = 1000;

/**
 * Parses every `.proto` file in the commit to confirm it is real proto
 * content, not binary data renamed to `.proto`. Uses protobufjs, which is a
 * syntax-only parser without import resolution or cross-file type checking. The
 * buf CLI already runs full `buf build` client-side; this is defence in depth
 * against malicious or broken clients.
 *
 * Non-`.proto` files in the allowlist are handled by validateMetadataContent.
 *
 * CPU bound: parse cost scales with input size; the per-file cap (1 MB) and
 * per-commit cap (10 MB) enforced by validateSizes are the backstop.
 */
function validateProtoContent(files: ReadonlyArray<{ path: string; content: Uint8Array }>): void {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const file of files) {
    if (!file.path.endsWith(".proto")) continue;
    let text: string;
    try {
      text = decoder.decode(file.content);
    } catch (err) {
      throw invalid(`invalid .proto in ${file.path}: not valid UTF-8 (${(err as Error).message})`);
    }
    try {
      protobuf.parse(text);
    } catch (err) {
      throw invalid(`invalid .proto in ${file.path}: ${(err as Error).message}`);
    }
  }
}

/**
 * Known binary magic-number signatures. `match` returns a human-readable
 * format label when the file starts with that signature, else null. Covers
 * common executable, archive, image, media, and document formats.
 *
 * The list covers common binaries renamed to text file paths. The
 * UTF-8 check already catches most binaries via high byte values. The
 * magic-number check supplements it so ASCII-compatible containers (PDF
 * "%PDF", ZIP "PK", GIF "GIF8", BMP "BM", ICO nulls, WebP/MP4 RIFF-like
 * structures) are rejected with a clear error naming the format.
 */
const MAGIC_SIGNATURES: Array<{
  label: string;
  match: (bytes: Uint8Array) => boolean;
}> = [
  {
    label: "PE (Windows EXE/DLL)",
    match: (b) => {
      if (b.length < 2 || b[0] !== 0x4d || b[1] !== 0x5a) return false;

      if (b.length >= 64) {
        const offset = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0x3c, true);
        if (
          offset >= 64 &&
          offset <= b.length - 4 &&
          b[offset] === 0x50 &&
          b[offset + 1] === 0x45 &&
          b[offset + 2] === 0 &&
          b[offset + 3] === 0
        )
          return true;
      }

      // DOS headers contain control bytes beyond those used for text whitespace.
      return b
        .subarray(2, 64)
        .some(
          (byte) =>
            (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f,
        );
    },
  },
  {
    label: "ELF",
    match: (b) => b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46,
  },
  {
    label: "Mach-O",
    match: (b) => {
      if (b.length < 4) return false;
      const m0 = b[0];
      const m1 = b[1];
      const m2 = b[2];
      const m3 = b[3];
      // 32-bit / 64-bit BE: FE ED FA CE / FE ED FA CF
      if (m0 === 0xfe && m1 === 0xed && m2 === 0xfa && (m3 === 0xce || m3 === 0xcf)) return true;
      // 32-bit / 64-bit LE: CE FA ED FE / CF FA ED FE
      if ((m0 === 0xce || m0 === 0xcf) && m1 === 0xfa && m2 === 0xed && m3 === 0xfe) return true;
      return false;
    },
  },
  {
    // Universal Mach-O binary magic (CA FE BA BE) collides with Java .class
    // files. Both formats contain binary data.
    label: "Mach-O universal / Java .class",
    match: (b) => b.length >= 4 && b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe,
  },
  {
    label: "ZIP (incl. JAR/DOCX)",
    match: (b) =>
      b.length >= 4 &&
      b[0] === 0x50 &&
      b[1] === 0x4b &&
      (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) &&
      (b[3] === 0x04 || b[3] === 0x06 || b[3] === 0x08),
  },
  {
    label: "GZIP",
    match: (b) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b,
  },
  {
    label: "PNG",
    match: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    label: "JPEG",
    match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    label: "MP4 / ISO BMFF",
    // ISO BMFF: bytes 4-7 are "ftyp". Size prefix in bytes 0-3 varies.
    match: (b) => b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
  },
  {
    label: "PDF",
    match: (b) => b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  },
  {
    label: "GIF",
    match: (b) => b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    label: "BMP",
    // "BM" is common in English (BMW, BM standard, etc.) so we also require
    // the two reserved shorts at offsets 6-9 to be zero, which is invariant
    // in real BMP headers but implausible in text.
    match: (b) =>
      b.length >= 10 &&
      b[0] === 0x42 &&
      b[1] === 0x4d &&
      b[6] === 0x00 &&
      b[7] === 0x00 &&
      b[8] === 0x00 &&
      b[9] === 0x00,
  },
  {
    label: "WebP",
    // RIFF....WEBP — bytes 0-3 = "RIFF", bytes 8-11 = "WEBP".
    match: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  {
    label: "ICO",
    match: (b) => b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00,
  },
];

function detectBinaryMagic(bytes: Uint8Array): string | null {
  for (const sig of MAGIC_SIGNATURES) {
    if (sig.match(bytes)) return sig.label;
  }
  return null;
}

/**
 * Validates the content of non-`.proto` allowlisted metadata files (LICENSE,
 * buf.md, README.md, README.markdown, buf.yaml, buf.lock). All six are text
 * formats, so we enforce UTF-8 and reject known binary magic numbers.
 *
 * This closes the gap where a caller could smuggle arbitrary bytes through the
 * metadata slot. The filename allowlist accepts these paths and the proto
 * parser skips them. Defence in depth: an attacker can still upload valid
 * UTF-8 garbage, but the "rename .png to LICENSE" case is caught cheaply.
 *
 * Order matters: magic-number check runs first so the error message names the
 * format (e.g. "PDF") instead of the less specific "not valid UTF-8". Most
 * binaries fail both checks; the clearer error wins.
 *
 * The 1 MB per-file limit in validateSizes also applies to metadata.
 */
function validateMetadataContent(
  files: ReadonlyArray<{ path: string; content: Uint8Array }>,
): void {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const file of files) {
    if (!ALLOWED_ROOT_FILES.has(file.path)) continue;
    const magic = detectBinaryMagic(file.content);
    if (magic !== null) {
      throw invalid(`invalid ${file.path}: binary format (${magic}). Only text content is allowed`);
    }
    try {
      decoder.decode(file.content);
    } catch (err) {
      throw invalid(`invalid ${file.path}: not valid UTF-8 (${(err as Error).message})`);
    }
  }
}

/**
 * Enforces the count and byte caps on a single commit's file set. Runs before
 * any blob write so oversized input never touches storage.
 */
function validateSizes(
  files: ReadonlyArray<{ path: string; content: Uint8Array }>,
  limits: RegistryConfig["limits"],
): void {
  const {
    maxFileBytes = MAX_FILE_BYTES,
    maxCommitBytes = MAX_COMMIT_BYTES,
    maxFilesPerCommit = MAX_FILES_PER_COMMIT,
  } = limits ?? {};
  if (files.length > maxFilesPerCommit) {
    throw invalid(`too many files in commit: ${files.length} exceeds max ${maxFilesPerCommit}`);
  }
  let totalBytes = 0;
  for (const file of files) {
    if (file.content.byteLength > maxFileBytes) {
      throw invalid(
        `file "${file.path}" is ${file.content.byteLength} bytes, exceeds max ${maxFileBytes}`,
      );
    }
    totalBytes += file.content.byteLength;
  }
  if (totalBytes > maxCommitBytes) {
    throw invalid(`commit total size ${totalBytes} bytes exceeds max ${maxCommitBytes}`);
  }
}

export function validateFiles(
  files: ReadonlyArray<{ path: string; content: Uint8Array }>,
  limits: RegistryConfig["limits"],
) {
  validateSizes(files, limits);
  const paths = new Set<string>();
  for (const { path } of files) {
    if (
      path.includes("\\") ||
      [...path].some((character) => character.charCodeAt(0) < 32) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      paths.has(path)
    ) {
      throw invalid("Invalid or duplicate upload path");
    }
    paths.add(path);
    validateFilename(path);
  }
  if (!files.some(({ path }) => path.endsWith(".proto")))
    throw invalid("Upload requires a .proto file");
  validateProtoContent(files);
  validateMetadataContent(files);
}
