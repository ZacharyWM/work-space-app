// TURN credential minting tests (port of turn.test.ts)
package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestMintIceServersStunOnly(t *testing.T) {
	servers := mintIceServers(nil, 1_750_000_000_000)
	want := []IceServer{{URLs: []string{"stun:stun.l.google.com:19302"}}}
	if !reflect.DeepEqual(servers, want) {
		t.Errorf("got %+v, want %+v", servers, want)
	}
}

func TestMintIceServersCoturnCredentials(t *testing.T) {
	nowMs := int64(1_750_000_000_000)
	servers := mintIceServers(&turnConfig{secret: "s3cret", host: "turn.example.com"}, nowMs)
	if len(servers) != 2 {
		t.Fatalf("got %d servers, want 2", len(servers))
	}
	turn := servers[1]
	wantURLs := []string{
		"turn:turn.example.com:3478?transport=udp",
		"turn:turn.example.com:3478?transport=tcp",
		"turns:turn.example.com:5349?transport=tcp",
	}
	if !reflect.DeepEqual(turn.URLs, wantURLs) {
		t.Errorf("urls = %v, want %v", turn.URLs, wantURLs)
	}
	// username is "<now + ttl seconds>:<label>" — 12h ahead of nowMs
	if want := fmt.Sprintf("%d:blip-a", 1_750_000_000+12*3600); turn.Username != want {
		t.Errorf("username = %q, want %q", turn.Username, want)
	}
	// credential is base64(HMAC-SHA1(secret, username)), coturn's check exactly
	mac := hmac.New(sha1.New, []byte("s3cret"))
	mac.Write([]byte(turn.Username))
	if want := base64.StdEncoding.EncodeToString(mac.Sum(nil)); turn.Credential != want {
		t.Errorf("credential = %q, want %q", turn.Credential, want)
	}
}

func TestMintIceServersExpiryAdvances(t *testing.T) {
	cfg := &turnConfig{secret: "s3cret", host: "turn.example.com"}
	expiry := func(username string) int64 {
		n, _ := strconv.ParseInt(strings.SplitN(username, ":", 2)[0], 10, 64)
		return n
	}
	early := mintIceServers(cfg, 1_000_000)[1]
	late := mintIceServers(cfg, 1_060_000)[1]
	if d := expiry(late.Username) - expiry(early.Username); d != 60 {
		t.Errorf("expiry advanced by %d, want 60", d)
	}
}
