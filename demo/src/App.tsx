import { useMemo, useState } from 'react'

type Equipment =
  | '自重'
  | 'ダンベル'
  | 'ヨガマット'
  | 'ラック'
  | 'バーベル'
  | 'ケーブル'
  | 'マシン'

type Place = 'home' | 'gym'

type Step = 'place' | 'gym' | 'homeEquip' | 'time' | 'result'

type Gym = {
  id: string
  name: string
  address: string
  equipment: Equipment[]
}

type Exercise = {
  id: string
  name: string
  needs: Equipment[]
  sets: string
  note: string
}

const INITIAL_GYMS: Gym[] = [
  {
    id: 'g1',
    name: 'コミュニティジム 中央',
    address: '東京都千代田区（デモ）',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', 'マシン', 'ヨガマット'],
  },
  {
    id: 'g2',
    name: '24h フィット 北',
    address: '東京都北区（デモ）',
    equipment: ['マシン', 'ダンベル', 'ヨガマット'],
  },
  {
    id: 'g3',
    name: 'パワー倉庫 湾岸',
    address: '神奈川県（デモ）',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', '自重'],
  },
]

const EXERCISES: Exercise[] = [
  {
    id: 'e1',
    name: 'スクワット（自重）',
    needs: ['自重'],
    sets: '3×12〜15',
    note: '可動域は無理なく。膝はつま先と同じ向きに。',
  },
  {
    id: 'e2',
    name: 'プッシュアップ',
    needs: ['自重'],
    sets: '3×8〜12',
    note: '体幹をまっすぐに。膝つきでも可。',
  },
  {
    id: 'e3',
    name: 'ルーマニアン・デッドリフト',
    needs: ['バーベル', 'ラック'],
    sets: '3×8',
    note: '背中はニュートラル。下背に違和感があれば中止。',
  },
  {
    id: 'e4',
    name: 'ゴブレット・スクワット',
    needs: ['ダンベル'],
    sets: '3×10',
    note: '肘は内股に落とし、胸は張る。',
  },
  {
    id: 'e5',
    name: 'ラットプルダウン（ケーブル）',
    needs: ['ケーブル'],
    sets: '3×10〜12',
    note: '肩甲骨を下げてから引くイメージ。',
  },
  {
    id: 'e6',
    name: 'レッグプレス',
    needs: ['マシン'],
    sets: '3×12',
    note: '腰をシートから浮かさない。',
  },
  {
    id: 'e7',
    name: 'ブルガリアン・スプリット・スクワット',
    needs: ['ダンベル', 'ヨガマット'],
    sets: '各脚 3×8',
    note: '前脚の膝はつま先より大きく前に出さない。',
  },
  {
    id: 'e8',
    name: 'プランク',
    needs: ['ヨガマット'],
    sets: '3×30〜45秒',
    note: '腰を落とさない。息は止めない。',
  },
]

