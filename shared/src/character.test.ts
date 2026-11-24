// character schema tests: palette membership is the validation rule (notes/002)
import { describe, expect, it } from "vitest";
import { characterSchema, DEFAULT_CHARACTER } from "./character";

describe("characterSchema", () => {
  it("accepts the default character", () => {
    expect(characterSchema.parse(DEFAULT_CHARACTER)).toEqual(DEFAULT_CHARACTER);
  });

  it("accepts bald + hatted + helmeted combinations", () => {
    const ch = {
      skin: "#B48CF2",
      hair: "none",
      shirt: "#4EE1FF",
      pants: "#1B2A47",
      hat: "antenna",
      helmet: true,
    };
    expect(characterSchema.parse(ch)).toEqual(ch);
  });

  it("rejects a color outside the palette", () => {
    expect(
      characterSchema.safeParse({ ...DEFAULT_CHARACTER, skin: "#123456" }).success,
    ).toBe(false);
  });

  it("rejects an unknown hat", () => {
    expect(
      characterSchema.safeParse({ ...DEFAULT_CHARACTER, hat: "fedora" }).success,
    ).toBe(false);
  });

  it("rejects a missing field", () => {
    const { helmet: _helmet, ...partial } = DEFAULT_CHARACTER;
    expect(characterSchema.safeParse(partial).success).toBe(false);
  });
});
