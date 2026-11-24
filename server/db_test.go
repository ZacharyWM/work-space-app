// workspace slug derivation tests (port of db.test.ts); the SQL paths need a
// live postgres and are exercised in the acceptance run, so only the pure rule
// is tested here (same split as auth_test.go)
package main

import (
	"strings"
	"testing"
)

func TestDeriveSlug(t *testing.T) {
	cases := []struct{ in, want string }{
		// lowercases and hyphenates a plain name
		{"Engineering", "engineering"},
		{"Deep Space Crew", "deep-space-crew"},
		// collapses non-alphanumeric runs into single hyphens
		{"ops  //  west", "ops-west"},
		{"a_b.c'd", "a-b-c-d"},
		// trims leading and trailing separators
		{"  alpha  ", "alpha"},
		{"!!alpha!!", "alpha"},
		// keeps digits
		{"Deck 42", "deck-42"},
		// caps at 32 chars without a dangling hyphen
		{strings.Repeat("a", 40), strings.Repeat("a", 32)},
		// the cut lands on a separator: no trailing hyphen may survive
		{strings.Repeat("a", 31) + " " + strings.Repeat("b", 10), strings.Repeat("a", 31)},
		// empty when the name has no usable characters
		{"!!!", ""},
		{"   ", ""},
	}
	for _, tc := range cases {
		if got := deriveSlug(tc.in); got != tc.want {
			t.Errorf("deriveSlug(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestDeriveSlugMatchesProtocolShape(t *testing.T) {
	for _, name := range []string{"Hello, World!", "x", "9 to 5", "--a--b--", "Ω alpha Ω"} {
		slug := deriveSlug(name)
		if slug != "" && !validSlug(slug) {
			t.Errorf("deriveSlug(%q) = %q does not match the protocol slug shape", name, slug)
		}
	}
}
