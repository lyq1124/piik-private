package signal

import (
	"testing"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func TestIndependentVoiceChannelDefaultsOpenWithoutCaptureOrRoutes(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	authenticate(t, host, h.room, protocol.RoleHost, "channel_host_123456", -1, "", presenceOptions{roomSession: true, roomOnly: true})
	host.sendJSON(map[string]any{"type": "subscribe-room-voice", "channelControl": true})
	state := nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return state.Enabled })
	if len(state.Publications) != 0 || len(state.Connections) != 0 || len(state.Members) != 1 || state.Members[0].Joined {
		t.Fatal("default opening joined a person, captured audio, or allocated a connection")
	}
	h.locked(func() {
		if rm, _ := h.server.router.rooms.Get(h.room.RoomID); rm != nil && rm.controller != nil {
			t.Fatal("an empty open channel allocated a media controller")
		}
	})
	voiceCommand(host, map[string]any{"action": "publish"})
	host.next("room-voice-error")
	voiceCommand(host, map[string]any{"action": "close"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return !state.Enabled })
	host.sendJSON(map[string]any{"type": "subscribe-room-voice", "channelControl": true})
	state = nextVoiceState(t, host, nil)
	if state.Enabled {
		t.Fatal("resubscription reopened a deliberately closed channel")
	}
}

func TestUnjoinedHostRelaysViewersWithoutBecomingAListener(t *testing.T) {
	h := startHarness(t, harnessOptions{})
	host := openClient(t, h)
	hostID := authenticate(t, host, h.room, protocol.RoleHost, "relay_only_host_123456", -1, "", presenceOptions{roomSession: true, roomOnly: true})
	host.sendJSON(map[string]any{"type": "subscribe-room-voice", "channelControl": true})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return state.Enabled })
	viewers := []*testClient{openClient(t, h), openClient(t, h)}
	for index, viewer := range viewers {
		identity := []string{"relay_viewer_one_123456", "relay_viewer_two_123456"}[index]
		authenticate(t, viewer, h.room, protocol.RoleViewer, identity, 0, "", presenceOptions{})
		viewer.sendJSON(map[string]any{"type": "subscribe-room-voice"})
		nextVoiceState(t, viewer, nil)
		voiceCommand(viewer, map[string]any{"action": "join"})
		pending := nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
			return len(state.Connections) == 1 && state.Connections[0].Pending
		})
		for _, client := range []*testClient{host, viewer} {
			client.sendJSON(map[string]any{"type": "room-voice-transport", "connectionId": pending.Connections[0].ConnectionID, "state": "connected"})
		}
		nextVoiceState(t, viewer, func(state protocol.RoomVoiceStateMessage) bool {
			return len(state.Connections) == 1 && !state.Connections[0].Pending
		})
		voiceCommand(viewer, map[string]any{"action": "publish"})
		nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return len(state.Publications) == index+1 })
	}
	state := nextVoiceState(t, viewers[0], func(state protocol.RoomVoiceStateMessage) bool {
		return len(state.Publications) == 2 && len(state.Connections[0].Receive) == 1
	})
	for _, member := range state.Members {
		if member.PeerID == hostID.PeerID && (member.Joined || member.PublicationID != "") {
			t.Fatal("relay-only Host was represented as a listener or speaker")
		}
	}
	h.locked(func() {
		if h.server.voiceAllowed(h.room.RoomID, hostID.PeerID) || !h.server.voiceTransportAllowed(h.room.RoomID, hostID.PeerID) {
			t.Fatal("forwarding permission was confused with listening permission")
		}
	})
	voiceCommand(host, map[string]any{"action": "join"})
	nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
		for _, member := range state.Members {
			if member.PeerID == hostID.PeerID {
				return member.Joined
			}
		}
		return false
	})
	voiceCommand(host, map[string]any{"action": "leave-self"})
	state = nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool {
		for _, member := range state.Members {
			if member.PeerID == hostID.PeerID {
				return !member.Joined
			}
		}
		return false
	})
	if !state.Enabled || len(state.Publications) != 2 || len(state.Connections) != 2 {
		t.Fatal("Host leaving personally closed the viewers' voice")
	}
	voiceCommand(host, map[string]any{"action": "close"})
	state = nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return !state.Enabled })
	if len(state.Publications) != 0 || len(state.Connections) != 0 {
		t.Fatal("closed channel retained media")
	}
	voiceCommand(host, map[string]any{"action": "open"})
	state = nextVoiceState(t, host, func(state protocol.RoomVoiceStateMessage) bool { return state.Enabled })
	for _, member := range state.Members {
		if member.Joined || member.PublicationID != "" {
			t.Fatal("reopening restored participation")
		}
	}
}

func TestIndependentChannelCommandsRequireHostOptIn(t *testing.T) {
	h, host, viewer, _, _ := joinedVoiceOwnerRoom(t)
	_ = h
	for _, client := range []*testClient{host, viewer} {
		for _, action := range []string{"open", "close", "leave-self"} {
			voiceCommand(client, map[string]any{"action": action})
			client.next("room-voice-error")
		}
	}
}
