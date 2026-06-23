"use client"

import Header from "@/components/header"
import { Engine, EngineStats, Model, Vec3, type AnimationProgress, type MaterialPresetMap } from "reze-engine"
import { useCallback, useEffect, useRef, useState } from "react"
import Loading from "@/components/loading"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Pause, Play } from "lucide-react"

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

/** Scene models: same order as load — transport + seek drive all entries together. */
const SCENE_MODELS = [{ id: "fengjin", clip: "dance" }] as const

/**
 * 材质 → 形态键联动映射。
 * 这些材质的几何始终存在于身体网格上，是否凸起可见由对应形态键权重决定。
 * 勾选时同时设材质可见 + 形态键权重=1；取消时权重=0 + 隐藏材质。
 *
 * 映射关系经 MCP 连接 Blender 验证（分析 142 个形态键对所有材质 slot 的影响）：
 * 配饰类（显隐型）：形态键=1 时配饰凸起，=0 时塌陷贴在身体表面不可见。
 *
 * 注意多材质共用一个形态键的情况（如 Bgag+↑ 同时控制口球/口枷金属1/口球带1）：
 * 只需在主材质上登记，相关材质（口枷金属1/口球带1）跟随主材质的显隐即可，
 * 因为它们共用同一形态键，权重变化会同步影响所有相关几何。
 */
const MATERIAL_MORPH_LINK: Record<string, string[]> = {
  // 胸部配饰
  "乳贴": ["乳貼+↑"],
  "乳钉": ["乳釘+↑"],
  "乳首结": ["胸繩結+↑"],
  // 脸红叠加层（顏赤+ 控制 颜+ 材质的网格变形，贴图 颜赤.tga 提供红色）
  "颜+": ["顏赤+"],
  // 淫纹（PMX 材质名为 inmon1/inmon2，形态键为 inmon1+/inmon2+）
  "inmon1": ["inmon1+"],
  "inmon2": ["inmon2+"],
  // 眼罩（Blindfold+↑ 同时控制 眼罩 91% + 眼罩金属 9%）
  "眼罩": ["Blindfold+↑"],
  // 口球组（Bgag+↑ 同时控制 口球/口枷金属1/口球带1；舌变形也跟随口球扣）
  "口球": ["Bgag+↑"],
  "口球扣": ["舌丸める↑"], // 舌头默认圆润形态；細める/平める 是互斥变体，不自动设
  // 口枷第二组（Bgag2+↑ 同时控制 口枷金属2 75% + 口球带2 25%）
  "口枷金属2": ["Bgag2+↑"],
}

/**
 * 表情形态键分组（type=1 vertex morph），用于滑块面板。
 * 来源：PMX 模型全部 142 个形态键中筛除配饰/身体塑形类，保留表情/细节类。
 * 分组便于查找；滑块控制权重 0~1，支持无级调节。
 */
