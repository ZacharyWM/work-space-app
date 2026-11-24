// placeholder test proving the vitest pipeline resolves the shared package (step 1.1 verify)
import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE } from "shared";

describe("shared package", () => {
  it("is importable by workspace name", () => {
    expect(SHARED_PACKAGE).toBe("shared");
  });
});
