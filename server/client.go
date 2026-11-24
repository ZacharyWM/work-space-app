// one websocket connection (replaces Node ws socket semantics): writes are
// buffered through a channel + writer goroutine so a slow client can never
// stall the global state lock, and a per-connection ping/pong heartbeat
// terminates dead transports like the TS sweep did
package main

import (
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// per-connection outbound buffer; a client this far behind is not coming back
const outboundBuffer = 256

// deadline for individual frame writes; a transport stuck longer is dead
const writeTimeout = 10 * time.Second

type client struct {
	conn *websocket.Conn
	// marshaled frames awaiting the writer goroutine; nil data = polite close
	out chan []byte
	// closed exactly once to stop the writer + heartbeat goroutines
	quit     chan struct{}
	quitOnce sync.Once
	// false once the connection is closed or closing — sessions must not be
	// created for a socket that died during a join's db calls
	open atomic.Bool
	// heartbeat liveness flag: cleared before each ping, set back by the pong
	alive atomic.Bool

	// session bindings, the TS per-socket closure vars; touched only by this
	// connection's read loop (handlers + close cleanup), so no lock of their own
	selfID      string
	room        *roomState
	workspaceID string
	isOwner     bool
	// the session's home workspace (space link feature): equals workspaceID
	// except while this connection is out on a Visit
	homeID   string
	homeSlug string
	homeName string
	// open user_workspace_sessions row for this stay ("" = none); ended by the
	// close cleanup — every leave path (kick, evict, takeover) closes the socket
	sessionRowID string
}

func newClient(conn *websocket.Conn) *client {
	c := &client{
		conn: conn,
		out:  make(chan []byte, outboundBuffer),
		quit: make(chan struct{}),
	}
	c.open.Store(true)
	c.alive.Store(true)
	// pongs ride the read loop; the handler just flips the liveness flag
	conn.SetPongHandler(func(string) error {
		c.alive.Store(true)
		return nil
	})
	return c
}

// marshal + queue one message; dropped silently once the connection is
// closing (Node's send on a closed socket was a no-op too). A full buffer
// means a hopelessly slow client — terminate it
func (c *client) send(msg any) {
	if !c.open.Load() {
		return
	}
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("encode failed: %v", err)
		return
	}
	select {
	case c.out <- data:
	default:
		log.Printf("outbound buffer full, terminating slow client")
		c.terminate()
	}
}

// polite close: everything already queued is flushed, then a close frame is
// sent and the transport dropped (the ws socket.close() analogue)
func (c *client) close() {
	if !c.open.CompareAndSwap(true, false) {
		return
	}
	select {
	case c.out <- nil:
	default:
		// buffer full — skip the pleasantries
		c.shutdown()
	}
}

// abrupt close, the ws socket.terminate() analogue: no close frame, the read
// loop errors out immediately
func (c *client) terminate() {
	c.open.Store(false)
	c.shutdown()
}

func (c *client) isOpen() bool { return c.open.Load() }

// stop the writer + heartbeat and drop the transport; safe to call repeatedly
func (c *client) shutdown() {
	c.quitOnce.Do(func() { close(c.quit) })
	_ = c.conn.Close()
}

// writer goroutine: the only place data frames touch the transport
func (c *client) writeLoop() {
	for {
		select {
		case data := <-c.out:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if data == nil {
				// polite close: frame out, then drop the transport
				_ = c.conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				c.shutdown()
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				c.terminate()
				return
			}
		case <-c.quit:
			return
		}
	}
}

// heartbeat goroutine: ping on a cadence, terminate when a ping goes
// unanswered (same sweep the TS server ran per socket)
func (c *client) heartbeat() {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if !c.alive.Load() {
				// no pong since the last ping — the read loop's error path
				// runs the close cleanup
				c.terminate()
				return
			}
			c.alive.Store(false)
			// WriteControl is safe alongside the writer goroutine
			if err := c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeTimeout)); err != nil {
				c.terminate()
				return
			}
		case <-c.quit:
			return
		}
	}
}