const EXPRESSION_GROUPS: { title: string; morphs: { name: string; label: string }[] }[] = [
  {
    title: "眉目",
    morphs: [
      { name: "怒り", label: "愤怒" },
      { name: "怒り右", label: "愤怒右" },
      { name: "真面目", label: "认真" },
      { name: "困る", label: "困扰" },
      { name: "やっかい", label: "麻烦" },
      { name: "悲しい", label: "悲伤" },
      { name: "ｷﾘｯ", label: "锐利" },
      { name: "ｷﾘｯ2", label: "锐利2" },
      { name: "喜び", label: "喜悦" },
      { name: "喜び2", label: "喜悦2" },
      { name: "慈愛", label: "慈爱" },
      { name: "慈愛2", label: "慈爱2" },
      { name: "びっくり", label: "吃惊" },
      { name: "驚かす", label: "惊吓" },
      { name: "じと目", label: "嫌弃" },
      { name: "じと目2", label: "嫌弃2" },
      { name: "なごみ", label: "温和" },
      { name: "はちゅ目", label: "半目" },
      { name: "はぁと", label: "爱心眼" },
      { name: "星目", label: "星星眼" },
      { name: "まばたき", label: "眨眼" },
      { name: "ウィンク", label: "左眨眼" },
      { name: "ウィンク右", label: "右眨眼" },
      { name: "ｳｨﾝｸ２右", label: "双眼眨" },
      { name: "笑い", label: "笑眼" },
      { name: "笑い2", label: "笑眼2" },
      { name: "笑い2_1", label: "笑眼3" },
      { name: "笑い3", label: "笑眼4" },
      { name: "下", label: "向下看" },
      { name: "上", label: "向上看" },
      { name: "手前", label: "看近处" },
      { name: "手前2", label: "看近处2" },
      { name: "涙", label: "眼泪" },
      { name: "臉紅", label: "脸红" },
      { name: "汗顔", label: "汗颜" },
    ],
  },
  {
    title: "口",
    morphs: [
      { name: "あ", label: "啊" },
      { name: "い", label: "伊" },
      { name: "う", label: "呜" },
      { name: "え", label: "诶" },
      { name: "お", label: "哦" },
      { name: "ん", label: "嗯" },
      { name: "にやり", label: "歪嘴笑" },
      { name: "にやり２", label: "歪嘴笑2" },
      { name: "にやり３", label: "歪嘴笑3" },
      { name: "ワ", label: "哇" },
      { name: "ワ1", label: "哇1" },
      { name: "ワ2", label: "哇2" },
      { name: "∧", label: "三角嘴" },
      { name: "口", label: "嘴巴" },
      { name: "口角上げ", label: "嘴角上扬" },
      { name: "口角下げ", label: "嘴角下垂" },
      { name: "口角下げ2", label: "嘴角下垂2" },
      { name: "口上", label: "上唇" },
      { name: "口下", label: "下唇" },
      { name: "口横広げ", label: "嘴横向拉宽" },
      { name: "口横缩げ", label: "嘴横向缩窄" },
      { name: "口横缩げ2", label: "嘴横向缩窄2" },
      { name: "大口", label: "大张嘴" },
      { name: "い2", label: "伊2" },
      { name: "え2", label: "诶2" },
      { name: "え3", label: "诶3" },
      { name: "えー", label: "诶—" },
      { name: "お2", label: "哦2" },
      { name: "はぅ", label: "呼" },
      { name: "ムッ", label: "抿嘴" },
      { name: "怒った", label: "生气嘴" },
      { name: "怒った2", label: "生气嘴2" },
      { name: "痛み", label: "疼痛" },
      { name: "痛み2", label: "疼痛2" },
      { name: "痛み3", label: "疼痛3" },
      { name: "倒ω", label: "ω嘴" },
      { name: "心配する", label: "担心" },
      { name: "心配する2", label: "担心2" },
    ],
  },
  {
    title: "其他",
    morphs: [
      { name: "舌丸める↑", label: "舌头圆" },
      { name: "舌細める↑", label: "舌头细" },
      { name: "舌平める↑", label: "舌头平" },
      // 舌伸ばす 是 UV morph（type=2），不改变顶点位置，拖动无效，已移除
      // 舌头伸出由骨骼（舌0~舌6）控制，需要骨骼控制面板，暂不支持
      { name: "汗", label: "汗滴" },
      { name: "怒", label: "怒符号" },
      { name: "！", label: "感叹号" },
      { name: "？", label: "问号" },
      { name: "！！", label: "双感叹号" },
      { name: "111", label: "符号1" },
      { name: "1111", label: "符号2" },
      { name: "11+", label: "符号3" },
    ],
  },
]

/** localStorage key for cached hidden materials set */
const HIDDEN_MATERIALS_STORAGE_KEY = "reze:hidden-materials"

/** 读取缓存的隐藏材质列表（SSR 安全：服务端返回空集合） */
function loadHiddenMaterials(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = window.localStorage.getItem(HIDDEN_MATERIALS_STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((v): v is string => typeof v === "string"))
  } catch {
    return new Set()
  }
}

/** 写入隐藏材质列表到 localStorage（SSR 安全） */
function saveHiddenMaterials(set: Set<string>): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(HIDDEN_MATERIALS_STORAGE_KEY, JSON.stringify(Array.from(set)))
  } catch {
    // 忽略写入失败（隐私模式/配额）
  }
}

