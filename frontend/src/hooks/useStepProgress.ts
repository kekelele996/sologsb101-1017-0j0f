/**
 * 工序进度派生 hook
 * 统计某作品的工序完成度与当前道次，返回响应式进度，被工序页与退火页消费。
 *
 * 顺序不变式：工序必须按 seq 依次推进，「已完成」恒为序列的严格前缀。
 * - 推进某道时，前面所有道必须已完成，否则阻断；
 * - 拖拽 / 编辑改动顺序或状态后按前缀归一化，被甩到未完成工序之后的已完成工序退回「未开始」；
 * - 只有全部道次形成已完成前缀（即全部完成）才放行退火排位。
 */
import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'
import { liveQuery } from 'dexie'
import type { Step, StepState } from '../types/step'
import { db, initDatabase } from '../utils/db'

/** 工序进度派生结果 */
export interface StepProgress {
  pieceId: string
  /** 工序总数 */
  total: number
  /** 已完成道数（已完成严格前缀长度） */
  done: number
  /** 进行中道数 */
  inProgress: number
  /** 未开始道数 */
  pending: number
  /** 完成度（0–100，按道次计） */
  pct: number
  /** 当前道次序号（第一个未完成的工序） */
  currentSeq: number
  /** 当前道次名称 */
  currentName: string
  /** 是否所有工序均已完成（可进入退火排位） */
  allDone: boolean
  /** 阻断原因；可进入退火时为空串 */
  blockReason: string
  /** 累计工时（分钟） */
  totalMinutes: number
}

/** 空进度，用于作品不存在或尚无工序时兜底，避免页面白屏 */
export function emptyProgress(pieceId: string): StepProgress {
  return {
    pieceId,
    total: 0,
    done: 0,
    inProgress: 0,
    pending: 0,
    pct: 0,
    currentSeq: 0,
    currentName: '',
    allDone: false,
    blockReason: '尚未登记任何吹制工序',
    totalMinutes: 0,
  }
}

/** 取某作品按序号升序排列的工序列表 */
export function sortedStepsOf(pieceId: string, steps: Step[]): Step[] {
  return steps
    .filter((row) => row.pieceId === pieceId)
    .slice()
    .sort((a, b) => a.seq - b.seq)
}

/**
 * 顺序推进校验：要把 list[targetIndex] 推进到下一状态时，
 * 其前面的所有工序必须均为「已完成」。
 * 返回 null 表示放行；否则返回需要阻断在的道次描述。
 */
export function describeStepBlock(list: Step[], targetIndex: number): Step | null {
  return list.slice(0, targetIndex).find((row) => row.state !== '已完成') ?? null
}

/** 纯函数：由工序列表派生进度（完成度只认已完成前缀） */
export function buildStepProgress(pieceId: string, steps: Step[]): StepProgress {
  const list = sortedStepsOf(pieceId, steps)

  if (list.length === 0) return emptyProgress(pieceId)

  // 已完成前缀长度：遇到第一道非已完成即截止，其后即便标了已完成也不计入
  let prefixDone = 0
  while (prefixDone < list.length && list[prefixDone].state === '已完成') prefixDone += 1

  const inProgress = list.filter((row) => row.state === '进行中').length
  const pending = list.filter((row) => row.state === '未开始').length
  const allDone = prefixDone === list.length
  const current = allDone ? null : list[prefixDone]

  // 存在未完成道次即阻断退火排位，并指明停在第几道
  let blockReason = ''
  if (!allDone) {
    blockReason = `停在第 ${current?.seq ?? list.length} 道「${current?.name ?? '未命名'}」（当前状态：${
      current?.state ?? '未开始'
    }），需按顺序先完成前 ${current?.seq ?? list.length} 道工序`
  }

  return {
    pieceId,
    total: list.length,
    done: prefixDone,
    inProgress,
    pending,
    pct: Math.round((prefixDone / list.length) * 1000) / 10,
    currentSeq: current === null ? list.length : current.seq,
    currentName: current === null ? '全部工序已完成' : current.name,
    allDone,
    blockReason,
    totalMinutes: Math.round(list.reduce((acc, row) => acc + row.durationMin, 0) * 10) / 10,
  }
}

/**
 * 纯函数：按「已完成必须是严格前缀」的不变式归一化新顺序。
 * 已完成工序一旦被拖到任一未完成工序之后，就退回「未开始」等待重新确认；
 * 未完成（未开始 / 进行中）道次的状态原样保留——进行中是在制记录，不计入完成度也不会放行退火。
 * 返回归一化后每道工序的状态；与入参同序。
 */
export function normalizeOrderedStates(ordered: Step[]): StepState[] {
  const firstUnfinished = ordered.findIndex((row) => row.state !== '已完成')
  if (firstUnfinished < 0) return ordered.map(() => '已完成' as StepState)
  return ordered.map((row, index) =>
    index >= firstUnfinished && row.state === '已完成' ? ('未开始' as StepState) : row.state
  )
}

export interface UseStepProgressResult {
  progress: ComputedRef<StepProgress>
  steps: Ref<Step[]>
  loading: Ref<boolean>
  error: Ref<string>
}

/**
 * 订阅全部工序记录并派生指定作品的工序进度。
 * pieceId 为 null 时返回空进度，调用方可据此渲染友好空态。
 */
export function useStepProgress(pieceId: Ref<string | null> | string | null): UseStepProgressResult {
  const idRef = computed<string | null>(() => (typeof pieceId === 'string' || pieceId === null ? pieceId : pieceId.value))

  const steps = ref<Step[]>([])
  const loading = ref(true)
  const error = ref('')

  void initDatabase()
  const subscription = liveQuery(async () => {
    await initDatabase()
    return db.steps.toArray()
  }).subscribe({
    next: (list) => {
      steps.value = list
      loading.value = false
      error.value = ''
    },
    error: (err: unknown) => {
      error.value = err instanceof Error ? err.message : '读取工序数据失败'
      loading.value = false
    },
  })

  onScopeDispose(() => {
    subscription.unsubscribe()
  })

  const progress = computed<StepProgress>(() => {
    const id = idRef.value
    if (id === null || id === '') return emptyProgress('')
    return buildStepProgress(id, steps.value)
  })

  return { progress, steps, loading, error }
}
