import { expect, test, vi, type TestContext } from "vitest";
import { NotFoundError } from "../errors.js";
import { createDownloads, type DownloadFileType } from "./downloads.js";
import { filePrefix } from "../storage.js";
import { actor, seedCommits } from "./test-fixtures.js";

const files = {
  a: [
    "LICENSE",
    "README.md",
    "buf.yaml",
    "nested/a.proto",
    "nested/deeper/b.proto",
    "nested2/c.proto",
  ],
  b: ["buf.md", "nested/d.proto"],
};

interface Selection {
  id?: string;
  fileTypes?: DownloadFileType[];
  paths?: string[];
  pathsAllowNotExist?: boolean;
}

function setup(t: TestContext) {
  const db = seedCommits(t, { a: "widgets", b: "widgets" });
  const mod = { slug: "example", name: "widgets" };
  const blobs = new Map(
    Object.entries(files).flatMap(([id, paths]) =>
      paths.map((path) => [filePrefix(mod, id) + path, Buffer.from(path)]),
    ),
  );
  const service = createDownloads(
    db,
    {
      listPrefix: async (prefix) => [...blobs.keys()].filter((key) => key.startsWith(prefix)),
      get: async (key) => {
        const content = blobs.get(key);
        if (!content) throw new Error(`Missing fixture blob: ${key}`);
        return content;
      },
      put: vi.fn(),
      deletePrefix: vi.fn(),
      close: vi.fn(),
    },
    false,
  );
  const download = (...selections: Selection[]) =>
    service.download(
      selections.map(({ id = "a", ...selection }) => ({
        resourceRef: { case: "id", value: id },
        fileTypes: [],
        paths: [],
        pathsAllowNotExist: false,
        ...selection,
      })),
      actor,
    );
  return download;
}

const cases: Array<[string, Selection, string[]]> = [
  ["all files", {}, files.a],
  ["proto files", { fileTypes: ["proto"] }, files.a.slice(3)],
  ["documentation", { fileTypes: ["doc"] }, ["README.md"]],
  ["license files", { fileTypes: ["license"] }, ["LICENSE"]],
  ["an exact path", { paths: ["nested/a.proto"] }, ["nested/a.proto"]],
  ["a directory and its descendants", { paths: ["nested"] }, files.a.slice(3, 5)],
  [
    "combined type and path filters",
    { fileTypes: ["proto"], paths: ["nested"] },
    files.a.slice(3, 5),
  ],
  ["a permitted missing path", { paths: ["missing"], pathsAllowNotExist: true }, []],
];
for (const [name, selection, expected] of cases) {
  test(`download selects ${name}`, async (t) => {
    const [result] = await setup(t)(selection);
    expect(
      result.files.map(({ path, content }) => [path, Buffer.from(content).toString()]),
    ).toStrictEqual(expected.map((path) => [path, path]));
  });
}

test("download rejects a requested path that has no match after type filtering", async (t) => {
  const download = setup(t);
  await expect(download({ fileTypes: ["proto"], paths: ["README.md"] })).rejects.toThrow(
    expect.objectContaining({ name: NotFoundError.name, message: "Requested path not found" }),
  );
});

test("download applies each batch value to its own commit and selection", async (t) => {
  const results = await setup(t)(
    { id: "b", fileTypes: ["doc"] },
    { id: "a", paths: ["nested/a.proto"] },
  );
  expect(results.map(({ row, files }) => [row.id, files.map(({ path }) => path)])).toStrictEqual([
    ["b", ["buf.md"]],
    ["a", ["nested/a.proto"]],
  ]);
});
