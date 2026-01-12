"use client"

import Header from "@/components/header"
import { Engine, EngineStats, Vec3 } from "reze-engine"
import { useCallback, useEffect, useRef, useState } from "react"
import Loading from "@/components/loading"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Play, Pause } from "lucide-react"

// Format time as M:SS or MM:SS (with leading zero)
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, "0")}`
}

// Format remaining time (negative time shows as "-0:23")
function formatRemainingTime(current: number, duration: number): string {
  const remaining = duration - current
  if (remaining <= 0) return "0:00"
  const mins = Math.floor(remaining / 60)
  const secs = Math.floor(remaining % 60)
  return `-${mins}:${secs.toString().padStart(2, "0")}`
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<EngineStats | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [progress, setProgress] = useState({ current: 0, duration: 0, percentage: 0 })
  const [selectedMaterial, setSelectedMaterial] = useState<string | null>(null)
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 })
  const [rippleId, setRippleId] = useState(0)

  // Update progress using requestAnimationFrame for smooth updates
  useEffect(() => {
    let rafId: number | null = null

    const updateProgress = () => {
      if (engineRef.current && isPlaying && !isPaused) {
        const prog = engineRef.current.getAnimationProgress()
        setProgress(prog)

        // Auto-pause when animation ends
        if (prog.percentage >= 100) {
          setIsPlaying(false)
          setIsPaused(false)
        } else {
          rafId = requestAnimationFrame(updateProgress)
        }
      }
    }

    if (isPlaying && !isPaused) {
      rafId = requestAnimationFrame(updateProgress)
    }

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
    }
  }, [isPlaying, isPaused])

  // Create and preload audio element on mount
  useEffect(() => {
    const audio = new Audio("/IRIS OUT.wav")
    audio.preload = "auto"
    audio.setAttribute("playsinline", "true")
    audio.setAttribute("webkit-playsinline", "true")
    audio.volume = 1.0
    audio.muted = false

    // Add to DOM (iOS requirement)
    Object.assign(audio.style, {
      display: "none",
      position: "absolute",
      visibility: "hidden",
      width: "0",
      height: "0",
    })
    document.body.appendChild(audio)

    audio.load()

    audio.addEventListener("loadeddata", () => {
      audioRef.current = audio
    })

    audio.addEventListener("error", () => {
      console.warn("Audio failed to load")
    })

    return () => {
      audio.pause()
      audio.parentNode?.removeChild(audio)
    }
  }, [])

  // Play animation
  const handlePlay = useCallback(async () => {
    if (engineRef.current) {
      // iOS CRITICAL: Call audio.play() DIRECTLY from click handler
      // This must be synchronous - no async/await, no callbacks
      if (audioRef.current) {
        audioRef.current.muted = false
        audioRef.current.volume = 1.0
        audioRef.current.currentTime = progress.current
        // Call play() directly - synchronous from user interaction
        audioRef.current.play().catch(() => {
          // Silent fail
        })
      }

      // If animation has ended (at 100%), restart from beginning
      if (progress.percentage >= 100) {
        engineRef.current.seekAnimation(0)
        if (audioRef.current) {
          audioRef.current.currentTime = 0
        }
        setProgress({ ...progress, current: 0, percentage: 0 })
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      engineRef.current.playAnimation()
      setIsPlaying(true)
      setIsPaused(false)
    }
  }, [progress])

  // Pause animation
  const handlePause = useCallback(() => {
    if (engineRef.current) {
      engineRef.current.pauseAnimation()
      if (audioRef.current) {
        audioRef.current.pause()
      }
      setIsPaused(true)
    }
  }, [])

  // Resume animation
  const handleResume = useCallback(() => {
    if (engineRef.current) {
      // iOS CRITICAL: Call audio.play() DIRECTLY from click handler
      if (audioRef.current) {
        audioRef.current.play().catch(() => {
          // Silent fail
        })
      }
      engineRef.current.playAnimation()
      setIsPaused(false)
    }
  }, [])

  // Seek to position
  const handleSeek = useCallback(
    (value: number[]) => {
      if (engineRef.current && progress.duration > 0) {
        const seekTime = (value[0] / 100) * progress.duration
        engineRef.current.seekAnimation(seekTime)
        if (audioRef.current) {
          audioRef.current.currentTime = seekTime
        }
        setProgress({ ...progress, current: seekTime, percentage: value[0] })
      }
    },
    [progress]
  )

  const initEngine = useCallback(async () => {
    if (canvasRef.current) {
      // Initialize engine
      try {
        const engine = new Engine(canvasRef.current, {
          ambientColor: new Vec3(0.85, 0.9, 0.98),
          cameraDistance: 30,
          cameraTarget: new Vec3(0, 12, 0),
          onRaycast: (material: string | null, screenX: number, screenY: number) => {
            console.log("material", material)

            // Update mouse position for ripple effect
            setMousePosition({ x: screenX, y: screenY })

            if (material) {
              // Start new ripple animation each time material is clicked
              setRippleId((prev) => prev + 1)
            }
            setSelectedMaterial(material)
          },
        })
        engineRef.current = engine
        await engine.init()
        await engine.loadModel("/models/reze/reze_smol.pmx")
        engine.addGround({
          width: 160,
          height: 160,
          fadeStart: 10.0,
          fadeEnd: 100.0,
          diffuseColor: new Vec3(0.9, 0.5, 1.0),
        })

        setLoading(false)

        engine.runRenderLoop(() => {
          setStats(engine.getStats())
        })
        engine.setMorphWeight("抗穿模", 1.0)
        console.log("materials", engine.getMaterials())
        console.log("bones", engine.getBones())
        console.log("morphs", engine.getMorphs())
        // engine.setMaterialVisible("材質1", false)
        // engine.setMaterialVisible("GT Bow Button Blouse", false)

        await engine.loadAnimation("/animations/IRIS OUT.vmd")
        const prog = engine.getAnimationProgress()
        setProgress(prog)
      } catch (error) {
        setEngineError(error instanceof Error ? error.message : "Unknown error")
      }
    }
  }, [])

  useEffect(() => {
    void (async () => {
      initEngine()
    })()

    // Cleanup on unmount
    return () => {
      if (engineRef.current) {
        engineRef.current.dispose()
      }
      if (audioRef.current) {
        audioRef.current.pause()
        if (audioRef.current.parentNode) {
          audioRef.current.parentNode.removeChild(audioRef.current)
        }
      }
    }
  }, [initEngine])

  // Space key shortcut for play/pause
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle space if not typing in an input/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      if (e.code === "Space" || e.key === " ") {
        e.preventDefault()
        if (isPlaying && !isPaused) {
          handlePause()
        } else if (isPaused) {
          handleResume()
        } else {
          handlePlay()
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isPlaying, isPaused, handlePlay, handlePause, handleResume])

  return (
    <div className="fixed inset-0 w-full h-full overflow-hidden touch-none">
      <Header stats={stats} />

      {engineError && (
        <div className="absolute inset-0 w-full h-full flex items-center justify-center text-white p-6 z-50 text-lg font-medium">
          Engine Error: {engineError}
        </div>
      )}
      {loading && !engineError && <Loading loading={loading} />}

      {/* Ripple effect around cursor when material is selected */}
      {selectedMaterial && (
        <div
          key={rippleId}
          className="absolute pointer-events-none z-2"
          style={{
            left: mousePosition.x - 35,
            top: mousePosition.y - 35,
            width: 70,
            height: 70,
          }}
        >
          <div
            className="w-full h-full rounded-full"
            style={{
              background:
                "radial-gradient(circle, rgba(255,59,48,1) 0%, rgba(255,59,48,0.9) 20%, rgba(255,59,48,0.7) 40%, rgba(255,59,48,0.6) 60%, rgba(255,59,48,0.1) 80%, transparent 100%)",
              boxShadow:
                "0 0 35px rgba(255,59,48,1.0), 0 0 70px rgba(255,59,48,0.7), inset 0 0 25px rgba(255,59,48,0.5)",
              animation: "ripple 0.5s ease-out forwards",
            }}
          />
        </div>
      )}

      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full touch-none z-1" />

      {/* Player Controls */}
      {!loading && !engineError && (
        <div className="absolute bottom-4 left-4 right-4 z-50 ">
          <div className="max-w-4xl mx-auto  px-2 pr-4 bg-black/30 backdrop-blur-xs rounded-full outline-none">
            {/* Single Row: Play/Pause - Time - Slider - Remaining Time */}
            <div className="flex items-center gap-3">
              {/* Play/Pause Button (Left) */}
              {!isPlaying ? (
                <Button onClick={handlePlay} size="icon" variant="ghost" aria-label="Play">
                  <Play />
                </Button>
              ) : isPaused ? (
                <Button onClick={handleResume} size="icon" variant="ghost" aria-label="Resume">
                  <Play />
                </Button>
              ) : (
                <Button onClick={handlePause} size="icon" variant="ghost" aria-label="Pause">
                  <Pause />
                </Button>
              )}

              {/* Start Time */}
              <div className="text-white text-sm font-mono tabular-nums">{formatTime(progress.current)}</div>

              {/* Progress Slider */}
              <div className="flex-1">
                <Slider
                  value={[progress.percentage]}
                  onValueChange={handleSeek}
                  min={0}
                  max={100}
                  step={0.001}
                  className="w-full"
                  disabled={progress.duration === 0}
                />
              </div>

              {/* Remaining Time (Right) */}
              <div className="text-muted-foreground text-sm font-mono tabular-nums text-right">
                {formatRemainingTime(progress.current, progress.duration)}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
