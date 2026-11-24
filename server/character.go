// character appearance (port of shared/src/character.ts): fixed palettes are
// the validation source — a character can only be made of these values, so the
// server rejects out-of-palette junk. The client keeps the TS copy; the two
// lists must stay identical.
package main

import "fmt"

var skinOptions = []string{
	"#F2C89B", "#DFA26B", "#C68B59", "#8D5A3B", "#5C3B24", "#B48CF2", "#7FD97F", "#7FB8F2",
}

// first entry means bald
var hairOptions = []string{
	"none", "#2A1E14", "#5C3B24", "#B4441F", "#E8C04A", "#3B3F4A", "#E8EEF9", "#F26BD0",
}

var shirtOptions = []string{
	"#E8EEF9", "#FF6B6B", "#FFB454", "#3EE08A", "#4EE1FF", "#8A7DFF", "#F26BD0", "#2B3A55",
}

var pantsOptions = []string{
	"#2B3A55", "#1B2A47", "#5C6B84", "#8D5A3B", "#B4502A", "#3E6B4F", "#6B4FA0",
}

var hatOptions = []string{"none", "cap", "beanie", "antenna"}

// avatar appearance as it rides the wire and the users.character jsonb column
type Character struct {
	Skin   string `json:"skin"`
	Hair   string `json:"hair"`
	Shirt  string `json:"shirt"`
	Pants  string `json:"pants"`
	Hat    string `json:"hat"`
	Helmet bool   `json:"helmet"`
}

// what everyone wears until they visit the crew locker
var defaultCharacter = Character{
	Skin:   "#F2C89B",
	Hair:   "#5C3B24",
	Shirt:  "#E8EEF9",
	Pants:  "#2B3A55",
	Hat:    "none",
	Helmet: false,
}

// true when v is one of the palette entries
func inPalette(v string, options []string) bool {
	for _, o := range options {
		if v == o {
			return true
		}
	}
	return false
}

// every field must come from its palette (zod characterSchema equivalent);
// helmet is a plain bool so JSON decoding already constrained it
func validateCharacter(c Character) error {
	if !inPalette(c.Skin, skinOptions) {
		return fmt.Errorf("invalid skin %q", c.Skin)
	}
	if !inPalette(c.Hair, hairOptions) {
		return fmt.Errorf("invalid hair %q", c.Hair)
	}
	if !inPalette(c.Shirt, shirtOptions) {
		return fmt.Errorf("invalid shirt %q", c.Shirt)
	}
	if !inPalette(c.Pants, pantsOptions) {
		return fmt.Errorf("invalid pants %q", c.Pants)
	}
	if !inPalette(c.Hat, hatOptions) {
		return fmt.Errorf("invalid hat %q", c.Hat)
	}
	return nil
}
