// character appearance: fixed palettes + schema (notes/002). the option lists
// are the validation source — a character can only be made of these values, so
// the server rejects out-of-palette junk and the client builds swatches from
// the same arrays. colors copied from the prototype's SKINS/HAIRS/SHIRTS/PANTS.
import { z } from "zod";

export const SKIN_OPTIONS = [
  "#F2C89B", "#DFA26B", "#C68B59", "#8D5A3B", "#5C3B24", "#B48CF2", "#7FD97F", "#7FB8F2",
] as const;

// first entry means bald (prototype: "FIRST = NONE")
export const HAIR_OPTIONS = [
  "none", "#2A1E14", "#5C3B24", "#B4441F", "#E8C04A", "#3B3F4A", "#E8EEF9", "#F26BD0",
] as const;

export const SHIRT_OPTIONS = [
  "#E8EEF9", "#FF6B6B", "#FFB454", "#3EE08A", "#4EE1FF", "#8A7DFF", "#F26BD0", "#2B3A55",
] as const;

export const PANTS_OPTIONS = [
  "#2B3A55", "#1B2A47", "#5C6B84", "#8D5A3B", "#B4502A", "#3E6B4F", "#6B4FA0",
] as const;

export const HAT_OPTIONS = ["none", "cap", "beanie", "antenna"] as const;

export const characterSchema = z.object({
  skin: z.enum(SKIN_OPTIONS),
  hair: z.enum(HAIR_OPTIONS),
  shirt: z.enum(SHIRT_OPTIONS),
  pants: z.enum(PANTS_OPTIONS),
  hat: z.enum(HAT_OPTIONS),
  helmet: z.boolean(),
});

export type Character = z.infer<typeof characterSchema>;

// what everyone wears until they visit the crew locker (prototype default)
export const DEFAULT_CHARACTER: Character = {
  skin: "#F2C89B",
  hair: "#5C3B24",
  shirt: "#E8EEF9",
  pants: "#2B3A55",
  hat: "none",
  helmet: false,
};
