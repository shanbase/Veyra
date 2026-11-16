import { useEffect, useState, type RefObject } from "react";
import { Music, Pause, Play, Square, Volume2, VolumeX } from "lucide-react";
import type { ProfileSong } from "@/lib/profileFields";

interface ProfileSongDiscProps {
  song: ProfileSong;
  audioRef: RefObject<HTMLAudioElement>;
  playing: boolean;
}

// A vinyl-style disc beside the avatar. Click toggles play/pause; hovering
// expands a small horizontal control bar with stop and volume.
export function ProfileSongDisc({ song, audioRef, playing }: ProfileSongDiscProps) {
  // Profile songs start at a comfortable 50% — full volume is jump-scarey.
  const [volume, setVolume] = useState(0.5);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    if (el) {
      el.volume = 0.5;
      el.muted = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const audio = () => audioRef.current;

  const toggle = () => {
    const el = audio();
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };

  const stop = () => {
    const el = audio();
    if (!el) return;
    el.pause();
    el.currentTime = 0;
  };

  const changeVolume = (value: number) => {
    setVolume(value);
    const el = audio();
    if (el) {
      el.volume = value;
      el.muted = value === 0;
      setMuted(value === 0);
    }
  };

  const toggleMute = () => {
    const el = audio();
    const next = !muted;
    setMuted(next);
    if (el) el.muted = next;
  };

  return (
    <div className="group relative flex items-center">
      {/* Expanded controls — appears to the right of the disc on hover/focus */}
      <div className="absolute left-full top-1/2 z-20 ml-2 hidden -translate-y-1/2 items-center gap-1.5 rounded-full border border-border bg-card/95 px-2.5 py-1.5 shadow-lg backdrop-blur group-hover:flex group-focus-within:flex">
        <button
          type="button"
          onClick={toggle}
          className="rounded-full p-1 text-foreground transition-colors hover:bg-muted"
          aria-label={playing ? "Pause profile song" : "Play profile song"}
          title={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={stop}
          className="rounded-full p-1 text-foreground transition-colors hover:bg-muted"
          aria-label="Stop profile song"
          title="Stop"
        >
          <Square className="h-3 w-3" />
        </button>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => changeVolume(Number(e.target.value))}
          className="h-1 w-16 cursor-pointer accent-primary"
          aria-label="Profile song volume"
        />
        <button
          type="button"
          onClick={toggleMute}
          className="rounded-full p-1 text-foreground transition-colors hover:bg-muted"
          aria-label={muted ? "Unmute" : "Mute"}
          title={muted ? "Unmute" : "Mute"}
        >
          {muted || volume === 0 ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* The disc itself — click to play/pause */}
      <button
        type="button"
        onClick={toggle}
        className="veyra-vinyl-disc relative block h-14 w-14 flex-shrink-0 rounded-full shadow-md transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:h-16 sm:w-16"
        style={{
          background: "repeating-radial-gradient(circle at center, #2a2a30 0px, #2a2a30 1.5px, #17171b 1.5px, #17171b 3px)",
          ...(playing ? { animationPlayState: "running" } : {}),
        }}
        aria-label={playing ? `Pause ${song.title}` : `Play ${song.title}`}
        title={playing ? "Pause" : "Play"}
      >
        {/* Center label with cover art */}
        <span className="absolute inset-[26%] overflow-hidden rounded-full border border-white/10 bg-zinc-800">
          {song.artwork_url ? (
            <img src={song.artwork_url} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-zinc-400">
              <Music className="h-1/2 w-1/2" />
            </span>
          )}
        </span>
        {/* Spindle hole */}
        <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-950 ring-1 ring-white/20" />
      </button>
    </div>
  );
}
