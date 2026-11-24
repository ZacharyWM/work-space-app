# Feature list — what similar apps have that we don't

Research sources: Gather.town (features page, 2025 updates), Teamflow,
SpatialChat, Kumospace, SoWork, WorkAdventure comparisons. Ordered by
importance (most important first). "Importance" weighs how universal the
feature is across competitors, how loudly its absence is felt in daily use,
and how well it fits this app's zone-based model.

Already covered here, so excluded: zone-based A/V, screen share, meeting
grid view, avatar customization, presence status, waves, multiple
workspaces, member management, claimable personal spaces (pods), decor.

## The list

1. **Text chat** — every competitor has it (Kumospace gets criticized for
   its weak group chat). Talk without unmuting: paste a link to the people
   in your zone, ping the whole ship when someone's mic is broken, leave a
   note for whoever's around. Scopes in Gather: nearby / room / everyone.
2. **Emoji reactions / emotes** — Gather's number-key emotes and confetti
   ("react with 🎉, press F for confetti"). A transient emoji above the
   avatar: agree/disagree/wave/celebrate in a meeting without interrupting
   the speaker.
3. **Locate & follow a teammate** — Gather's "locate on map" draws a path
   to a person; follow walks you to them. Without it, finding someone on a
   big map is squint-and-scroll. Pairs naturally with the crew panel we
   already have.
4. **Megaphone / ship-wide announcement** — Gather's spotlight/megaphone:
   one person addresses everyone regardless of room. The text version
   (broadcast banner + chime) covers the daily "standup in the bridge in 5"
   use without new A/V topology.
5. **Minimap** — small overview map showing the whole deck and where
   everyone is. SoWork/Teamflow surface this as the "glance at the office"
   view; our map already scrolls well past one screen at walking zoom.
6. **Do-not-disturb mode** — status that actually enforces: suppress wave
   chimes/toasts and chat pings while Busy. We show status but it changes
   nothing.
7. **Custom status text** — a free-text line ("back at 3", "deep work til
   noon") next to the status dot, visible in the crew panel and on hover.
8. **Interactive objects / embedded apps** — Gather/SpatialChat embed
   whiteboards, docs, and websites in objects you walk up to and press a
   key to open. Big feature; needs an iframe overlay + object interaction
   protocol.
9. **Proximity audio falloff** — SpatialChat/Kumospace fade volume with
   avatar distance inside a space. We connect binary per zone; falloff
   inside big zones would soften the "everyone equally loud" feel.
10. **Calendar / Slack integration** — Gather syncs calendar to
    auto-update status and pull meetings into rooms. External-service
    dependency, heavy setup.
11. **AI meeting notes** — Gather 2025 flagship: transcription + summaries
    of zone meetings. Heavy (recording consent, storage, an LLM bill).
12. **Map editor / custom offices** — competitors let teams build their own
    floor plan. Our map is one shared JSON by design (every workspace is
    the same ship), so this is a philosophy change, not a gap.
    *(Implemented 2026-07-07 by request: per-workspace maps, creator-only
    editor — see progress.md.)*
13. **Mini mode / simplified view** — Gather's compact always-on-top window
    for staying reachable while in other apps. Browser PiP could fake it,
    but it's a niche of a niche at our scale.
14. **Guest roles / permissions** — moderator vs member vs guest tiers.
    We deliberately have link-based access + creator-only admin; finer
    tiers add value only for bigger orgs.

## Implemented from this list (top 5)

1. Text chat (zone + ship scopes, in-session history)
2. Emoji reactions above avatars
3. Locate a teammate from the crew panel
4. Ship-wide announcement (megaphone)
5. Minimap

## Implemented later by request

12. Map editor / custom offices (creator-only workspace layout editing)
