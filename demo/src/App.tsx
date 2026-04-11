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

/** 店舗名・住所は各社公式サイト等の公開情報に基づく。器具リストはデモ用の代表例で、各店の実機・導線と一致しない場合があります。 */
const INITIAL_GYMS: Gym[] = [
  {
    id: 'g1',
    name: 'ゴールドジム 東中野東京',
    address: '〒164-0003 東京都中野区東中野5-1-1 ユニゾンモール 2F',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', 'マシン', 'ヨガマット'],
  },
  {
    id: 'g2',
    name: 'ゴールドジム 渋谷東京',
    address: '〒150-0002 東京都渋谷区渋谷1-23-16 cocoti 9F・10F・11F',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', 'マシン', 'ヨガマット'],
  },
  {
    id: 'g3',
    name: 'エニタイムフィットネス 横浜西口店',
    address: '〒220-0004 神奈川県横浜市西区北幸2-10-36',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', 'マシン', 'ヨガマット'],
  },
  {
    id: 'g4',
    name: 'エニタイムフィットネス 三軒茶屋店',
    address: '〒154-0024 東京都世田谷区三軒茶屋1-36-10 シンシアビル 1〜3F',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', 'マシン', 'ヨガマット'],
  },
  {
    id: 'g5',
    name: 'エニタイムフィットネス 新宿靖国通り店',
    address: '〒160-0022 東京都新宿区新宿1-33-10 グランカーサ新宿御苑 2F',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', 'マシン', 'ヨガマット'],
  },
  {
    id: 'g6',
    name: 'JOYFIT24 南与野',
    address: '〒338-0011 埼玉県さいたま市中央区新中里2-2-7 リーゼングラート 1F',
    equipment: ['マシン', 'ダンベル', 'ヨガマット', '自重'],
  },
  {
    id: 'g7',
    name: 'カーブス 吉祥寺',
    address: '〒180-0003 東京都武蔵野市吉祥寺南町2-6-10 富士パームビル 2F',
    equipment: ['マシン', 'ヨガマット', '自重'],
  },
  {
    id: 'g8',
    name: 'コナミスポーツクラブ 梅田茶屋町',
    address: '〒530-0012 大阪府大阪市北区芝田1-8-1 DDハウス 4F',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', 'マシン', 'ヨガマット'],
  },
  {
    id: 'g9',
    name: 'コナミスポーツクラブ 大阪ステーションシティ',
    address:
      '〒530-0001 大阪府大阪市北区梅田3-1-3 大阪ステーションシティ ノースゲートビル 11〜13F（入口:11F）',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', 'マシン', 'ヨガマット'],
  },
  {
    id: 'g10',
    name: 'スポーツクラブNAS 西船橋',
    address: '〒273-0025 千葉県船橋市印内町640',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', 'マシン', 'ヨガマット'],
  },
  {
    id: 'g11',
    name: 'FASTGYM24 要町店',
    address: '〒171-0043 東京都豊島区要町1-11-1 センチュリービル 2階',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'マシン', 'ヨガマット', '自重'],
  },
  {
    id: 'g12',
    name: 'セントラルスポーツジム24 三番町',
    address: '〒102-0075 東京都千代田区三番町1 三番町ホテルビル 2階',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', 'マシン', 'ヨガマット'],
  },
  {
    id: 'g13',
    name: 'ティップネス 三軒茶屋店',
    address: '〒154-0004 東京都世田谷区太子堂2-15-4',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', 'マシン', 'ヨガマット'],
  },
  {
    id: 'g14',
    name: 'CHICKEN GYM（チキンジム）札幌店',
    address: '〒060-0806 北海道札幌市北区北6条西1-4-2 ファーストプラザビル 1F',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', '自重'],
  },
  {
    id: 'g15',
    name: 'スポーツクラブ ルネサンス 両国24',
    address: '〒130-0026 東京都墨田区両国2-10-14',
    equipment: ['ラック', 'バーベル', 'ダンベル', 'ケーブル', 'マシン', 'ヨガマット'],
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
            条件を選ぶとメニューを簡易的に絞り込みます。店名・住所は公開情報ベースですが、器具はデモ用の代表例です（各店の実機と一致しません）。
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
