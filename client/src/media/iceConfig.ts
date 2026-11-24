// ICE configuration in one place: the server mints the authoritative list
// (STUN + short-lived TURN credentials) into every welcome (step 5.4)
import type { IceServer } from "shared";

// ?relay forces every connection through TURN — debug flag for verifying the
// relay path (step 5.4 verify)
const forceRelay = new URLSearchParams(location.search).has("relay");

// pre-welcome fallback only; peerConnect directives always follow a welcome,
// so real connections use the server-minted list set below
let iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// called on every welcome with the minted list from the server
export function setIceServers(servers: IceServer[]): void {
  iceServers = servers;
}

// read at RTCPeerConnection construction time, per pair
export function rtcConfig(): RTCConfiguration {
  return forceRelay ? { iceServers, iceTransportPolicy: "relay" } : { iceServers };
}
