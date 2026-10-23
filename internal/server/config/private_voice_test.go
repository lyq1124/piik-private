package config

import "testing"

func TestRoomVoiceIsExplicitAndRequiresExistingMediaListener(t *testing.T) {
	for _, test := range []struct {
		value, port string
		want        int
		valid       bool
	}{
		{"", "", 0, true}, {"0", "", 0, true}, {"1", "", 0, false}, {"1", "7882", 1, true}, {"-1", "7882", 0, false}, {"9001", "7882", 0, false}, {"1.5", "7882", 0, false},
	} {
		env := map[string]string{"ROOM_VOICE_MAX_ROOMS": test.value, "SFU_UDP_PORT": test.port}
		c, err := Load(env)
		if (err == nil) != test.valid {
			t.Errorf("voice=%q port=%q err=%v", test.value, test.port, err)
		}
		if err == nil && c.RoomVoiceMaxRooms != test.want {
			t.Errorf("room capacity=%d", c.RoomVoiceMaxRooms)
		}
	}
}
