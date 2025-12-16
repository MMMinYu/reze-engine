"use client"

import Header from "@/components/header"
import { Engine, EngineStats, Vec3 } from "reze-engine"
import { useCallback, useEffect, useRef, useState } from "react"
import Loading from "@/components/loading"
import { Button } from "@/components/ui/button"
import { Music, VolumeX, Play } from "lucide-react"
import Image from "next/image"

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<EngineStats | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const audioStartedRef = useRef(false)

  // Start audio playback from 22 seconds
  const startAudio = useCallback(() => {
    if (audioRef.current && !audioStartedRef.current) {
      audioStartedRef.current = true
      audioRef.current.currentTime = 0
      audioRef.current.volume = 1.0
      // audioRef.current.loop = true
      audioRef.current.play().catch(() => {
        // Silently handle autoplay restrictions
        audioStartedRef.current = false
      })
    }
  }, [])

  // Start both animation and audio together
  const handlePlay = useCallback(async () => {
    if (engineRef.current && !isPlaying) {
      await engineRef.current.loadAnimation("/animations/IRIS OUT.vmd")

      engineRef.current.playAnimation()
      startAudio()
      setIsPlaying(true)
    }
  }, [isPlaying, startAudio])

  const initEngine = useCallback(async () => {
    if (canvasRef.current) {
      // Initialize engine
      try {
        const engine = new Engine(canvasRef.current, {
          ambientColor: new Vec3(0.75, 0.85, 1.0),
          bloomIntensity: 0.15,
          rimLightIntensity: 0.4,
          cameraDistance: 26.5,
          cameraTarget: new Vec3(0, 12.1, 0),
        })
        engineRef.current = engine
        await engine.init()
        await engine.loadModel("/models/塞尔凯特2/塞尔凯特2.pmx")

        setLoading(false)

        engine.runRenderLoop(() => {
          setStats(engine.getStats())
        })

        // Wait a frame to ensure render loop has started and model is fully initialized
        // This prevents physics explosion when animation starts
        await new Promise((resolve) => requestAnimationFrame(resolve))
        // Don't auto-start animation - wait for user to click play button
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
        audioRef.current = null
      }
    }
  }, [initEngine])

  // Handle mute/unmute toggle
  const toggleMute = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.muted = !isMuted
      setIsMuted(!isMuted)
    }
  }, [isMuted])

  return (
    <div className="fixed inset-0 w-full h-full overflow-hidden touch-none">
      <Header stats={stats} />

      {engineError && (
        <div className="absolute inset-0 w-full h-full flex items-center justify-center text-white p-6">
          Engine Error: {engineError}
        </div>
      )}
      {loading && !engineError && <Loading loading={loading} />}
      <div className="absolute inset-0 w-full h-full flex justify-center items-center">
        <Image
          src="/pool.jpeg"
          alt="Reze Engine"
          width={1000}
          height={1000}
          className="w-full h-full md:h-auto touch-none z-0 object-cover"
        />
      </div>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full touch-none z-1" />

      {/* Audio element */}
      <audio ref={audioRef} src="/IRIS OUT.wav" preload="auto" className="hidden" />

      {/* Play button overlay */}
      {!loading && !isPlaying && !engineError && (
        <div className="absolute inset-0 w-full h-full flex items-center justify-center z-40 bg-black/30 backdrop-blur-sm">
          <Button
            onClick={handlePlay}
            size="lg"
            className="rounded-full w-20 h-20 shadow-2xl hover:shadow-3xl hover:scale-110 transition-all bg-white/70 hover:bg-white text-black"
            aria-label="Play animation and audio"
          >
            <Play className="size-6" fill="currentColor" />
          </Button>
        </div>
      )}

      {/* Floating mute button - only show when playing */}
      {isPlaying && (
        <Button
          onClick={toggleMute}
          variant="secondary"
          size="icon"
          className="fixed bottom-6 right-6 z-50 rounded-full shadow-lg hover:shadow-xl transition-all"
          aria-label={isMuted ? "Unmute audio" : "Mute audio"}
        >
          {isMuted ? <VolumeX className="h-6 w-6" /> : <Music className="h-6 w-6" />}
        </Button>
      )}
    </div>
  )
}
