import { assert, describe, it } from "@effect/vitest";

import { normalizeClaimPath, normalizeClaimPaths } from "./schema.ts";

describe("claim path normalization", () => {
  it("collapses the spellings git and callers produce for one file", () => {
    for (const input of ["./src/a.ts", "src//a.ts", "src/a.ts", "src\\a.ts"]) {
      assert.strictEqual(normalizeClaimPath(input), "src/a.ts");
    }
  });

  it("resolves interior traversal so one file has one key", () => {
    assert.strictEqual(normalizeClaimPath("src/lib/../a.ts"), "src/a.ts");
  });

  it("deduplicates and sorts, so claims compare as sets", () => {
    const files = normalizeClaimPaths(["./b.ts", "src//a.ts", "b.ts", "src/a.ts"]);
    assert.deepStrictEqual(files, ["b.ts", "src/a.ts"]);
  });

  it("drops empty segments rather than claiming the repo root", () => {
    assert.deepStrictEqual(normalizeClaimPaths(["", ".", "./"]), []);
  });
});