/** localStorage key for cached expression morph weights */
const EXPRESSION_WEIGHTS_STORAGE_KEY = "reze:expression-weights"

/** 读取缓存的表情权重（SSR 安全：服务端返回空对象） */
function loadExpressionWeights(): Record<string, number> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(EXPRESSION_WEIGHTS_STORAGE_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw) as unknown
    if (!obj || typeof obj !== "object") return {}
    const result: Record<string, number> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "number") result[k] = v
    }
    return result
  } catch {
    return {}
  }
}

/** 写入表情权重到 localStorage（SSR 安全） */
function saveExpressionWeights(weights: Record<string, number>): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(EXPRESSION_WEIGHTS_STORAGE_KEY, JSON.stringify(weights))
  } catch {
    // 忽略写入失败
  }
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const modelsRef = useRef<Model[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<EngineStats | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [progress, setProgress] = useState<AnimationProgress>({
    current: 0,
    duration: 0,
    percentage: 0,
    animationName: null,
    looping: false,
    playing: false,
    paused: false,
  })
  const [materials, setMaterials] = useState<string[]>([])
  // lazy init：从 localStorage 恢复用户上次的选择
  const [hiddenMaterials, setHiddenMaterials] = useState<Set<string>>(() => loadHiddenMaterials())
  const [partsPanelOpen, setPartsPanelOpen] = useState(false)
  // 表情权重：morph name → 0~1
  const [expressionWeights, setExpressionWeights] = useState<Record<string, number>>(() => loadExpressionWeights())
  const [expressionPanelOpen, setExpressionPanelOpen] = useState(false)
  const seekResetRafRef = useRef<number | null>(null)

  // Sync progress from model (current/duration in seconds, name)
  useEffect(() => {
    let rafId: number | null = null

    const updateProgress = () => {
      const primary = modelsRef.current[0]
      if (primary && isPlaying && !isPaused) {
        const prog: AnimationProgress = primary.getAnimationProgress()
        setProgress({
          current: prog.current,
          duration: prog.duration,
          percentage: prog.percentage,
          animationName: prog.animationName ?? null,
          looping: prog.looping,
          playing: prog.playing,
          paused: prog.paused,
        })
        setIsPlaying(prog.playing)
        setIsPaused(prog.paused)
        if (prog.playing) rafId = requestAnimationFrame(updateProgress)
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
    const audio = new Audio("/audios/One More Last Time.wav")
    audio.preload = "auto"
    audio.setAttribute("playsinline", "true")
    audio.setAttribute("webkit-playsinline", "true")
    audio.volume = 1.0
    audio.muted = false

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

  const handlePlay = useCallback(() => {
    const models = modelsRef.current
    if (!engineRef.current || models.length === 0) return
    const prog = models[0].getAnimationProgress()
    if (prog.paused) {
      if (audioRef.current) {
        audioRef.current.muted = false
        audioRef.current.volume = 1.0
        audioRef.current.play().catch(() => {})
      }
      for (const m of models) m.play()

      setIsPlaying(true)
      setIsPaused(false)
      return
    }
    if (prog.playing) return
    if (audioRef.current) {
      audioRef.current.muted = false
      audioRef.current.volume = 1.0
      const atEnd = prog.duration > 0 && prog.current >= prog.duration - 1e-3
      audioRef.current.currentTime = atEnd ? 0 : prog.current
      audioRef.current.play().catch(() => {})
    }
    const atEnd = prog.duration > 0 && prog.current >= prog.duration - 1e-3
    if (atEnd) for (const m of models) m.seek(0)
    for (const m of models) m.play()

    setIsPlaying(true)
    setIsPaused(false)
  }, [])

  const handlePause = useCallback(() => {
    if (engineRef.current) {
      for (const m of modelsRef.current) m.pause()
      if (audioRef.current) {
        audioRef.current.pause()
      }
      setIsPaused(true)
    }
  }, [])

  const handleResume = useCallback(() => {
    if (engineRef.current) {
      if (audioRef.current) {
        audioRef.current.play().catch(() => {})
      }
      for (const m of modelsRef.current) m.play()
      modelsRef.current[0]?.setMorphWeight("抗穿模", 0.5)
      setIsPaused(false)
    }
  }, [])

  const handleSeek = useCallback(
    (value: number[]) => {
      if (engineRef.current && progress.duration > 0) {
        const seekTime = (value[0] / 100) * progress.duration
        for (const m of modelsRef.current) m.seek(seekTime)
        if (audioRef.current) {
          audioRef.current.currentTime = seekTime
        }
        setProgress((p) => ({
          ...p,
          current: seekTime,
          percentage: value[0],
        }))

        // Same pattern as init: wait a RAF so the seeked pose is applied,
        // then reset physics so hair/skirt don't stretch from the old pose.
        // Cancel any pending reset so slider drags debounce to the last value.
        if (seekResetRafRef.current !== null) cancelAnimationFrame(seekResetRafRef.current)
        seekResetRafRef.current = requestAnimationFrame(() => {
          seekResetRafRef.current = null
          engineRef.current?.resetPhysics()
        })
      }
    },
    [progress.duration],
  )

  const toggleMaterial = useCallback((name: string) => {
    const engine = engineRef.current
    if (!engine) return
    const next = new Set(hiddenMaterials)
    const willShow = next.has(name)
    if (willShow) next.delete(name)
    else next.add(name)
    setHiddenMaterials(next)
    saveHiddenMaterials(next)
    engine.setMaterialVisible(SCENE_MODELS[0].id, name, willShow)

    // 联动形态键：配饰类材质的几何凸起由形态键控制
    const morphNames = MATERIAL_MORPH_LINK[name]
    if (morphNames) {
      const model = modelsRef.current[0]
      const w = willShow ? 1 : 0
      for (const morphName of morphNames) {
        model?.setMorphWeight(morphName, w)
      }
    }
  }, [hiddenMaterials])

  /** 拖动表情滑块：更新权重 state、引擎、缓存 */
  const handleExpressionChange = useCallback((morphName: string, value: number) => {
    setExpressionWeights((prev) => {
      const next = { ...prev, [morphName]: value }
      saveExpressionWeights(next)
      return next
    })
    modelsRef.current[0]?.setMorphWeight(morphName, value)
  }, [])

  /** 重置所有表情为 0 */
  const resetAllExpressions = useCallback(() => {
    const model = modelsRef.current[0]
    for (const group of EXPRESSION_GROUPS) {
      for (const { name } of group.morphs) {
        model?.setMorphWeight(name, 0)
      }
    }
    setExpressionWeights({})
    saveExpressionWeights({})
  }, [])

  const initEngine = useCallback(async () => {
    if (!canvasRef.current) {
      setLoading(false)
      return
    }
    try {
      const engine = new Engine(canvasRef.current, {
        camera: { distance: 31.5, target: new Vec3(0, 11.5, 0) },
        bloom: { enabled: false },
        sun: { strength: 5.0, direction: new Vec3(-0.296, -0.500, 0.814) },
        world: { color: new Vec3(0.05, 0.05, 0.05), strength: 1.0 },
        view: { exposure: 0.0 },
      })
      engineRef.current = engine
      ;(window as any).__engine = engine
      await engine.init()

      const m1 = await engine.loadModel(SCENE_MODELS[0].id, "/models/风堇/model.pmx")

      modelsRef.current = [m1]

      const matNames = m1.getMaterials().map((mat) => mat.name)
      setMaterials(matNames)
      // 应用缓存的隐藏状态到引擎（UI 状态已由 lazy init 恢复）
      const cachedHidden = loadHiddenMaterials()
      // 过滤掉已不存在的材质名（模型可能变更）
      const validHidden = new Set<string>()
      for (const name of cachedHidden) {
        if (matNames.includes(name)) {
          validHidden.add(name)
          engine.setMaterialVisible(SCENE_MODELS[0].id, name, false)
        }
      }
      if (validHidden.size !== cachedHidden.size) {
        // 有失效条目，更新缓存
        setHiddenMaterials(validHidden)
        saveHiddenMaterials(validHidden)
      }

      engine.setMaterialPresets(SCENE_MODELS[0].id, {
        sr_face: ["颜", "颜+"],
        sr_hair: ["髪", "髪1"],
        sr_body: ["身体", "手臂", "指甲", "脖子"],
        sr_clothes: [
          "内衣", "吊带", "项圈", "项圈环",
          "衣1", "衣2", "衣金属", "衣饰",
          "袖", "袖口", "袖金属", "袖饰",
          "裙", "裙1",
          "帽子", "帽球", "帽结", "帽金属",
          "披肩", "披风", "披风金属",
          "头饰", "蝴蝶结", "蝴蝶结+", "结花边",
          "鞋子", "鞋饰", "领结", "领金属",
          "挂金属", "背金属", "足金属",
          "眼罩", "眼罩金属",
          "发圈", "铃铛", "表",
          "乳贴", "乳钉", "乳首结",
          "口枷金属1", "口枷金属2", "口球", "口球带1", "口球带2", "口球扣",
          "结花边+",  // 回退：texture有alpha镂空，depthBias会导致白色填充
          // 经 MCP 核对：Blender 中"金属"使用 StarRailShader.clothes-by@小二今天吃啥啊 节点组
          // （与衣金属/袖金属等使用的 星铁@Minyu-Shader.clothes.001 结构完全相同）
          // 非 Principled BSDF + Voronoi，故归入 sr_clothes 而非 metal 预设
          "金属",
        ],
        sr_clothes_inner: [
          "衣1+", "袖+", "裙+", "裙1+",
          "帽结+", "头饰+",
          "披肩+", "披风+",
        ],
        sr_eye: ["目", "目光", "白目", "眉睫", "舌", "齿", "口"],
        // 丝袜材质：使用 SockAIO.021 移植的 sr_stocking shader
        sr_stocking: ["白裤袜", "吊带袜_丝袜", "胖次_丝袜", "吊帶襪"],
        // 贴花材质：纹理 alpha 镂空（淫纹纹身贴花）
        // 颜+ 不放这里——它走 sr_face（manifest 已配置完整 NPR 贴图）
        decal: ["inmon1", "inmon2"],
        // 袖球：MMDTexUV sphere mapping + desaturation（经 MCP 核对 Blender 节点树）
        sr_special: ["袖球"],
      })

      // engine.addGround()

      // await m1.loadVmd(SCENE_MODELS[0].clip, "/animations/dance.vmd")

      engine.runRenderLoop(() => setStats(engine.getStats()))

      await new Promise((resolve) => requestAnimationFrame(resolve))

      m1.show(SCENE_MODELS[0].clip)

      // 必须在 show() 之后设置联动形态键：show() 内部会调用 resetAllMorphs()
      // 把所有形态键权重清零。权重依据当前可见性状态（已从缓存恢复）：
      // 可见的联动材质 → 权重 1；隐藏的 → 权重 0
      for (const linkName of Object.keys(MATERIAL_MORPH_LINK)) {
        if (matNames.includes(linkName)) {
          const visible = !validHidden.has(linkName)
          const w = visible ? 1 : 0
          for (const morphName of MATERIAL_MORPH_LINK[linkName]) {
            m1.setMorphWeight(morphName, w)
          }
        }
      }

      // 恢复缓存的表情权重（同样必须在 show() 之后，否则会被 resetAllMorphs 清零）
      const cachedExpr = loadExpressionWeights()
      for (const [morphName, weight] of Object.entries(cachedExpr)) {
        if (weight > 0) m1.setMorphWeight(morphName, weight)
      }

      await new Promise((resolve) => requestAnimationFrame(resolve))

      engine.resetPhysics()

      const prog: AnimationProgress = m1.getAnimationProgress()
      setProgress({
        current: prog.current,
        duration: prog.duration,
        percentage: prog.percentage,
        animationName: prog.animationName ?? null,
        looping: prog.looping,
        playing: prog.playing,
        paused: prog.paused,
      })
      setEngineError(null)
    } catch (error) {
      setEngineError(error instanceof Error ? error.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void initEngine()

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code !== "Space" && e.key !== " ") return
      e.preventDefault()
      if (isPlaying && !isPaused) handlePause()
      else if (isPaused) handleResume()
      else handlePlay()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
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

      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full touch-none pointer-events-auto z-1" />

      {!loading && !engineError && (
        <div className="absolute bottom-4 left-4 right-4 z-[60] pointer-events-auto">
          <div className="max-w-4xl mx-auto px-2 pr-4 bg-black/30 backdrop-blur-xs rounded-full outline-none pointer-events-auto">
            <div className="flex items-center gap-3">
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

              <div className="text-white text-sm font-mono tabular-nums flex items-center gap-2">
                {formatTime(progress.current)}
                {progress.looping && (
                  <span className="text-[10px] uppercase tracking-wide text-emerald-400/90">loop</span>
                )}
              </div>

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

              <div className="text-muted-foreground text-sm font-mono tabular-nums text-right">
                {formatRemainingTime(progress.current, progress.duration)}
              </div>
            </div>
          </div>
        </div>
      )}

      {!loading && !engineError && materials.length > 0 && (
        <div className="absolute top-16 right-4 bottom-4 z-[60] pointer-events-auto flex flex-col gap-2 w-56">
          {/* 部件显示 */}
          <div className="bg-black/40 backdrop-blur-xs rounded-lg overflow-hidden flex flex-col shrink-0">
            <button
              onClick={() => setPartsPanelOpen((v) => !v)}
              className="px-3 py-2 text-white text-sm font-medium hover:bg-white/10 transition-colors text-left flex items-center justify-between"
            >
              <span>部件显示</span>
              <span className="text-xs opacity-70">{partsPanelOpen ? "收起" : "展开"}</span>
            </button>
            {partsPanelOpen && (
              <div className="overflow-y-auto px-3 py-2 space-y-1 max-h-[40vh]">
                {materials.map((name) => {
                  const visible = !hiddenMaterials.has(name)
                  return (
                    <label
                      key={name}
                      className="flex items-center gap-2 text-white/90 text-xs hover:bg-white/10 px-1 py-1 rounded cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={visible}
                        onChange={() => toggleMaterial(name)}
                        className="accent-emerald-500"
                      />
                      <span className="truncate">{name}</span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>

          {/* 表情控制 */}
          <div className="bg-black/40 backdrop-blur-xs rounded-lg overflow-hidden flex flex-col flex-1 min-h-0">
            <button
              onClick={() => setExpressionPanelOpen((v) => !v)}
              className="px-3 py-2 text-white text-sm font-medium hover:bg-white/10 transition-colors text-left flex items-center justify-between shrink-0"
            >
              <span>表情控制</span>
              <span className="text-xs opacity-70">{expressionPanelOpen ? "收起" : "展开"}</span>
            </button>
            {expressionPanelOpen && (
              <div className="overflow-y-auto px-3 py-2 space-y-3 flex-1 min-h-0">
                <button
                  onClick={resetAllExpressions}
                  className="w-full px-2 py-1 text-xs text-white/80 bg-white/10 hover:bg-white/20 rounded transition-colors"
                >
                  全部重置
                </button>
                {EXPRESSION_GROUPS.map((group) => (
                  <div key={group.title} className="space-y-1.5">
                    <div className="text-[11px] text-emerald-400/80 font-semibold uppercase tracking-wide">{group.title}</div>
                    {group.morphs.map(({ name, label }) => {
                      const val = expressionWeights[name] ?? 0
                      return (
                        <div key={name} className="space-y-0.5">
                          <div className="flex items-center justify-between text-white/80 text-[11px]">
                            <span>{label}</span>
                            <span className="font-mono tabular-nums opacity-60">{Math.round(val * 100)}</span>
                          </div>
                          <Slider
                            value={[val * 100]}
                            onValueChange={(v) => handleExpressionChange(name, v[0] / 100)}
                            min={0}
                            max={100}
                            step={1}
                            className="w-full"
                          />
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
