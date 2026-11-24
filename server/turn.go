// ICE server minting (port of server/src/turn.ts): STUN always; when coturn is
// configured, a TURN entry with short-lived credentials in coturn's
// static-auth-secret format — username "<expiry unix seconds>:<label>",
// credential base64(HMAC-SHA1(secret, username)). Minted fresh on every welcome
package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
)

// long enough to outlive a workday session; a resume mints fresh credentials.
// past expiry only *new* peer connections lose relay candidates
const credentialTTLSeconds = 12 * 3600

// both come from the environment; nil (dev default) means STUN only
type turnConfig struct {
	secret string
	host   string
}

// public STUN, same entry the client used standalone
func stunServer() IceServer {
	return IceServer{URLs: []string{"stun:stun.l.google.com:19302"}}
}

func mintIceServers(turn *turnConfig, nowMs int64) []IceServer {
	if turn == nil {
		return []IceServer{stunServer()}
	}
	username := fmt.Sprintf("%d:blip-a", nowMs/1000+credentialTTLSeconds)
	mac := hmac.New(sha1.New, []byte(turn.secret))
	mac.Write([]byte(username))
	credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return []IceServer{
		stunServer(),
		{
			// plain UDP first (cheapest), TCP for UDP-blocked networks, TLS
			// 5349 for networks that only pass TLS-looking traffic
			URLs: []string{
				fmt.Sprintf("turn:%s:3478?transport=udp", turn.host),
				fmt.Sprintf("turn:%s:3478?transport=tcp", turn.host),
				fmt.Sprintf("turns:%s:5349?transport=tcp", turn.host),
			},
			Username:   username,
			Credential: credential,
		},
	}
}
