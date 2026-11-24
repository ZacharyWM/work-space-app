// room registry (port of server/src/rooms.ts): one roomState per workspace,
// created lazily on first join and reaped once it holds no sessions and no
// parked players — a room must outlive the grace window so drops can still
// resume into it. Caller holds main's global state mutex
package main

type roomRegistry struct {
	rooms map[string]*roomState
	// passed through to every room it creates
	graceMs int64
}

func newRoomRegistry(graceMs int64) *roomRegistry {
	return &roomRegistry{rooms: map[string]*roomState{}, graceMs: graceMs}
}

// the room for this workspace id, created on first use
func (g *roomRegistry) roomFor(workspaceID string) *roomState {
	room, ok := g.rooms[workspaceID]
	if !ok {
		room = newRoomState(g.graceMs)
		room.wid = workspaceID
		g.rooms[workspaceID] = room
	}
	return room
}

// every live room — the single-session rule scans all workspaces for an
// account's other sessions
func (g *roomRegistry) all() []*roomState {
	out := make([]*roomState, 0, len(g.rooms))
	for _, room := range g.rooms {
		out = append(out, room)
	}
	return out
}

// drop a workspace's room outright (the workspace was deleted); nil when no
// room was ever created (or it was already reaped)
func (g *roomRegistry) remove(workspaceID string) *roomState {
	room := g.rooms[workspaceID]
	delete(g.rooms, workspaceID)
	return room
}

// expire every room's parked players, then reap rooms left fully empty
func (g *roomRegistry) sweep(now int64) {
	for id, room := range g.rooms {
		room.sweepParked(now)
		if room.isEmpty() {
			delete(g.rooms, id)
		}
	}
}

// how many rooms are live (tests + reap logging)
func (g *roomRegistry) size() int { return len(g.rooms) }
