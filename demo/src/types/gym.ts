export type Equipment =
  | '自重'
  | 'ダンベル'
  | 'ヨガマット'
  | 'ラック'
  | 'バーベル'
  | 'ケーブル'
  | 'マシン'

export type Gym = {
  id: string
  name: string
  address: string
  equipment: Equipment[]
}
