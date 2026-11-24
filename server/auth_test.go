// join-gate tests: first-join display name derivation (port of auth.test.ts);
// token verification itself is clerk's code and needs their backend, so only
// the pure naming rule is tested here
package main

import (
	"testing"

	"github.com/clerk/clerk-sdk-go/v2"
)

func TestDefaultDisplayName(t *testing.T) {
	cases := []struct {
		name string
		src  clerkNameSource
		want string
	}{
		{"prefers the first name",
			clerkNameSource{firstName: "Ellen", username: "ripley", email: "er@weyland.co"}, "Ellen"},
		{"falls back to the username when the first name is empty",
			clerkNameSource{firstName: "  ", username: "ripley"}, "ripley"},
		{"falls back to the email local part",
			clerkNameSource{email: "er@weyland.co"}, "er"},
		{"falls back to a generic name when the profile is bare",
			clerkNameSource{}, "Crew Member"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := defaultDisplayName(tc.src); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestPrimaryEmail(t *testing.T) {
	primary := "email_2"
	addr := func(id, email string) *clerk.EmailAddress {
		return &clerk.EmailAddress{ID: id, EmailAddress: email}
	}
	cases := []struct {
		name string
		u    clerk.User
		want string
	}{
		{"picks the primary over the first listed",
			clerk.User{
				PrimaryEmailAddressID: &primary,
				EmailAddresses:        []*clerk.EmailAddress{addr("email_1", "old@x.co"), addr("email_2", "main@x.co")},
			}, "main@x.co"},
		{"falls back to the first when the primary id matches nothing",
			clerk.User{
				PrimaryEmailAddressID: &primary,
				EmailAddresses:        []*clerk.EmailAddress{addr("email_9", "only@x.co")},
			}, "only@x.co"},
		{"empty for an account with no email (phone-only signup)",
			clerk.User{}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := primaryEmail(&tc.u); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}
