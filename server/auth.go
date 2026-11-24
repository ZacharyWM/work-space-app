// join gate (port of server/src/auth.ts): clerk session token verification and
// the first-join display name rule. Verification hits clerk's JWKS endpoint
// once per signing key and caches it — session tokens arrive on every picker
// message, so a per-call fetch would hammer the API
package main

import (
	"context"
	"log"
	"strings"
	"sync"

	"github.com/clerk/clerk-sdk-go/v2"
	clerkjwt "github.com/clerk/clerk-sdk-go/v2/jwt"
	josejwt "github.com/go-jose/go-jose/v3/jwt"
)

// signing keys by key id; clerk rotates rarely, so a miss refetches and a
// stale entry is dropped when verification fails
var jwkCache sync.Map

// the cached JWK for a token's key id, fetched on first sight
func jwkFor(ctx context.Context, kid string) (*clerk.JSONWebKey, error) {
	if cached, ok := jwkCache.Load(kid); ok {
		return cached.(*clerk.JSONWebKey), nil
	}
	jwk, err := clerkjwt.GetJSONWebKey(ctx, &clerkjwt.GetJSONWebKeyParams{KeyID: kid})
	if err != nil {
		return nil, err
	}
	jwkCache.Store(kid, jwk)
	return jwk, nil
}

// verify a clerk session token; the clerk user id (sub) on success, "" on any
// failure — expired, malformed, wrong instance. The caller rejects empties
func verifyClerkToken(ctx context.Context, token string) string {
	parsed, err := josejwt.ParseSigned(token)
	if err != nil || len(parsed.Headers) == 0 {
		return ""
	}
	kid := parsed.Headers[0].KeyID
	jwk, err := jwkFor(ctx, kid)
	if err != nil {
		log.Printf("clerk jwks fetch failed: %v", err)
		return ""
	}
	claims, err := clerkjwt.Verify(ctx, &clerkjwt.VerifyParams{Token: token, JWK: jwk})
	if err != nil {
		// the key may have rotated under the cache: drop it and retry once
		jwkCache.Delete(kid)
		jwk, ferr := jwkFor(ctx, kid)
		if ferr != nil {
			return ""
		}
		claims, err = clerkjwt.Verify(ctx, &clerkjwt.VerifyParams{Token: token, JWK: jwk})
		if err != nil {
			return ""
		}
	}
	return claims.Subject
}

// the clerk profile fields a default display name can come from; structural so
// tests don't need a real clerk User
type clerkNameSource struct {
	firstName string
	username  string
	email     string
}

// pick the first-join display name from a clerk profile: first name, then
// username, then the email's local part, then a generic fallback
func defaultDisplayName(u clerkNameSource) string {
	if s := strings.TrimSpace(u.firstName); s != "" {
		return s
	}
	if s := strings.TrimSpace(u.username); s != "" {
		return s
	}
	if local, _, _ := strings.Cut(u.email, "@"); strings.TrimSpace(local) != "" {
		return strings.TrimSpace(local)
	}
	return "Crew Member"
}

// the account's primary email, falling back to the first listed; "" when the
// account has none (phone-only signups exist)
func primaryEmail(u *clerk.User) string {
	if u.PrimaryEmailAddressID != nil {
		for _, e := range u.EmailAddresses {
			if e.ID == *u.PrimaryEmailAddressID {
				return e.EmailAddress
			}
		}
	}
	if len(u.EmailAddresses) > 0 {
		return u.EmailAddresses[0].EmailAddress
	}
	return ""
}

// flatten a clerk backend user into the name source fields
func nameSourceOf(u *clerk.User) clerkNameSource {
	src := clerkNameSource{}
	if u.FirstName != nil {
		src.firstName = *u.FirstName
	}
	if u.Username != nil {
		src.username = *u.Username
	}
	if len(u.EmailAddresses) > 0 {
		src.email = u.EmailAddresses[0].EmailAddress
	}
	return src
}
