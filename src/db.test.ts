import { expect, test } from "vitest";
import { page } from "./db.js";
import { InvalidArgumentError } from "./errors.js";

test("pagination resumes after the cursor and rejects an unknown token", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const first = page(rows, { pageSize: 2, pageToken: "" });
  expect(first).toStrictEqual({ values: rows.slice(0, 2), nextPageToken: "b" });
  expect(page(rows, { pageSize: 2, pageToken: first.nextPageToken })).toStrictEqual({
    values: rows.slice(2),
    nextPageToken: "",
  });
  expect(() => page(rows, { pageSize: 2, pageToken: "missing" })).toThrow(InvalidArgumentError);
});
