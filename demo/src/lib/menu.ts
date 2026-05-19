import type { Equipment } from '../types/gym'

export type BodyState = 'good' | 'normal' | 'easy'

export type Exercise = {
  id: string
  name: string
  needs: Equipment[]
  sets: string
  note: string
  /** 「無理せず」モードで提案してよい種目 */
  easyOk: boolean
}

export const BODY_STATE_LABEL: Record<BodyState, string> = {
  good: '調子がいい',
  normal: 'ふつう',
  easy: '無理せず（回復寄り）',
}

export const EXERCISES: Exercise[] = [
  {
    id: 'e1',
    name: 'スクワット（自重）',
    needs: ['自重'],
    sets: '3×12〜15',
    note: '可動域は無理なく。膝はつま先と同じ向きに。',
    easyOk: true,
  },
  {
    id: 'e2',
    name: 'プッシュアップ',
    needs: ['自重'],
    sets: '3×8〜12',
    note: '体幹をまっすぐに。膝つきでも可。',
    easyOk: true,
  },
  {
    id: 'e3',
    name: 'ルーマニアン・デッドリフト',
    needs: ['バーベル', 'ラック'],
    sets: '3×8',
    note: '背中はニュートラル。下背に違和感があれば中止。',
    easyOk: false,
  },
  {
    id: 'e4',
    name: 'ゴブレット・スクワット',
    needs: ['ダンベル'],
    sets: '3×10',
    note: '肘は内股に落とし、胸は張る。',
    easyOk: false,
  },
  {
    id: 'e5',
    name: 'ラットプルダウン（ケーブル）',
    needs: ['ケーブル'],
    sets: '3×10〜12',
    note: '肩甲骨を下げてから引くイメージ。',
    easyOk: false,
  },
  {
    id: 'e6',
    name: 'レッグプレス',
    needs: ['マシン'],
    sets: '3×12',
    note: '腰をシートから浮かさない。',
    easyOk: false,
  },
  {
    id: 'e7',
    name: 'ブルガリアン・スプリット・スクワット',
    needs: ['ダンベル', 'ヨガマット'],
    sets: '各脚 3×8',
    note: '前脚の膝はつま先より大きく前に出さない。',
    easyOk: false,
  },
  {
    id: 'e8',
    name: 'プランク',
    needs: ['ヨガマット'],
    sets: '3×30〜45秒',
    note: '腰を落とさない。息は止めない。',
    easyOk: true,
  },
]

export const ALL_EQUIPMENT: Equipment[] = [
  '自重',
  'ダンベル',
  'ヨガマット',
  'ラック',
  'バーベル',
  'ケーブル',
  'マシン',
]

function canDo(ex: Exercise, available: Set<Equipment>): boolean {
  return ex.needs.every((n) => available.has(n))
}

export function pickExercises(
  available: Set<Equipment>,
  minutes: number,
  body: BodyState,
): Exercise[] {
  let ok = EXERCISES.filter((e) => canDo(e, available))
  if (body === 'easy') {
    ok = ok.filter((e) => e.easyOk)
  }

  let cap = minutes <= 25 ? 3 : minutes <= 45 ? 5 : 7
  if (body === 'easy') cap = Math.min(cap, 4)
  if (body === 'good') cap = Math.min(cap + 1, ok.length)

  return ok.slice(0, cap)
}
