import { useMemo, useState } from 'react'
import { JEXER_INITIAL_GYMS, JEXER_STORE_COUNT } from './data/jexerStores'
import {
  ALL_EQUIPMENT,
  BODY_STATE_LABEL,
  pickExercises,
  type BodyState,
} from './lib/menu'
import type { Equipment, Gym } from './types/gym'

type Place = 'home' | 'gym'

type Step = 'place' | 'gym' | 'homeEquip' | 'body' | 'time' | 'result'

/** 初期ジムはジェクサー系47件（FIT Search 掲載件数に合わせた公開住所ベース）。器具はデモ推定。 */
const INITIAL_GYMS: Gym[] = JEXER_INITIAL_GYMS

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
  const [bodyState, setBodyState] = useState<BodyState>('normal')
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
    () => pickExercises(availableEquipment, minutes, bodyState),
    [availableEquipment, minutes, bodyState],
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
    setBodyState('normal')
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
    setStep('body')
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
            初期のジム一覧はジェクサー（Jexer）系{JEXER_STORE_COUNT}
            件の公開住所ベースです。メニュー用の器具タグはデモ推定で、実機・施設区分（テニス・キッズ等）とは一致しません。
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
                      setStep('body')
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
              {ALL_EQUIPMENT.map((eq) => (
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
              onClick={() => setStep('body')}
            >
              次へ
            </button>
            <button type="button" className="ghost full mt" onClick={() => setStep('place')}>
              戻る
            </button>
          </section>
        )}

        {step === 'body' && (
          <section className="panel">
            <h2>今日の体の状態</h2>
            <p className="hint">
              「無理せず」では負荷の低い種目だけを提案します（健康・長く続くことを優先）。
            </p>
            <div className="segment col">
              {(Object.keys(BODY_STATE_LABEL) as BodyState[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={bodyState === key ? 'seg active full' : 'seg full'}
                  onClick={() => setBodyState(key)}
                >
                  {BODY_STATE_LABEL[key]}
                </button>
              ))}
            </div>
            <button type="button" className="primary full" onClick={() => setStep('time')}>
              次へ
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
            <button type="button" className="ghost full mt" onClick={() => setStep('body')}>
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
                <strong>体の状態:</strong> {BODY_STATE_LABEL[bodyState]}
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
                条件に合う種目がありません。器具を増やす・別の店舗を試す・体の状態を「ふつう」に変えるなどを試してください。
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