const ALL_EQUIPMENT: Equipment[] = [
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

function pickExercises(available: Set<Equipment>, minutes: number): Exercise[] {
  const ok = EXERCISES.filter((e) => canDo(e, available))
  const cap = minutes <= 25 ? 3 : minutes <= 45 ? 5 : 7
  return ok.slice(0, cap)
}

function uid(): string {
  return `id-${Math.random().toString(36).slice(2, 9)}`
}

export default function App() {
  const [step, setStep] = useState<Step>('place')
  const [place, setPlace] = useState<Place | null>(null)
  const [gyms, setGyms] = useState<Gym[]>(INITIAL_GYMS)
  const [gymQuery, setGymQuery] = useState('')
  const [selectedGym, setSelectedGym] = useState<Gym | null>(null)
  const [showRegister, setShowRegister] = useState(false)
  const [newGymName, setNewGymName] = useState('')
  const [newGymEquip, setNewGymEquip] = useState<Equipment[]>(['自重', 'ダンベル'])
  const [homeEquip, setHomeEquip] = useState<Equipment[]>(['自重', 'ヨガマット'])
  const [minutes, setMinutes] = useState(40)

  const filteredGyms = useMemo(() => {
    const q = gymQuery.trim().toLowerCase()
    if (!q) return gyms
    return gyms.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        g.address.toLowerCase().includes(q),
    )
  }, [gymQuery, gyms])

  const availableEquipment = useMemo(() => {
    const s = new Set<Equipment>()
    if (place === 'gym' && selectedGym) {
      selectedGym.equipment.forEach((e) => s.add(e))
      s.add('自重')
      return s
    }
    if (place === 'home') {
      homeEquip.forEach((e) => s.add(e))
      if (!homeEquip.includes('自重')) s.add('自重')
      return s
    }
    return s
  }, [place, selectedGym, homeEquip])

  const menu = useMemo(
    () => pickExercises(availableEquipment, minutes),
    [availableEquipment, minutes],
  )

  function reset() {
    setStep('place')
    setPlace(null)
    setGymQuery('')
    setSelectedGym(null)
    setShowRegister(false)
    setNewGymName('')
    setNewGymEquip(['自重', 'ダンベル'])
    setHomeEquip(['自重', 'ヨガマット'])
    setMinutes(40)
  }

  function goPlace(p: Place) {
    setPlace(p)
    if (p === 'gym') {
      setStep('gym')
    } else {
      setStep('homeEquip')
    }
  }

  function registerGym() {
    const name = newGymName.trim() || 'マイジム（未命名）'
    const g: Gym = {
      id: uid(),
      name,
      address: '登録（デモ）',
      equipment: [...new Set(newGymEquip)],
    }
    setGyms((prev) => [g, ...prev])
    setSelectedGym(g)
    setShowRegister(false)
    setNewGymName('')
    setStep('time')
  }

  function toggleHome(eq: Equipment) {
    setHomeEquip((prev) =>
      prev.includes(eq) ? prev.filter((x) => x !== eq) : [...prev, eq],
    )
  }

  function toggleNewGym(eq: Equipment) {
    setNewGymEquip((prev) =>
      prev.includes(eq) ? prev.filter((x) => x !== eq) : [...prev, eq],
    )
  }

  return (
    <div className="shell">
      <header className="top">
        <div>
          <p className="eyebrow">ベスト筋トレ · デモ</p>
          <h1>今日のメニュー</h1>
          <p className="sub">
            条件を選ぶと、このデモでは簡易的にメニューを絞り込みます（本番アプリの仮UI）。
          </p>
        </div>
        <button type="button" className="ghost" onClick={reset}>
          最初から
        </button>
      </header>

      <main className="card">
        {step === 'place' && (
          <section className="panel">
            <h2>どこでやる？</h2>
            <div className="grid2">
              <button type="button" className="big" onClick={() => goPlace('home')}>
                自宅
              </button>
              <button type="button" className="big primary" onClick={() => goPlace('gym')}>
                ジム
              </button>
            </div>
          </section>
        )}

        {step === 'gym' && (
          <section className="panel">
            <h2>ジムを選ぶ</h2>
            <label className="field">
              <span>店舗を検索</span>
              <input
                value={gymQuery}
                onChange={(e) => setGymQuery(e.target.value)}
                placeholder="名前・エリア（デモデータ）"
                autoComplete="off"
              />
            </label>
            <ul className="list">
              {filteredGyms.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    className="row"
                    onClick={() => {
                      setSelectedGym(g)
                      setStep('time')
                    }}
                  >
                    <span className="row-title">{g.name}</span>
                    <span className="row-meta">{g.address}</span>
                    <span className="tags">
                      {g.equipment.slice(0, 4).map((t) => (
                        <span key={t} className="tag">
                          {t}
                        </span>
                      ))}
                      {g.equipment.length > 4 ? (
                        <span className="tag muted">+{g.equipment.length - 4}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="linkish"
              onClick={() => setShowRegister((v) => !v)}
            >
              {showRegister ? '登録フォームを閉じる' : '店舗を登録（デモ）'}
            </button>
            {showRegister && (
              <div className="register">
                <label className="field">
                  <span>店舗名</span>
                  <input
                    value={newGymName}
                    onChange={(e) => setNewGymName(e.target.value)}
                    placeholder="例: 街のスポーツジム"
                  />
                </label>
                <p className="hint">使える器具（デモではチェックしたものが店舗データになります）</p>
                <div className="chips">
                  {ALL_EQUIPMENT.map((eq) => (
                    <label key={eq} className="chip">
                      <input
                        type="checkbox"
                        checked={newGymEquip.includes(eq)}
                        onChange={() => toggleNewGym(eq)}
                      />
                      {eq}
                    </label>
                  ))}
                </div>
                <button type="button" className="primary full" onClick={registerGym}>
                  登録して次へ
                </button>
              </div>
            )}
            <button type="button" className="ghost full mt" onClick={() => setStep('place')}>
              戻る
            </button>
          </section>
        )}

        {step === 'homeEquip' && (
          <section className="panel">
            <h2>自宅で使えるもの</h2>
            <p className="hint">デモ用のチェックです。選んだ器具だけがメニュー条件に入ります。</p>
            <div className="chips">
              {(['自重', 'ダンベル', 'ヨガマット'] as const).map((eq) => (
                <label key={eq} className="chip">
                  <input
                    type="checkbox"
                    checked={homeEquip.includes(eq)}
                    onChange={() => toggleHome(eq)}
                  />
                  {eq}
                </label>
              ))}
            </div>
            <button
              type="button"
              className="primary full"
              onClick={() => setStep('time')}
            >
              次へ
            </button>
            <button type="button" className="ghost full mt" onClick={() => setStep('place')}>
              戻る
            </button>
          </section>
        )}

        {step === 'time' && (
          <section className="panel">
            <h2>使える時間</h2>
            <div className="segment">
              {[20, 40, 60].map((m) => (
                <button
                  key={m}
                  type="button"
                  className={minutes === m ? 'seg active' : 'seg'}
                  onClick={() => setMinutes(m)}
                >
                  約{m}分
                </button>
              ))}
            </div>
            <button type="button" className="primary full" onClick={() => setStep('result')}>
              メニューを見る
            </button>
            <button
              type="button"
              className="ghost full mt"
              onClick={() => setStep(place === 'gym' ? 'gym' : 'homeEquip')}
            >
              戻る
            </button>
          </section>
        )}

        {step === 'result' && (
          <section className="panel">
            <h2>今日の提案</h2>
            <div className="summary">
              <p>
                <strong>場所:</strong> {place === 'gym' ? 'ジム' : '自宅'}
                {selectedGym ? ` · ${selectedGym.name}` : ''}
              </p>
              <p>
                <strong>時間:</strong> 約{minutes}分
              </p>
              <p>
                <strong>器具（利用可能）:</strong>{' '}
                {[...availableEquipment].join('、') || '—'}
              </p>
            </div>
            {menu.length === 0 ? (
              <p className="empty">
                条件に合う種目がありません（デモデータが少ないため）。器具を増やすか、別の店舗を試してください。
              </p>
            ) : (
              <ol className="menu">
                {menu.map((ex, i) => (
                  <li key={ex.id}>
                    <span className="idx">{i + 1}</span>
                    <div>
                      <p className="ex-name">{ex.name}</p>
                      <p className="ex-meta">
                        {ex.sets} · 必要: {ex.needs.join('、')}
                      </p>
                      <p className="ex-note">{ex.note}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <p className="disclaimer">
              医療アドバイスではありません。痛みが出たら中止し、必要なら専門家に相談してください。
            </p>
            <button type="button" className="primary full" onClick={reset}>
              条件を変える
            </button>
          </section>
        )}
      </main>

      <footer className="foot">best-kintore / デモUI · ローカル検証用</footer>
    </div>
  )
}
