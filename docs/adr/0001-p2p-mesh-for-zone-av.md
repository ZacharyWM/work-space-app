# 1. P2P mesh for zone-scoped A/V

Date: 2026-07-02

## Status

Accepted

## Context

Audio/video only connects people standing in the same Zone. Expected scale is
~12 concurrent users total. A WebRTC P2P mesh requires each participant to
upload their media separately to every other participant in the zone: at N
occupants that is N-1 uplinks per client. With video, this degrades noticeably
around 5-6 occupants (upload bandwidth and encode CPU). An SFU (e.g. LiveKit)
removes that ceiling but adds a media server to deploy, monitor, and pay for,
and replaces hand-rolled signaling with an SDK dependency.

The obvious failure scenario was considered: all 12 users walking into one
zone for an all-hands. Mesh video will degrade there.

## Decision

Use P2P mesh, scoped per zone, with signaling relayed over the existing
WebSocket connection. No media server. Accept and document the ~5-6 person
per-zone video ceiling; a degraded all-hands is an acceptable v1 limitation.

## Consequences

- Server stays a single stateless-ish Node process; no media infra to run.
- Zones holding more than ~6 video participants will degrade (bandwidth/CPU).
  This is a known, accepted limitation, not a bug.
- If real usage regularly exceeds the ceiling, the migration path is an SFU
  (LiveKit); signaling and connection lifecycle code should not leak deep into
  UI components, to keep that swap contained.
