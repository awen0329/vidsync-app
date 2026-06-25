// memlistener.go provides an in-memory net.Listener so the embedded
// sync daemon's REST API can be served without opening any socket.
// The daemon's http.Server Accept()s connections from here; the Wails
// proxies (proxy.go, mediaserver.go) Dial them. Both ends are halves of
// an in-process net.Pipe, so there is no TCP/unix endpoint for a
// browser — or anything else outside this process — to reach.

package main

import (
	"context"
	"errors"
	"net"
	"sync"
)

var errMemListenerClosed = errors.New("vidsync: in-memory daemon listener closed")

// memListener is a net.Listener whose connections never touch the
// network stack. Accept yields the server end of a pipe; DialContext
// yields the client end.
type memListener struct {
	conns     chan net.Conn
	done      chan struct{}
	closeOnce sync.Once
}

func newMemListener() *memListener {
	return &memListener{
		conns: make(chan net.Conn),
		done:  make(chan struct{}),
	}
}

// Accept is called by the daemon's http.Server. It blocks until a proxy
// dials or the listener is shut down.
func (l *memListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, errMemListenerClosed
	}
}

// Close is intentionally a no-op. lib/api closes its listener on every
// soft-restart (e.g. after a GUI config change); if that tore this
// listener down, the proxy could no longer reach the daemon after the
// first such change. Real teardown is shutdown(), called once from
// daemonHandle.stop() when the whole app exits.
func (l *memListener) Close() error { return nil }

// shutdown permanently closes the listener, unblocking any pending
// Accept/DialContext. Idempotent.
func (l *memListener) shutdown() {
	l.closeOnce.Do(func() { close(l.done) })
}

func (l *memListener) Addr() net.Addr { return memAddr{} }

// DialContext is wired into the proxies' http.Transport. The network
// and address arguments are ignored — every dial reaches this one
// in-process daemon. Handing the server end to Accept and returning the
// client end gives the http.Server and the proxy a connected pipe.
func (l *memListener) DialContext(ctx context.Context, _, _ string) (net.Conn, error) {
	server, client := net.Pipe()
	select {
	case l.conns <- server:
		return client, nil
	case <-l.done:
		server.Close()
		client.Close()
		return nil, errMemListenerClosed
	case <-ctx.Done():
		server.Close()
		client.Close()
		return nil, ctx.Err()
	}
}

// memAddr is the net.Addr reported for the in-memory listener and its
// connections. The host portion ("vidsync-daemon") is what the proxies
// put in the request URL; it's cosmetic since DialContext ignores it.
type memAddr struct{}

func (memAddr) Network() string { return "mem" }
func (memAddr) String() string  { return "vidsync-daemon" }
